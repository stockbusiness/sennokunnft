'use server';

import { revalidatePath } from 'next/cache';
import {
  closePayoutPeriod,
  confirmPayout,
  markPayoutPaid,
  type AdminResult,
} from '../../../src/admin-client';
import { adminErrorMessage, type AdminFailureReason } from '../../../src/admin-copy';
import { PAYOUT_COPY } from '../../../src/payout-copy';
import type { AdminActionState } from '../actions';

/**
 * 精算の操作（`UD-119`）。
 *
 * ⚠️ **ここは受け渡しだけ。判定はすべて API 側。** 「締めを迎えているか」
 * 「返金の窓が閉じたか」を画面にも書くと、2 か所に同じ規則ができて必ず
 * ずれる。
 *
 * ⚠️ **金額を送らない。** 送る口が無いので送りようが無い——という状態を保つ。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function refresh(id?: string): void {
  revalidatePath('/admin/payouts');
  if (id !== undefined) {
    revalidatePath(`/admin/payouts/${id}`);
  }
}

/**
 * 断られたときの言葉。
 *
 * ⚠️ **`PAYOUT_WINDOW_OPEN` を「できません」で終わらせない。** 待てば通る。
 * いつ通るのかを伝えないと、運営は毎日押して確かめることになる。
 */
function payoutError<T>(result: AdminResult<T>): string {
  if (result.ok) {
    return '';
  }
  if (result.code === 'PAYOUT_WINDOW_OPEN') {
    return `${PAYOUT_COPY.windowOpenHint} 返金をお受けする期間が終わっていないご注文が残っています。`;
  }
  if (result.code === 'PAYOUT_PERIOD_NOT_CLOSED') {
    return 'その月はまだ締めを迎えていません。月が明けてからお試しください。';
  }
  if (result.code === 'PAYOUT_NOT_EDITABLE') {
    return 'この精算はすでに確定・お支払い済みのため、変更できません。';
  }
  if (result.code === 'SETTLEMENT_SETTINGS_INVALID') {
    return '返金と精算の取り決めが登録されていません。先に「返金と精算」の画面でご登録ください。';
  }
  if (result.reason === 'unauthorized') {
    return PAYOUT_COPY.errorUnauthorized;
  }
  return adminErrorMessage(result.reason as AdminFailureReason, result.code);
}

export async function closePayoutPeriodAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const periodKey = text(form, 'periodKey');
  if (periodKey === '') {
    return { error: `${PAYOUT_COPY.periodLabel}をご入力ください（例: 2026-08）。` };
  }

  const result = await closePayoutPeriod(periodKey);
  if (!result.ok) {
    return { error: payoutError(result) };
  }

  refresh();
  return { notice: PAYOUT_COPY.closed(result.data.items.length) };
}

export async function confirmPayoutAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'payoutId');
  const result = await confirmPayout(id);
  if (!result.ok) {
    return { error: payoutError(result) };
  }
  refresh(id);
  return { notice: PAYOUT_COPY.confirmed };
}

/**
 * お支払い済みとして記録する。
 *
 * ⚠️ **これは「振り込んだ」という宣言であって、振込そのものではない。**
 * 実際にお振込を済ませてから押す操作なので、合言葉の入力を挟む。
 * ⚠️ **これは保護ではない。** 判定は API 側（オーナー限定＋再認証）。
 */
export async function markPayoutPaidAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'payoutId');
  if (text(form, 'confirm') !== '振込済み') {
    return { error: '「振込済み」と入力されていないため、何もしていません。' };
  }

  const result = await markPayoutPaid(id);
  if (!result.ok) {
    return { error: payoutError(result) };
  }
  refresh(id);
  return { notice: PAYOUT_COPY.paid };
}
