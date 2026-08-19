'use server';

import { revalidatePath } from 'next/cache';
import { publishLegalVersion, saveLegalDraft, type AdminResult } from '../../../src/admin-client';
import { legalErrorMessage, LEGAL_COPY } from '../../../src/legal-copy';
import type { AdminActionState } from '../actions';

/**
 * 法務文書の操作。
 *
 * ⚠️ **ここは受け渡しだけを行う。判定はすべて API 側。**
 * 「公開済みは書き換えない」「欠けたまま公開しない」を画面へ写すと、
 * 2 か所に同じ規則ができて必ずずれる。
 *
 * ⚠️ **失敗の理由をそのまま画面へ流さない。** 符号から言葉を引く。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fail<T>(result: AdminResult<T>): AdminActionState {
  return {
    error: result.ok ? undefined : legalErrorMessage(result.code, result.reason),
  };
}

function refresh(kind: string): void {
  revalidatePath(`/admin/legal/${kind}`);
  // 公開ページも作り直す。公開したのに古い文が出続けるのを避ける。
  revalidatePath(`/legal/${kind}`);
}

const TOKUSHOHO_KEYS = [
  'sellerName',
  'representativeName',
  'address',
  'phoneNumber',
  'contactEmail',
  'priceDescription',
  'additionalFees',
  'paymentMethods',
  'paymentTiming',
  'deliveryTiming',
  'returnPolicy',
  'operatingEnvironment',
] as const;

export async function saveLegalDraftAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const kind = text(form, 'kind');
  const title = text(form, 'title');
  if (title === '') {
    return { error: '表題を入力してください。' };
  }

  const request =
    kind === 'tokushoho'
      ? {
          title,
          tokushoho: Object.fromEntries(
            TOKUSHOHO_KEYS.map((key) => [key, text(form, key)]),
          ) as Record<(typeof TOKUSHOHO_KEYS)[number], string>,
        }
      : { title, bodyText: text(form, 'bodyText') };

  const result = await saveLegalDraft(kind, request);
  if (!result.ok) {
    return fail(result);
  }

  refresh(kind);
  return { notice: LEGAL_COPY.draftSaved };
}

/**
 * 下書きを公開する。
 *
 * ⚠️ **取り消せない。** 画面側で確認を挟んであるが、確認は親切であって
 * 保護ではない。断るかどうかは API が決める。
 */
export async function publishLegalAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const kind = text(form, 'kind');
  const effectiveFrom = text(form, 'effectiveFrom');
  if (effectiveFrom === '') {
    return { error: '適用開始日時を入力してください。' };
  }

  /*
    ⚠️ `datetime-local` はタイムゾーンを持たない文字列を返す。
       そのまま送ると、受け取る側が UTC と読むか JST と読むかで
       9 時間ずれる。ここで運用のタイムゾーン（JST）として解釈し、
       ISO 8601 へ直してから送る。
  */
  const parsed = new Date(`${effectiveFrom}:00+09:00`);
  if (Number.isNaN(parsed.getTime())) {
    return { error: '適用開始日時の形式が正しくありません。' };
  }

  const result = await publishLegalVersion(kind, {
    effectiveFrom: parsed.toISOString(),
    // ⚠️ 利用規約だけに効く。ほかの種類では欄そのものを出していない。
    requiresReconsent: kind === 'terms' && form.get('requiresReconsent') === 'on',
  });
  if (!result.ok) {
    return fail(result);
  }

  refresh(kind);
  return { notice: LEGAL_COPY.published };
}
