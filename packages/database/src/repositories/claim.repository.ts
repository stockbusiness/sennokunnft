import type {
  ClaimConfirmOutcome,
  ClaimDeliveryEnqueue,
  ClaimLookupResult,
  ClaimRepositoryPort,
  EntitlementStatus,
  ReissuableEntitlement,
  WalletDeliveryStatus,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * Claim（OVEW Wallet 連携）の永続化。
 *
 * ⚠️ **「読んでから書く」の隙間を条件付き UPDATE で塞ぐ。**
 * 状態を読んで `issued` だと確かめてから UPDATE すると、そのあいだに
 * 別の要求が同じ判定を通る。同時に 2 本届けば 2 本とも確定してしまう。
 * `WHERE status = 'issued'` を付けて**更新できた件数で決める**。
 */
export class PrismaClaimRepository implements ClaimRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Claim トークンのハッシュから受取権を引く。
   *
   * ⚠️ 平文のトークンは保存していない。呼び出し元がハッシュ化してから渡す。
   */
  async findByTokenHash(claimTokenHash: string): Promise<ClaimLookupResult | null> {
    const row = await this.prisma.entitlement.findUnique({
      where: { claimTokenHash },
      select: CLAIM_LOOKUP_SELECT,
    });
    return row === null ? null : toClaimLookup(row);
  }

  /**
   * 自動配送の対象を拾う（P0-2）。
   *
   * ⚠️ **受取用のウォレットが結び付いている方の分だけ。** `RESOLVED` 以外は
   * 拾わない——値が入っていても本人だと確定していない状態（`CONFLICT` など）が
   * あり、そこへ送ると名寄せ途中の別人へ届く。
   *
   * ⚠️ **古い受取権から。** 待たせている方を先に片づける。
   */
  async listAutoDeliverable(limit: number): Promise<ClaimLookupResult[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: {
        status: 'issued',
        purchaser: { commonUserStatus: 'RESOLVED', commonUserId: { not: null } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    const found: ClaimLookupResult[] = [];
    for (const row of rows) {
      const detail = await this.findForAutoDelivery(row.id);
      if (detail !== null) {
        found.push(detail);
      }
    }
    return found;
  }

  /** 受取権IDから、自動配送に要る材料を引く（P0-2）。 */
  async findForAutoDelivery(entitlementId: string): Promise<ClaimLookupResult | null> {
    // ⚠️ 引き方だけを変え、材料は `findByTokenHash` と同じものを返す。
    //    自動の経路だけ材料が減ると、人が受け取ったときと違う本文が渡る。
    const row = await this.prisma.entitlement.findUnique({
      where: { id: entitlementId },
      select: CLAIM_LOOKUP_SELECT,
    });
    return row === null ? null : toClaimLookup(row);
  }

  /**
   * 受取を確定し、同時に配送待ち行列へ載せる。
   *
   * `WHERE status = 'issued'` を条件に含めるため、**同時に何本来ても
   * 確定できるのは 1 本だけ**になる。競合した側は `raced` を受け取り、
   * 呼び出し元が読み直して現在の状態を返す。
   *
   * ⚠️ **確定と行列への追加を同一トランザクションで行う。**
   * 確定したあとに別呼び出しで INSERT すると、そのあいだに落ちた行が
   * 「受け取ったのに Wallet へ永遠に届かない」まま、誰にも気づかれず残る。
   * 逆順（先に行列へ入れる）にすると、確定に負けた側の行が
   * 送られてしまう。順序ではなく、**同じトランザクションに入れる**ことで塞ぐ。
   */
  async confirmClaim(input: {
    readonly entitlementId: string;
    readonly commonUserId: string;
    readonly accountId: string;
    readonly now: Date;
    readonly delivery?: ClaimDeliveryEnqueue | undefined;
  }): Promise<ClaimConfirmOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.entitlement.updateMany({
        where: { id: input.entitlementId, status: 'issued' },
        data: {
          status: 'claimed',
          claimedByAccountId: input.accountId,
          claimedByCommonUserId: input.commonUserId,
          claimedAt: input.now,
          // 送信そのものは配送ワーカーが行う。ここでは行列に載せるだけ。
          walletDeliveryStatus: 'pending',
        },
      });
      if (updated.count !== 1) {
        // 競合して負けた。**行列へは何も入れない。**
        return { kind: 'raced' };
      }

      if (input.delivery !== undefined) {
        await tx.walletDeliveryOutbox.create({
          data: {
            eventId: input.delivery.eventId,
            eventType: input.delivery.eventType,
            entitlementId: input.entitlementId,
            targetSiteKey: input.delivery.targetSiteKey,
            payload: input.delivery.payload,
            payloadHash: input.delivery.payloadHash,
            correlationId: input.delivery.correlationId,
            nextRetryAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
      }
      return { kind: 'claimed' };
    });
  }

  /** 再発行の判定に必要な情報だけを引く。 */
  async findForReissue(entitlementId: string): Promise<ReissuableEntitlement | null> {
    const row = await this.prisma.entitlement.findUnique({
      where: { id: entitlementId },
      select: { id: true, accountId: true, status: true, expiresAt: true, claimTokenHash: true },
    });
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      accountId: row.accountId,
      status: row.status,
      expiresAt: row.expiresAt,
    };
  }

  /** 判定時に見えていたハッシュ。差し替えの条件に使う。 */
  async currentTokenHash(entitlementId: string): Promise<string | null> {
    const row = await this.prisma.entitlement.findUnique({
      where: { id: entitlementId },
      select: { claimTokenHash: true },
    });
    return row?.claimTokenHash ?? null;
  }

  /**
   * 受取トークンを差し替える。
   *
   * ⚠️ **現在のハッシュを条件に含める。**
   * 同時に 2 本の再発行が走ると、保存できるハッシュは 1 つだけなので、
   * 負けた側のトークンは**作られた瞬間から無効**になる。
   * それを「発行できました」と返すと、利用者は使えない URL を渡される。
   * 条件付き UPDATE の更新行数で、書けた側だけが成功を名乗る。
   *
   * ⚠️ `status = 'issued'` も条件に含める。受取済みのものを差し替えると、
   * 一度受け取ったあとにもう一度受け取れる経路ができる。
   */
  async rotateClaimToken(input: {
    readonly entitlementId: string;
    readonly accountId: string;
    readonly expectedTokenHash: string;
    readonly newTokenHash: string;
    readonly now: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.entitlement.updateMany({
      where: {
        id: input.entitlementId,
        // 本人以外の要求はここまで来ないが、DB でも条件にしておく。
        // 判定と書き込みが別の場所にあるとき、条件は両方に置く。
        accountId: input.accountId,
        status: 'issued',
        claimTokenHash: input.expectedTokenHash,
      },
      data: { claimTokenHash: input.newTokenHash, updatedAt: input.now },
    });
    return updated.count === 1;
  }
}

/**
 * 受取権を引くときに読む列。
 *
 * ⚠️ **受取トークンから引くときも、受取権IDから引くときも同じものを読む。**
 * 引き方ごとに列を選び直すと、片方だけ材料が欠けたときに気づけない——
 * Wallet へ渡る本文が、人が受け取ったときと機械が届けたときで変わる。
 */
const CLAIM_LOOKUP_SELECT = {
  id: true,
  status: true,
  expiresAt: true,
  accountId: true,
  claimedByCommonUserId: true,
  walletDeliveryStatus: true,
  orderId: true,
  orderLineId: true,
  artworkId: true,
  serialNo: true,
  artwork: {
    select: { title: true, description: true, imageKey: true, imageHash: true },
  },
  purchaser: { select: { commonUserId: true, commonUserStatus: true } },
} as const;

type ClaimLookupRow = {
  readonly id: string;
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly accountId: string;
  readonly claimedByCommonUserId: string | null;
  readonly walletDeliveryStatus: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly artworkId: string;
  readonly serialNo: number;
  readonly artwork: {
    readonly title: string;
    readonly description: string;
    readonly imageKey: string | null;
    readonly imageHash: string | null;
  };
  readonly purchaser: {
    readonly commonUserId: string | null;
    readonly commonUserStatus: string;
  };
};

function toClaimLookup(row: ClaimLookupRow): ClaimLookupResult {
  /*
    ⚠️ **`RESOLVED` 以外の `common_user_id` を本人照合に使わない。**
       `CONFLICT` の行にも値は入っている（運用で確認するための手がかり）。
       値があることと、本人だと確定していることは別。ここを緩めると、
       名寄せ候補が残ったままの方あてに受取先が決まる。
  */
  const purchaserCommonUserId =
    row.purchaser.commonUserStatus === 'RESOLVED' ? row.purchaser.commonUserId : null;

  return {
    entitlement: {
      id: row.id,
      status: row.status as EntitlementStatus,
      deliveryStatus: row.walletDeliveryStatus as WalletDeliveryStatus,
      expiresAt: row.expiresAt,
      purchaserCommonUserId,
      claimedByCommonUserId: row.claimedByCommonUserId,
    },
    purchaserAccountId: row.accountId,
    cardName: row.artwork.title,
    // 表示情報は受取確定の時点で読む。配送のたびに読み直さない（§24）。
    snapshot: {
      orderId: row.orderId,
      orderLineId: row.orderLineId,
      artworkId: row.artworkId,
      serialNo: row.serialNo,
      artworkTitle: row.artwork.title,
      artworkDescription: row.artwork.description,
      imageKey: row.artwork.imageKey,
      imageHash: row.artwork.imageHash,
    },
  };
}
