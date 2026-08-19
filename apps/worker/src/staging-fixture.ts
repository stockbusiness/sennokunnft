import {
  allocateSerialNumbers,
  reserveSupply,
  commitReservation,
  type ClaimTokenPort,
  type ClockPort,
} from '@sengoku/domain';
import type { PrismaClient } from '@sengoku/database';

/**
 * staging 動作確認用の受取権を作る（PR-NW04 §7・§8）。
 *
 * ⚠️ **`entitlements.order_id` を NULL 許容にしないための実装。**
 * 「注文の無い受取権」を作れるように列を緩めると、その穴は
 * **本番の経路にも開く**。しかも、あとから注文なしの行が紛れ込んでも
 * 誰も気づけない。ここでは本物の Order / OrderLine を作り、
 * `source = STAGING_FIXTURE` で出自だけを区別する。
 *
 * ⚠️ **決済を伴うものを一切作らない。**
 * `Payment` を作らない。決済済みを装わない。報酬も成果通知も発生させない。
 * Mint もしない。この関数が触るのは Order / OrderLine / Entitlement だけ。
 *
 * 実行可否の判定（本番拒否・フラグ必須）は呼び出し元が
 * `assertStagingFixtureAllowed` で行う。ここでは業務上の前提だけを見る。
 */

/**
 * Fixture が使う金額。
 *
 * ⚠️ 0 にできない（`listings_price_positive`）。本番の不変条件を
 * Fixture のために緩めないので、最小額を入れて通す。
 * 決済は行わないため、この金額が請求されることはない。
 */
const FIXTURE_PRICE_AMOUNT = 1;

export interface StagingFixtureInput {
  readonly accountId: string;
  readonly artworkId: string;
}

export interface StagingFixtureResult {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly entitlementId: string;
  readonly serialNumber: number;
  readonly claimUrl: string;
}

export interface StagingFixtureDeps {
  readonly prisma: PrismaClient;
  readonly tokens: ClaimTokenPort;
  readonly clock: ClockPort;
  /** 受取ページの前置き。末尾のスラッシュを含めない。 */
  readonly claimBaseUrl: string;
}

/** 前提が満たされていないことを伝える。⚠️ 入力値をそのまま載せない。 */
export class StagingFixtureError extends Error {
  public override readonly name = 'StagingFixtureError';
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export async function createStagingEntitlement(
  deps: StagingFixtureDeps,
  input: StagingFixtureInput,
): Promise<StagingFixtureResult> {
  const now = deps.clock.now();

  const account = await deps.prisma.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, commonUserStatus: true, commonUserId: true },
  });
  if (account === null) {
    throw new StagingFixtureError('account_not_found');
  }
  // ⚠️ 受取は `RESOLVED` でなければ通らない。Fixture でここを飛ばすと、
  //    「作れたのに受け取れない」データができ、原因の切り分けに時間を使う。
  if (account.commonUserStatus !== 'RESOLVED' || account.commonUserId === null) {
    throw new StagingFixtureError('common_user_not_resolved');
  }

  const artwork = await deps.prisma.artwork.findUnique({
    where: { id: input.artworkId },
    select: { id: true, title: true },
  });
  if (artwork === null) {
    throw new StagingFixtureError('artwork_not_found');
  }

  // 受取トークンは CSPRNG。**平文は保存せず**、ハッシュだけを入れる。
  const issued = deps.tokens.issue();

  return deps.prisma.$transaction(async (tx) => {
    // ⚠️ **作品行をロックしてから採番する。**
    //    ロックせずに issued_count を読むと、同時に走った 2 本が
    //    同じ番号を採り、片方が UNIQUE 制約で落ちる。
    //    （落ちるだけなら実害は小さいが、staging で「たまに失敗する」
    //      挙動は本番の不具合と見分けがつかない。）
    await tx.$queryRaw`SELECT id FROM "artworks" WHERE id = ${input.artworkId}::uuid FOR UPDATE`;

    const locked = await tx.artwork.findUniqueOrThrow({
      where: { id: input.artworkId },
      select: {
        maxSupply: true,
        reservedCount: true,
        issuedCount: true,
        title: true,
        creatorAccountId: true,
      },
    });

    // 在庫の判定は本番と同じドメイン関数を通す。
    // Fixture だけ別扱いにすると、上限を超えた行が staging にだけできる。
    const reserved = reserveSupply(locked, 1);
    if (!reserved.ok) {
      throw new StagingFixtureError('insufficient_supply');
    }
    const committed = commitReservation(reserved.value, 1);
    if (!committed.ok) {
      throw new StagingFixtureError('insufficient_supply');
    }
    const [serialNo] = allocateSerialNumbers(locked, 1);
    if (serialNo === undefined) {
      throw new StagingFixtureError('serial_allocation_failed');
    }

    await tx.artwork.update({
      where: { id: input.artworkId },
      data: { issuedCount: committed.value.issuedCount },
    });

    const order = await tx.order.create({
      data: {
        accountId: account.id,
        // ⚠️ 通常の購入の採番規則（SNK-…）と混ぜない。
        //    一覧で見たときに Fixture 由来だと目で分かるようにする。
        orderNumber: `FIXTURE-${issued.tokenHash.slice(0, 16).toUpperCase()}`,
        // ⚠️ `paid` にしない。決済していないものを決済済みと記録しない。
        status: 'pending',
        source: 'STAGING_FIXTURE',
        // 1 注文 1 クリエイター。作品の持ち主をそのまま写す。
        creatorAccountId: locked.creatorAccountId,
        subtotalAmount: FIXTURE_PRICE_AMOUNT,
        discountAmount: 0,
        totalAmount: FIXTURE_PRICE_AMOUNT,
        totalCurrency: 'JPY',
        // ⚠️ 手数料率は事業判断待ち（UD-109）。Fixture で仮の率を置くと
        //    「決まった値」に見えるため 0 のままにする。
        platformFeeRateBps: 0,
        platformFeeAmount: 0,
        creatorAmount: FIXTURE_PRICE_AMOUNT,
        // 出自が分かる形にする。通常の購入とキー空間で衝突しない。
        idempotencyKey: `staging-fixture-${issued.tokenHash.slice(0, 32)}`,
        createdAt: now,
        updatedAt: now,
      },
    });

    // `order_lines.listing_id` が NOT NULL なので、出品行も要る。
    //
    // ⚠️ **`draft` のまま置く。** 公開カタログに出るのは `active` の出品だけなので、
    //    staging 専用の行が一覧へ混ざらない。
    // ⚠️ **価格を 0 にしない。** `listings_price_positive` がそれを許さない。
    //    Fixture だけ制約を回避する道を作ると、本番の不変条件が
    //    「Fixture では成り立たないもの」に格下げされる。最小額を入れて通す。
    const listing = await tx.listing.create({
      data: {
        artworkId: input.artworkId,
        priceAmount: FIXTURE_PRICE_AMOUNT,
        priceCurrency: 'JPY',
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      },
    });

    const line = await tx.orderLine.create({
      data: {
        orderId: order.id,
        listingId: listing.id,
        artworkId: input.artworkId,
        artworkTitleSnapshot: locked.title,
        creatorAccountId: locked.creatorAccountId,
        unitPriceAmount: FIXTURE_PRICE_AMOUNT,
        unitPriceCurrency: 'JPY',
        quantity: 1,
        totalAmount: FIXTURE_PRICE_AMOUNT,
        createdAt: now,
      },
    });

    const entitlement = await tx.entitlement.create({
      data: {
        orderId: order.id,
        orderLineId: line.id,
        artworkId: input.artworkId,
        accountId: account.id,
        serialNo,
        claimTokenHash: issued.tokenHash,
        status: 'issued',
        createdAt: now,
        updatedAt: now,
      },
    });

    return {
      orderId: order.id,
      orderLineId: line.id,
      entitlementId: entitlement.id,
      serialNumber: serialNo,
      // ⚠️ 平文のトークンが載るのはここだけ。保存もログ出力もしない。
      claimUrl: `${deps.claimBaseUrl}/${issued.token}`,
    };
  });
}
