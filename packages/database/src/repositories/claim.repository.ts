import type {
  ClaimConfirmOutcome,
  ClaimLookupResult,
  ClaimRepositoryPort,
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
      select: {
        id: true,
        status: true,
        expiresAt: true,
        accountId: true,
        claimedByCommonUserId: true,
        walletDeliveryStatus: true,
        artwork: { select: { title: true } },
        purchaser: { select: { commonUserId: true, commonUserStatus: true } },
      },
    });
    if (row === null) {
      return null;
    }

    // ⚠️ **RESOLVED 以外の common_user_id を本人照合に使わない。**
    // CONFLICT の行にも値は入っている（運用で確認するための手がかり）。
    // 値があることと、本人だと確定していることは別。ここを緩めると、
    // 名寄せ候補が残ったままの人あてに受取先が決まる。
    const purchaserCommonUserId =
      row.purchaser.commonUserStatus === 'RESOLVED' ? row.purchaser.commonUserId : null;

    return {
      entitlement: {
        id: row.id,
        status: row.status,
        deliveryStatus: row.walletDeliveryStatus as WalletDeliveryStatus,
        expiresAt: row.expiresAt,
        purchaserCommonUserId,
        claimedByCommonUserId: row.claimedByCommonUserId,
      },
      purchaserAccountId: row.accountId,
      cardName: row.artwork.title,
    };
  }

  /**
   * 受取を確定する。
   *
   * `WHERE status = 'issued'` を条件に含めるため、**同時に何本来ても
   * 確定できるのは 1 本だけ**になる。競合した側は `raced` を受け取り、
   * 呼び出し元が読み直して現在の状態を返す。
   */
  async confirmClaim(input: {
    readonly entitlementId: string;
    readonly commonUserId: string;
    readonly accountId: string;
    readonly now: Date;
  }): Promise<ClaimConfirmOutcome> {
    const updated = await this.prisma.entitlement.updateMany({
      where: { id: input.entitlementId, status: 'issued' },
      data: {
        status: 'claimed',
        claimedByAccountId: input.accountId,
        claimedByCommonUserId: input.commonUserId,
        claimedAt: input.now,
        // 配送はここでは行わない（PR-NW04）。待ち行列に載せるだけ。
        walletDeliveryStatus: 'pending',
      },
    });
    return updated.count === 1 ? { kind: 'claimed' } : { kind: 'raced' };
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
