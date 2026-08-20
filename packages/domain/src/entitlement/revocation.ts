import { isCommonUserId } from '../identity/common-user';
import { isWalletCorrelationId } from '../wallet-delivery/event';
import type { EntitlementStatus } from '../state/machines';

/**
 * 全額返金にともなう受取権の取り消し（`UD-104` 追補・2026-08-20 決定）。
 *
 * ⚠️ **ここは時計を持たない。** 取消イベントの `occurred_at` は返金の
 * `settled_at` を使う。呼び出しのたびに現在時刻を入れると、同じ受取権の
 * 取消でも本文が変わり、**正常な重複が「本文の食い違い」として検知される**。
 *
 * ⚠️ **ここは DB を知らない。** 判定に要る材料はすべて引数で受け取る。
 */

/**
 * 取消イベントの識別子の接頭辞。
 *
 * `evt_` は付与イベントが使っているため、取消は `evt_rvk_` で分ける。
 * 一覧を眺めたときに、種別が識別子だけで分かる。
 */
export const REVOCATION_EVENT_ID_PREFIX = 'evt_rvk_';

/**
 * 取消イベントの識別子を**受取権IDから決定的に**作る。
 *
 * ⚠️ **乱数を使わない。** この値は相手の `Idempotency-Key` であり、
 * こちらの Outbox の UNIQUE キーでもある。呼び出しのたびに変わると、
 * 重複した Webhook や並行実行で**同じ取消が 2 通**送られる。
 *
 * ⚠️ **`revoked` が終端であることに依存している。** 1 つの受取権は
 * 一度しか取り消されないので、受取権IDだけで一意に決まる。
 * 将来「再有効化してもう一度取り消す」仕様を入れるなら、
 * ここへ返金IDまたは版数を混ぜる設計変更が要る（今回は入れない）。
 */
export function revocationEventId(entitlementId: string): string {
  return `${REVOCATION_EVENT_ID_PREFIX}${entitlementId}`;
}

/**
 * 相関IDが取れなかったときの決定的な値。
 *
 * ⚠️ **乱数にしない。** 同じ返金を再実行しても同じ値になる必要がある。
 * 注文IDを基にすることで、1 回の返金で取り消した全件が同じ値になり、
 * 「この返金でどれを取り消したか」を後から辿れる。
 */
export function fallbackRevocationCorrelationId(orderId: string): string {
  return `ord-${orderId}`;
}

/**
 * 全額返金で取り消してよい状態。
 *
 * `issued`（未受取）は従来から取消の対象。`claimed`（受取済み）は
 * 2026-08-20 の決定で対象に加わったが、段階導入のためフラグで切り替える。
 *
 * ⚠️ **`expired` を含めない。** 期限切れは取消とは別の終わり方で、
 * 上書きすると「なぜ使えないのか」が記録から失われる。
 */
export function revocableEntitlementStatuses(revokeClaimed: boolean): readonly EntitlementStatus[] {
  return revokeClaimed ? ['issued', 'claimed'] : ['issued'];
}

/** 取消の宛先を決めるための材料。すべて記録から取る。 */
export interface RevocationTarget {
  readonly entitlementId: string;
  readonly orderId: string;
  /**
   * その受取権に対する `entitlement.granted` の Outbox 行があるか。
   *
   * ⚠️ **状態は問わない。** `PENDING` / `PROCESSING` / `FAILED` / `DEAD` /
   * `DELIVERED` のいずれでも真とする。相手は現在または将来この受取権を
   * 知る可能性があり、知る側だけに取消が届かない状態を作らないため。
   */
  readonly hasGrantedEvent: boolean;
  /**
   * 付与イベントの本文に入れた `common_user_id`。
   *
   * ⚠️ **これが正。** 「相手へ実際に伝えた値」だからである。
   * 列を先に見ると、万一マスタと送信内容が食い違っていた場合に
   * **相手が知らない別人の Holding を消しにいく**。
   */
  readonly grantedCommonUserId: string | null;
  /** 受取権の列。付与イベントから取れないときの控え。 */
  readonly claimedCommonUserId: string | null;
  /** 付与イベントの相関ID。購入から取消までを 1 本の糸で辿るために引き継ぐ。 */
  readonly grantedCorrelationId: string | null;
}

/** 取消したあと、Wallet へ何を送るか。 */
export type RevocationDecision =
  /**
   * 取り消すだけ。**Wallet へは送らない。**
   *
   * 付与イベントを一度も作っていない＝相手はこの受取権を知らない。
   * 知らないものの取消を送ると、相手には「知らないIDの取消」が届き続ける。
   */
  | { readonly kind: 'revoke_only' }
  /** 取り消して、Wallet へ取消を送る。 */
  | {
      readonly kind: 'revoke_and_notify';
      readonly eventId: string;
      readonly commonUserId: string;
      readonly correlationId: string;
    }
  /**
   * 取り消すが、宛先が決められない。**人の確認へ回す。**
   *
   * ⚠️ **推測で誰かに送らない。** 宛先を間違えると、無関係な人の
   * Holding が消える。取り返しがつかない側へ倒さない。
   */
  | { readonly kind: 'needs_review'; readonly reason: RevocationReviewReason };

/** 人の確認へ回す理由。⚠️ 自由記述にしない。 */
export const REVOCATION_REVIEW_REASONS = [
  /** 付与は送ったのに、宛先の共通顧客IDが記録から取れない。 */
  'recipient_unresolved',
] as const;
export type RevocationReviewReason = (typeof REVOCATION_REVIEW_REASONS)[number];

/**
 * 取消の宛先を決める。
 *
 * 判定の軸は **「付与イベントの行があるか」ひとつ**。
 * 受取権の状態でも配送状態でもない——相手が知っているかどうかだけが、
 * 取消を送るべきかを決める。
 */
export function decideRevocation(target: RevocationTarget): RevocationDecision {
  if (!target.hasGrantedEvent) {
    return { kind: 'revoke_only' };
  }

  const commonUserId = firstCommonUserId([target.grantedCommonUserId, target.claimedCommonUserId]);
  if (commonUserId === null) {
    return { kind: 'needs_review', reason: 'recipient_unresolved' };
  }

  return {
    kind: 'revoke_and_notify',
    eventId: revocationEventId(target.entitlementId),
    commonUserId,
    correlationId: resolveRevocationCorrelationId(target),
  };
}

/**
 * 相関IDを優先順位で決める。
 *
 * 1. 付与イベントの相関ID（購入から取消まで同じ糸で辿れる）
 * 2. 注文IDから決定的に作る
 *
 * ⚠️ **乱数を挟まない。** 再実行で値が変わると、本文が変わる。
 *
 * 📌 `entitlements` にも `orders` にも `correlation_id` 列が無いため、
 *    いまは 2 段しかない。`orders.correlation_id`（PR-M1 で追加予定）が
 *    入ったら、**候補をこの配列へ 1 つ足すだけ**で優先順位に加わる。
 */
function resolveRevocationCorrelationId(target: RevocationTarget): string {
  const candidates: readonly (string | null)[] = [target.grantedCorrelationId];
  for (const candidate of candidates) {
    if (candidate !== null && isWalletCorrelationId(candidate)) {
      return candidate;
    }
  }
  return fallbackRevocationCorrelationId(target.orderId);
}

function firstCommonUserId(candidates: readonly (string | null)[]): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && isCommonUserId(candidate)) {
      return candidate;
    }
  }
  return null;
}
