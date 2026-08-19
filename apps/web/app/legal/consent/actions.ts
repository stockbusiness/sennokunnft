'use server';

import { redirect } from 'next/navigation';
import { recordConsent } from '../../../src/legal-consent-client';
import { LEGAL_COPY, legalErrorMessage } from '../../../src/legal-copy';
import { safeReturnPath } from '../../../src/auth/session';

export interface ConsentState {
  readonly error?: string;
}

/**
 * 同意を記録する。
 *
 * ⚠️ **チェックが無ければ送らない。** 「押したこと」を同意と見なすと、
 * 何に同意したのか分からない記録が残る。
 *
 * ⚠️ **画面が見ていた版を送る。** サーバー側で「いまの版」に差し替えると、
 * 利用者が読んだものと記録が食い違う。食い違えば API が断る。
 */
export async function recordConsentAction(
  _previous: ConsentState,
  form: FormData,
): Promise<ConsentState> {
  const agreed = form.get('agreed');
  if (agreed !== 'on') {
    return { error: LEGAL_COPY.consentRequired };
  }

  const versionId = form.get('versionId');
  if (typeof versionId !== 'string' || versionId === '') {
    return { error: LEGAL_COPY.consentMismatch };
  }

  const result = await recordConsent(versionId);
  if (!result.ok) {
    return { error: legalErrorMessage(result.code, result.reason) };
  }

  const next = form.get('next');
  redirect(safeReturnPath(typeof next === 'string' ? next : null));
}
