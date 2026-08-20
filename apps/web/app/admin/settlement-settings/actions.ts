'use server';

import { revalidatePath } from 'next/cache';
import { TRANSFER_FEE_BEARER_VALUES } from '@sengoku/contracts';
import { updateSettlementSettings } from '../../../src/admin-client';
import { SETTLEMENT_COPY, settlementError } from '../../../src/settlement-copy';
import type { AdminActionState } from '../actions';

/**
 * 返金と精算の取り決めを変える（`UD-104` / `UD-119`）。
 *
 * ⚠️ **ここは受け渡しだけ。判定はすべて API 側。** 「返金期間は精算の猶予を
 * 超えられない」を画面にも書くと、2 か所に同じ規則ができて必ずずれる。
 * 手前で止めるのは「数として読めない入力」だけにしてある——API へ `NaN` を
 * 送っても意味のある答えが返らないため。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 数の欄を読む。
 *
 * ⚠️ **空欄を `0` として扱わない。** 返金の日数では `0` が
 * 「受け付けない」という**正しい設定**なので、打ち忘れを `0` に丸めると
 * 「返金を受け付けない」へ黙って倒れる。
 */
function integer(form: FormData, name: string): number | null {
  const raw = text(form, name);
  if (raw === '') {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  // ⚠️ `parseInt` は "12abc" を 12 と読む。文字列ごと突き合わせて弾く。
  return String(value) === raw && Number.isSafeInteger(value) ? value : null;
}

export async function updateSettlementSettingsAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const refundWindowDays = integer(form, 'refundWindowDays');
  const payoutOffsetMonths = integer(form, 'payoutOffsetMonths');
  const minimumPayoutAmount = integer(form, 'minimumPayoutAmount');
  if (refundWindowDays === null || payoutOffsetMonths === null || minimumPayoutAmount === null) {
    return { error: '日数・月数・金額は、半角の数字でご入力ください。' };
  }

  const bearer = text(form, 'transferFeeBearer');
  if (!(TRANSFER_FEE_BEARER_VALUES as readonly string[]).includes(bearer)) {
    return { error: '振込手数料をどちらが負担するかをお選びください。' };
  }

  const result = await updateSettlementSettings({
    refundWindowDays,
    payoutOffsetMonths,
    minimumPayoutAmount,
    transferFeeBearer: bearer as (typeof TRANSFER_FEE_BEARER_VALUES)[number],
  });
  if (!result.ok) {
    return { error: settlementError(result.code, result.reason) };
  }

  revalidatePath('/admin/settlement-settings');
  return { notice: SETTLEMENT_COPY.saved, noticeHint: SETTLEMENT_COPY.savedHint };
}
