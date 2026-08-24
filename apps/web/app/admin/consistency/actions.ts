'use server';

import { revalidatePath } from 'next/cache';
import { repairReservedCount, resolveReservedCountRepair } from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import type { AdminActionState } from '../actions';

/**
 * 押さえのずれを直す（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）。
 *
 * ⚠️ **ここに判定を書かない。** 「直してよいか」「画面が古くないか」は
 * すべて API 側が、作品行を掴んだまま決める。画面にも同じ規則を書くと
 * 2 か所で必ずずれ、**画面は通すのにサーバーが弾く**という一番わかり
 * にくい形になる。
 *
 * ⚠️ **直す先の数をここで作らない。** 送るのは「画面が見ていた数」だけ。
 * 直す先はサーバーが仮引当と受取権から計算で出す。決済 P0/P1 §9.3 が
 * 禁じる「在庫数と無関係な予約作成」に触れないのはこのため。
 *
 * ⚠️ **一括で直す口をここに作らない。** 作品を 1 件ずつ受ける。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function repairReservedCountAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const artworkId = text(form, 'artworkId');
  const observed = Number.parseInt(text(form, 'observedReservedCount'), 10);
  /*
    ⚠️ **数として読めなければ送らない。** 送ると `NaN` が本文に載り、
       zod が弾いた理由が「入力が正しくありません」に丸まる。ここで
       止めれば、何を直せばよいか分かる。
  */
  if (!Number.isInteger(observed)) {
    return { error: '画面の情報を読み取れませんでした。画面を開き直してお試しください。' };
  }

  const causeState = text(form, 'causeState') === 'unknown' ? 'unknown' : 'identified';
  const result = await repairReservedCount(artworkId, {
    observedReservedCount: observed,
    reason: text(form, 'reason'),
    causeState,
  });
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/admin/consistency');
  revalidatePath('/admin/consistency/reserved-count-drift');
  revalidatePath('/admin/consistency/reserved-count-repairs');
  // ⚠️ ダッシュボードの「原因が分からないまま直した押さえ」も動く。
  revalidatePath('/admin');

  const { before, after } = result.data;
  const moved = `お取り置きの数を ${String(before)} から ${String(after)} へ直しました。`;
  if (causeState === 'unknown') {
    return {
      notice: moved,
      /*
        ⚠️ **「終わった」と読ませない。** 原因未特定で直したものは
           積み残しとして残り続ける。ここで黙ると、押した人は片付いた
           つもりで次へ進む。
      */
      noticeHint:
        '原因がまだ分かっていないため、「原因が分からないまま直した記録」に残ります。原因が分かったら、その一覧から閉じてください。',
    };
  }
  return {
    notice: moved,
    noticeHint: '原因が分かったうえでの修復として記録しました。',
  };
}

export async function resolveReservedCountRepairAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const result = await resolveReservedCountRepair(text(form, 'repairId'), {
    note: text(form, 'note'),
  });
  if (!result.ok) {
    return { error: adminErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/admin/consistency/reserved-count-repairs');
  revalidatePath('/admin');

  return {
    notice: '原因が分かったものとして閉じました。',
    /*
      ⚠️ **消えたわけではないことを伝える。** 直した記録そのものは
         残り続ける。消せると思われると、この表を持つ意味が伝わらない。
    */
    noticeHint: '直したときの数と内訳は、記録として残ります。',
  };
}
