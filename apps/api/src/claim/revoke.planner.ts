import { buildRevokedEvent, type RevocationPlan, type RevocationPlanInput } from '@sengoku/domain';
import type { ContentHasher } from '../common/content-hash';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 全額返金にともなう取消の本文を組み立てる（M3a）。
 *
 * 付与の `WalletDeliveryPlanner` と対になる。ただし性格が違う。
 *
 * ⚠️ **表示情報（`metadata`）を載せない。** 取り消しに必要なのは
 * 「どの受取権が無効になったか」だけである。作品名や画像を再送すると、
 * 相手がそれで Holding を書き換える余地が生まれる。
 *
 * ⚠️ **金額を載せない。** 返金額も報酬額も、相手の表示には要らない。
 * イベントは相手のログ・再送記録・障害調査を経由する。
 *
 * ⚠️ **時計を持たない。** `occurredAt` は返金の `settled_at` を受け取る。
 * ここで現在時刻を読むと、同じ受取権の取消でも呼び出しのたびに本文が変わり、
 * **正常な重複が「本文の食い違い」として検知される**。
 */
export class WalletRevokePlanner {
  constructor(private readonly hashContent: ContentHasher) {}

  /**
   * ⚠️ **`plan` は同期。** 返金のトランザクションの中から呼ばれるため、
   * ここで待つと注文の行ロックを握ったまま外部を待つことになる。
   */
  plan = (input: RevocationPlanInput): RevocationPlan => {
    const event = buildRevokedEvent({
      eventId: input.eventId,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      commonUserId: input.commonUserId,
      entitlementId: input.entitlementId,
      orderId: input.orderId,
      orderLineId: input.orderLineId,
      artworkId: input.artworkId,
      // いまは全額返金しか自動で取り消さない。語彙は固定（自由記述にしない）。
      reasonCode: 'full_refund',
    });
    if (!event.ok) {
      throw new DomainErrorException(event.error.code);
    }

    /*
      ⚠️ **ここで 1 回だけ文字列にする。**
         保存・ハッシュ・署名・送信のすべてがこの同じ文字列を使う。
         どこかで作り直すと、署名対象と送信内容がずれる。
    */
    const payload = JSON.stringify(event.value);

    return {
      eventId: event.value.event_id,
      payload,
      payloadHash: this.hashContent(payload),
      correlationId: input.correlationId,
    };
  };
}
