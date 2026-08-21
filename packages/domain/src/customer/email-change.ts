/**
 * ご連絡先の変更申請（実運営 指示書 P1-1「本人確認後のメール変更申請」）。
 *
 * **本システムはメールアドレスを持っていない。** 認証の正は認証基盤側に
 * あり、こちらが持つのは照合用の値だけ（`UD-503`）。だから**ここで
 * アドレスを書き換えることはできないし、してはいけない**。
 *
 * この仕組みが受け持つのは 3 つだけ。
 *   1. 変更したいという申し出があったことを残す
 *   2. **本人確認をした人と、その根拠**を残す
 *   3. 認証基盤側で変更が済んだことを残す
 *
 * ⚠️ **新しいアドレスの平文を保存しない。** 申請の記録として残したくなるが、
 * 残せば `UD-503` を自分で破ることになる。伏せた表記と照合用の値まで。
 *
 * ⚠️ **本人確認をしていない申請を「済」にできない。** 状態の遷移で縛る。
 * 縛らないと、忙しい日に飛ばされる。飛ばされたことは、乗っ取られるまで
 * 誰にも分からない。
 */

/** 申請の状態。 */
export const EMAIL_CHANGE_STATUSES = [
  /** 申し出を受けた。⚠️ **まだ本人確認をしていない。** */
  'requested',
  /** 本人確認が済んだ。⚠️ **まだ変わっていない。** */
  'identity_verified',
  /** 認証基盤側で変更が済んだ。 */
  'completed',
  /** 取り下げ、または本人確認が通らなかった。 */
  'rejected',
] as const;
export type EmailChangeStatus = (typeof EMAIL_CHANGE_STATUSES)[number];

/**
 * 本人確認の方法。
 *
 * ⚠️ **語彙を閉じる。** 自由文にすると「確認済み」とだけ書かれた記録が並び、
 * あとから見た人には何をしたのか分からない。
 */
export const IDENTITY_VERIFICATION_METHODS = [
  /** 登録済みのご連絡先へ送った確認に返信があった。 */
  'existing_contact_reply',
  /** ご注文の内容（注文番号・金額・日付）を照合した。 */
  'order_details_match',
  /** 本人確認書類を確認した。⚠️ **書類そのものは保存しない。** */
  'identity_document',
] as const;
export type IdentityVerificationMethod = (typeof IDENTITY_VERIFICATION_METHODS)[number];

export const IDENTITY_VERIFICATION_LABELS: Readonly<Record<IdentityVerificationMethod, string>> = {
  existing_contact_reply: '登録済みのご連絡先への確認に、ご返信をいただいた',
  order_details_match: 'ご注文の内容を照合した',
  identity_document: '本人確認書類を確認した（書類は保存していません）',
};

/** 申請の覚え書きの上限。⚠️ 長文の置き場にしない。 */
export const EMAIL_CHANGE_NOTE_MAX_LENGTH = 1000;

export type EmailChangeRejection =
  | 'NOTE_TOO_LONG'
  /** 済ませるには、先に本人確認が要る。 */
  | 'IDENTITY_NOT_VERIFIED'
  /** 終わった申請は動かせない。 */
  | 'ALREADY_SETTLED'
  /** 見送るなら理由を書いてもらう。 */
  | 'REJECTION_REQUIRES_NOTE';

export type EmailChangeDecision<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: EmailChangeRejection };

/**
 * 本人確認を記録する。
 *
 * ⚠️ **「誰が」を必ず残す。** 確認したことにする圧力は、忙しい日にかかる。
 * 名前が残ると分かっていれば、飛ばしにくくなる。
 */
export function verifyIdentity(input: {
  readonly current: EmailChangeStatus;
  readonly method: IdentityVerificationMethod;
  readonly note: string | null;
}): EmailChangeDecision<{
  readonly status: 'identity_verified';
  readonly method: IdentityVerificationMethod;
  readonly note: string | null;
}> {
  if (isSettled(input.current)) {
    return { ok: false, reason: 'ALREADY_SETTLED' };
  }
  const note = normalize(input.note);
  if (note !== null && note.length > EMAIL_CHANGE_NOTE_MAX_LENGTH) {
    return { ok: false, reason: 'NOTE_TOO_LONG' };
  }
  return { ok: true, value: { status: 'identity_verified', method: input.method, note } };
}

/**
 * 認証基盤側で変えたことを記録する。
 *
 * ⚠️ **本人確認を飛ばして済ませられない。** ここが、この仕組みの
 * 唯一にして最大の value である。
 *
 * ⚠️ **この操作でアドレスは変わらない。** 変えるのは認証基盤側で人が行う。
 * ここは「変えた」という事実を残すだけ。順序を逆にしない
 * （記録してから変えると、変え忘れが記録の中に埋もれる）。
 */
export function completeEmailChange(input: {
  readonly current: EmailChangeStatus;
  readonly note: string | null;
}): EmailChangeDecision<{ readonly status: 'completed'; readonly note: string | null }> {
  if (isSettled(input.current)) {
    return { ok: false, reason: 'ALREADY_SETTLED' };
  }
  if (input.current !== 'identity_verified') {
    return { ok: false, reason: 'IDENTITY_NOT_VERIFIED' };
  }
  const note = normalize(input.note);
  if (note !== null && note.length > EMAIL_CHANGE_NOTE_MAX_LENGTH) {
    return { ok: false, reason: 'NOTE_TOO_LONG' };
  }
  return { ok: true, value: { status: 'completed', note } };
}

/**
 * 見送る。
 *
 * ⚠️ **理由を求める。** 「見送りました」だけの記録は、同じ方から
 * 次に問い合わせが来たときに何の役にも立たない。
 */
export function rejectEmailChange(input: {
  readonly current: EmailChangeStatus;
  readonly note: string | null;
}): EmailChangeDecision<{ readonly status: 'rejected'; readonly note: string }> {
  if (isSettled(input.current)) {
    return { ok: false, reason: 'ALREADY_SETTLED' };
  }
  const note = normalize(input.note);
  if (note === null) {
    return { ok: false, reason: 'REJECTION_REQUIRES_NOTE' };
  }
  if (note.length > EMAIL_CHANGE_NOTE_MAX_LENGTH) {
    return { ok: false, reason: 'NOTE_TOO_LONG' };
  }
  return { ok: true, value: { status: 'rejected', note } };
}

/** 終わった申請かどうか。⚠️ 終わったものは動かさない。 */
export function isSettled(status: EmailChangeStatus): boolean {
  return status === 'completed' || status === 'rejected';
}

function normalize(note: string | null): string | null {
  if (note === null) {
    return null;
  }
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}
