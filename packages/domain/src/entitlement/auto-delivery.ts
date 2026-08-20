import type { WalletClaimableEntitlement } from './wallet-claim';
import { evaluateWalletClaim } from './wallet-claim';

/**
 * Wallet への自動配送（P0-2）。
 *
 * **受取用のウォレットを登録済みの方には、こちらから届ける。** それまでは、
 * 買った方が受取URLを開いて Wallet から受け取りに来るのを待つ形だった。
 * 登録が済んでいるのに待たせるのは、こちらの都合でしかない。
 *
 * ⚠️ **判定は Claim と同じ関数（`evaluateWalletClaim`）を通す。** 自動の経路
 * だけ別の条件にすると、片方で止まるものがもう片方で通ってしまう。取り消し済み・
 * 期限切れ・受取済みの扱いは、人が来ようが機械が動こうが同じでなければならない。
 *
 * ⚠️ **「誰として受け取るか」を外から受け取らない。** 受取権に記録されている
 * 購入者ご本人の `common_user_id` だけを使う。引数で渡せる形にすると、
 * **他人の Wallet へ届ける道**がそこにできる。
 */

/** 自動配送してよいか。⚠️ 例外を投げない。1 件の異常で残りを止めないため。 */
export type AutoDeliveryDecision =
  /** 届けてよい。`commonUserId` は購入者ご本人のもの。 */
  | { readonly kind: 'proceed'; readonly commonUserId: string }
  /**
   * いまは届けない。
   *
   * - `wallet_not_registered` … 受取用のウォレットがまだ結び付いていない。
   *   ⚠️ **失敗ではない。** 登録が済めば、次の掃き出しが拾う。
   * - `already_delivered` … すでに受け取り済み。二度は送らない。
   * - `not_deliverable` … 取り消し済み・期限切れ。人の判断が要る。
   */
  | {
      readonly kind: 'skip';
      readonly reason: 'wallet_not_registered' | 'already_delivered' | 'not_deliverable';
    };

export function evaluateAutoDelivery(
  entitlement: WalletClaimableEntitlement,
  now: Date,
): AutoDeliveryDecision {
  const commonUserId = entitlement.purchaserCommonUserId;
  if (commonUserId === null) {
    /*
      ⚠️ **ここで止めるのが要。** 未登録の方に「代わりの相手」を選ぶ余地を
         作らない。空のまま先へ進めると、`evaluateWalletClaim` へ渡す値を
         どこかから借りてくることになる。
    */
    return { kind: 'skip', reason: 'wallet_not_registered' };
  }

  // ⚠️ 人が受け取りに来たときと同じ判定を通す。条件を二重に持たない。
  const decision = evaluateWalletClaim({
    entitlement,
    presentedCommonUserId: commonUserId,
    now,
  });

  if (!decision.ok) {
    // 取り消し済み・期限切れ。自動では動かず、人の判断へ回す。
    return { kind: 'skip', reason: 'not_deliverable' };
  }
  if (decision.value.kind === 'pending_common_user') {
    // 上で弾いているので通常は来ない。来たら未登録として扱う。
    return { kind: 'skip', reason: 'wallet_not_registered' };
  }
  if (decision.value.kind === 'already_claimed') {
    return { kind: 'skip', reason: 'already_delivered' };
  }

  return { kind: 'proceed', commonUserId };
}

/** 1 回の掃き出しで扱う受取権の数。⚠️ 大きくすると 1 件の失敗が巻き添えを増やす。 */
export const AUTO_DELIVERY_BATCH_SIZE = 20;
