'use server';

import { revalidatePath } from 'next/cache';
import { resendWalletDeliveries, type AdminResult } from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import { resendOutcomeLabel } from '../../../src/delivery-copy';
import type { AdminActionState } from '../actions';

/**
 * お届けの送り直し（管理画面・外部連携 指示書 §20）。
 *
 * ⚠️ **ここは受け渡しだけを行う。判定はすべて API 側。**
 * 「お届け中のものは送り直せない」という規則を画面側にも書くと、
 * 2 か所に同じ規則ができて必ずずれる。
 *
 * ⚠️ **1 件ずつの結果を、そのまま言葉にする。** 「送り直しました」だけ
 * 返すと、戻せなかった行があっても押した人には分からない。
 */
function fail<T>(result: AdminResult<T>): AdminActionState {
  return { error: result.ok ? undefined : adminErrorMessage(result.reason, result.code) };
}

export async function resendDeliveriesAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const ids = form
    .getAll('deliveryId')
    .filter((value): value is string => typeof value === 'string' && value !== '');

  if (ids.length === 0) {
    return { error: '送り直すものを選んでください。' };
  }

  const result = await resendWalletDeliveries(ids);
  if (!result.ok) {
    return fail(result);
  }

  revalidatePath('/admin/wallet-deliveries');

  /*
    結果ごとに件数を数え、起きたことをすべて伝える。
    ⚠️ 「一部は送り直せなかった」を省かない。省くと、届かないまま待たれる。
  */
  const counts = new Map<string, number>();
  for (const item of result.data.results) {
    counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
  }
  const lines = [...counts.entries()]
    .map(([outcome, count]) => resendOutcomeLabel(outcome, count))
    .filter((line) => line !== '');

  const [first, ...rest] = lines;
  return { notice: first ?? '', noticeHint: rest.join(' ') };
}
