/**
 * 人が残す証跡（実運営 指示書 P0-7 の 9 番目・10 番目）。
 *
 * 10 条件のうち 8 つは機械が確かめられる。残る 2 つ——**通し試験が
 * 通ったこと**と**責任者が承認したこと**——は、機械には確かめようがない。
 * これは人が「確かめました」「承認しました」と署名する行為であって、
 * その事実そのものを記録する。
 *
 * ⚠️ **これは「試験が通った証明」ではない。** 押した人が「通した」と
 * 言っている記録にすぎない。だからこそ**誰がいつ押したかを残し、
 * あとから書き換えられないようにする**。書き換えられるなら、
 * 記録である意味が無い。
 *
 * ⚠️ **追記だけ。更新も削除もしない。** 「間違えたので直す」は、
 * 新しい記録を足すことで表す。消せると、都合の悪い記録が消える。
 */

/** 何についての記録か。⚠️ 語彙を閉じる。 */
export const ATTESTATION_KINDS = [
  /** 本番の鍵で 1 件購入し、お届けまで通ることを確かめた。 */
  'e2e_sale_test',
  /** 運営責任者が、本番販売の開始を承認した。 */
  'owner_approval',
] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

export function isAttestationKind(value: string): value is AttestationKind {
  return (ATTESTATION_KINDS as readonly string[]).includes(value);
}

/** 覚え書きの上限。⚠️ 長文の置き場にしない。詳しくは別の資料へ。 */
export const ATTESTATION_NOTE_MAX_LENGTH = 1000;

export interface RecordAttestationCommand {
  readonly kind: AttestationKind;
  readonly succeeded: boolean;
  /**
   * どの決済世代について確かめたか。
   *
   * ⚠️ **必須。** 紐づけないと、前の鍵で通した試験が新しい鍵の証拠として
   * 残り続ける。鍵が替わるのは、運営会社や入金先が変わるということである。
   */
  readonly credentialId: string;
  readonly attestedByAccountId: string;
  /** 何を確かめたか。⚠️ **秘密を書かせない**（画面にも注意書きを出す）。 */
  readonly note: string | null;
}

export type AttestationRejection =
  | 'NOTE_TOO_LONG'
  /** 「不成立」を記録するなら、何が起きたかを書いてもらう。 */
  | 'FAILURE_REQUIRES_NOTE';

export type AttestationDecision =
  | { readonly ok: true; readonly command: RecordAttestationCommand }
  | { readonly ok: false; readonly reason: AttestationRejection };

/**
 * 記録してよいか。
 *
 * ⚠️ **「承認してよいか」は判定しない。** 10 条件が満たされる前でも
 * 承認は記録できる。順序を強制すると、承認を先に取っておく運用
 * （鍵の切り替え日に合わせて段取りする、など）ができなくなる。
 * **押した記録は残り、条件の判定はそれとは別に毎回やり直される**ので、
 * 早く押しても近道にはならない。
 *
 * ⚠️ **「不成立」に覚え書きを求める。** 「通りませんでした」だけの記録は、
 * 次に読む人にとって何の手がかりにもならない。
 */
export function decideAttestation(input: {
  readonly kind: AttestationKind;
  readonly succeeded: boolean;
  readonly credentialId: string;
  readonly attestedByAccountId: string;
  readonly note: string | null;
}): AttestationDecision {
  const note = normalizeNote(input.note);

  if (note !== null && note.length > ATTESTATION_NOTE_MAX_LENGTH) {
    return { ok: false, reason: 'NOTE_TOO_LONG' };
  }
  if (!input.succeeded && note === null) {
    return { ok: false, reason: 'FAILURE_REQUIRES_NOTE' };
  }

  return {
    ok: true,
    command: {
      kind: input.kind,
      succeeded: input.succeeded,
      credentialId: input.credentialId,
      attestedByAccountId: input.attestedByAccountId,
      note,
    },
  };
}

/** 前後の空白を落とし、空文字は `null` にする。⚠️ 空白だけの覚え書きを通さない。 */
function normalizeNote(note: string | null): string | null {
  if (note === null) {
    return null;
  }
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}
