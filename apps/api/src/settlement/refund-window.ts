import {
  refundableUntil,
  type IntegrationEnvironment,
  type SettlementSettingsRepository,
} from '@sengoku/domain';

/**
 * 決済確定の時点で、返金を受け付ける期限を決める（`UD-104`）。
 *
 * ⚠️ **決済が確定する瞬間にだけ呼ぶ。** ここで出した値は注文へ焼き付ける。
 * 返金の判定のたびに呼び直すと、設定を変えた瞬間に過去の注文の期限が動き、
 * 精算済みの注文が「まだ返金できる」に化ける
 * （`docs/SETTLEMENT_AND_REFUND.md` §0）。
 *
 * ⚠️ **設定が無ければ `null`。既定値を作らない。** 期限の付かない注文は
 * ご購入者さま都合の返金が通らなくなるが、**誰も決めていない日数を
 * こちらで決めて焼き付けるより良い**。焼き付けた値はもう直せない。
 *
 * ⚠️ **決済そのものを止めない。** 取り決めが未登録でも注文は成立させる。
 * ここで例外にすると、設定の入れ忘れが「お支払いが通らない」として
 * ご購入者さまに出る。
 *
 * 実体を関数として切り出してあるのは、**起動時の組み立てと試験で
 * 同じ規則を使うため**。片方に写すと、いつか片方だけが直る。
 */
export function createRefundWindowResolver(
  repository: SettlementSettingsRepository,
  environment: IntegrationEnvironment,
): (paidAt: Date) => Promise<Date | null> {
  return async (paidAt: Date): Promise<Date | null> => {
    const settings = await repository.find(environment);
    return settings === null ? null : refundableUntil(paidAt, settings.refundWindowDays);
  };
}
