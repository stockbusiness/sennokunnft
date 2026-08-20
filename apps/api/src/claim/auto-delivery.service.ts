import { Injectable, Logger } from '@nestjs/common';
import {
  AUTO_DELIVERY_BATCH_SIZE,
  evaluateAutoDelivery,
  type AuditLogPort,
  type ClaimLookupResult,
  type ClaimRepositoryPort,
  type ClockPort,
} from '@sengoku/domain';
import { currentRequestId } from '@sengoku/observability';
import type { WalletDeliveryPlanner } from './delivery.planner';

/** 掃き出しの結果。⚠️ 監視の数値として読まれる。人の情報を混ぜない。 */
export interface AutoDeliveryResult {
  readonly picked: number;
  readonly delivered: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * Wallet への自動配送（P0-2）。
 *
 * **受取用のウォレットを登録済みの方には、こちらから届ける。** それまでは、
 * 買った方が受取URLを開いて Wallet から受け取りに来るのを待つ形だった。
 * 登録が済んでいるのに待たせるのは、こちらの都合でしかない。
 *
 * ⚠️ **人が受け取りに来る経路（`ClaimService`）を消さない。** 未登録の方は
 * そちらで受け取る。両方を残すのは重複ではなく、**登録していない方を
 * 締め出さない**ためである。
 *
 * ⚠️ **「誰として受け取るか」を外から受け取らない。** 受取権に記録されて
 * いる購入者ご本人の `common_user_id` だけを使う。引数で渡せる形にすると、
 * 他人の Wallet へ届ける道がそこにできる。
 *
 * ⚠️ **登録が済むのを待たない。まだの方は次の掃き出しへ回す。** 共通顧客IDの
 * 解決は別のジョブが進めるので、済んだ時点で自然に拾われる——「登録完了を
 * 受けて配送を再開する」を、新しい合図を作らずに満たしている。
 */
@Injectable()
export class WalletAutoDeliveryService {
  private readonly logger = new Logger(WalletAutoDeliveryService.name);

  constructor(
    private readonly claims: ClaimRepositoryPort,
    private readonly planner: WalletDeliveryPlanner,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
  ) {}

  /**
   * 発行できた受取権を、その場で届けにいく。
   *
   * ⚠️ **例外を外へ出さない。** 呼び出し元は決済の Webhook で、そこで投げると
   * 事業者には「処理できなかった」と伝わり、同じ知らせが送り直される。
   * 決済も発行も済んでいるので、それは正しくない。
   */
  async runForEntitlements(entitlementIds: readonly string[]): Promise<AutoDeliveryResult> {
    let delivered = 0;
    let skipped = 0;
    let failed = 0;

    for (const entitlementId of entitlementIds) {
      try {
        const found = await this.claims.findForAutoDelivery(entitlementId);
        if (found === null) {
          failed += 1;
          continue;
        }
        const outcome = await this.deliver(found);
        if (outcome === 'delivered') delivered += 1;
        else if (outcome === 'skipped') skipped += 1;
        else failed += 1;
      } catch (error) {
        // ⚠️ 例外の本文はログへ。記録に残すのは短い符号だけ。
        this.logger.error({ entitlementId, err: error }, 'Wallet への自動配送に失敗しました');
        failed += 1;
      }
    }

    return { picked: entitlementIds.length, delivered, skipped, failed };
  }

  /**
   * 届けられる受取権を拾って回す（時計から呼ぶ）。
   *
   * ⚠️ **1 件の失敗で残りを止めない。** 1 つの壊れた受取権が、後ろに並んだ
   * 正常な受取権を巻き添えにする。
   */
  async sweep(limit: number = AUTO_DELIVERY_BATCH_SIZE): Promise<AutoDeliveryResult> {
    const pending = await this.claims.listAutoDeliverable(limit);

    let delivered = 0;
    let skipped = 0;
    let failed = 0;
    for (const found of pending) {
      try {
        const outcome = await this.deliver(found);
        if (outcome === 'delivered') delivered += 1;
        else if (outcome === 'skipped') skipped += 1;
        else failed += 1;
      } catch (error) {
        this.logger.error(
          { entitlementId: found.entitlement.id, err: error },
          'Wallet への自動配送に失敗しました',
        );
        failed += 1;
      }
    }
    return { picked: pending.length, delivered, skipped, failed };
  }

  private async deliver(found: ClaimLookupResult): Promise<'delivered' | 'skipped' | 'failed'> {
    const now = this.clock.now();
    const decision = evaluateAutoDelivery(found.entitlement, now);

    if (decision.kind === 'skip') {
      /*
        ⚠️ **「まだ登録していない」を失敗として数えない。** 数えると、
           登録前の方が居るだけで監視が赤くなり、本当の異常が埋もれる。
      */
      return 'skipped';
    }

    /*
      ⚠️ **本文の組み立ては確定の前に済ませる。** 組み立てに失敗する材料
         （画像が無い等）で確定だけ通すと、受取済みなのに配送されない行が残る。
    */
    const plan = this.planner.plan({
      entitlementId: found.entitlement.id,
      commonUserId: decision.commonUserId,
      // 発行から配送まで同じ相関IDで追える。
      correlationId: currentRequestId() ?? found.entitlement.id,
      snapshot: found.snapshot,
      now,
    });

    const outcome = await this.claims.confirmClaim({
      entitlementId: found.entitlement.id,
      commonUserId: decision.commonUserId,
      accountId: found.purchaserAccountId,
      now,
      delivery: plan,
    });

    if (outcome.kind === 'raced') {
      /*
        ⚠️ **競合は失敗ではない。** 判定から書き込みまでの隙間で、ご本人が
           Wallet から受け取りに来た（あるいは別の掃き出しが確定させた）。
           どちらにせよ受取権は届いている。
      */
      return 'skipped';
    }

    await this.audit.record({
      actorAccountId: null,
      action: 'entitlement.auto_delivered',
      targetType: 'entitlement',
      targetId: found.entitlement.id,
      /*
        ⚠️ **`common_user_id` を残さない。** 監査ログは調べるためのもので、
           外部の識別子を人へ結び付けた名簿にしない。受取権IDから辿れる。
      */
      summary: { orderId: found.snapshot.orderId },
    });

    return 'delivered';
  }
}
