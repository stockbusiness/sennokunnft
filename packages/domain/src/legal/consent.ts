import type { LegalDocumentKind, LegalDocumentVersion } from './document';

/**
 * 法務文書への同意（`UD-126` 決定 2026-08-19）。
 *
 * ⚠️ **同意を求めるのは利用規約だけ。** プライバシーポリシーを同じ
 * チェックへ束ねない。個人情報保護法では利用目的は原則「公表」で足り、
 * 「同意」が要るのは第三者提供などの場面。束ねると、**必要な同意が
 * 取れていないのに取れたつもりになる**。外部システムへのデータ提供に
 * 要る同意は、別の決定として扱う。
 *
 * ⚠️ **特商法表記は同意の対象ではない。** 表示義務であって、
 * 相手が承諾するものではない。
 */

/** 同意を求める文書。⚠️ 増やすときは、なぜ同意が要るのかを書くこと。 */
export const CONSENT_REQUIRED_KINDS = ['terms'] as const;
export type ConsentRequiredKind = (typeof CONSENT_REQUIRED_KINDS)[number];

export function requiresConsent(kind: LegalDocumentKind): kind is ConsentRequiredKind {
  return (CONSENT_REQUIRED_KINDS as readonly string[]).includes(kind);
}

/**
 * 誰が、どの版に、いつ同意したか。
 *
 * ⚠️ **版そのものを指す。** 「同意済み」という真偽値にしない。
 * 真偽値だと、改定したあとに「どれに同意したのか」が分からない。
 */
export interface LegalConsentRecord {
  readonly accountId: string;
  readonly kind: ConsentRequiredKind;
  readonly versionId: string;
  /** 版番号。⚠️ 比較に使うのはこちら。ID は順序を持たない。 */
  readonly version: number;
  readonly consentedAt: Date;
}

export interface ConsentRequirementInput {
  /** いま施行されている版。無ければ `null`。 */
  readonly effective: LegalDocumentVersion | null;
  /** その人の直近の同意。まだ無ければ `null`。 */
  readonly latestConsent: LegalConsentRecord | null;
  /**
   * その人が同意した版より後に施行された版のうち、**再同意を求める印が
   * 立っているもの**があるか。
   *
   * ⚠️ **「新しい版が出たか」ではない。** 誤字を直しただけの改定で
   * 全員を止めると、同意の画面が「とりあえず押すもの」になる。
   * 印を立てるかどうかは、公開する人が決める（`requiresReconsent`）。
   */
  readonly hasPendingReconsent: boolean;
}

export type ConsentRequirement =
  /** 同意を求める必要がない。 */
  | { readonly required: false; readonly reason: 'no_document' | 'already_consented' }
  /** 同意を求める。 */
  | {
      readonly required: true;
      readonly reason: 'never_consented' | 'reconsent';
      readonly version: LegalDocumentVersion;
    };

/**
 * その人に同意を求めるべきか。
 *
 * ⚠️ **施行中の版が無ければ、求めない。** ここを「無ければ止める」に
 * すると、**規約をまだ公開していない立ち上げ時に誰もログインできない**。
 * 規約を公開できるのは管理画面へ入れる人で、その人がログインできなければ
 * 永久に公開できない。締め出しは復旧の手立てが無いので、通す側へ倒す。
 * 「規約が無いまま販売しない」は、公開前の手順（`UD-111`）で守る。
 */
export function evaluateConsentRequirement(input: ConsentRequirementInput): ConsentRequirement {
  const { effective, latestConsent } = input;

  if (effective === null) {
    return { required: false, reason: 'no_document' };
  }
  if (latestConsent === null) {
    return { required: true, reason: 'never_consented', version: effective };
  }
  /*
    ⚠️ 版番号で比べる。日時で比べない。同じ日時に 2 つ施行されない
       ようにはしてあるが、番号のほうが「あとの版か」を素直に表す。
  */
  if (latestConsent.version >= effective.version) {
    return { required: false, reason: 'already_consented' };
  }
  if (input.hasPendingReconsent) {
    return { required: true, reason: 'reconsent', version: effective };
  }
  /*
    ⚠️ 新しい版はあるが、再同意の印が立っていない。求めない。
       ただし**注文には、その時点の版が記録される**ので、
       「そのご注文の時点でどう書いてあったか」は答えられる。
  */
  return { required: false, reason: 'already_consented' };
}

/**
 * 注文へ残す、その時点の規約の版。
 *
 * ⚠️ **同意の記録ではない。** 「何が表示されていたか」の記録。
 * この案件のスナップショット原則（価格・手数料率・作品名を注文時点の値で
 * 保存する）と同じ扱いで、あとからマスタが変わっても過去の注文は動かない。
 *
 * ⚠️ **施行中の版が無ければ `null`。** 無いことを、無いまま残す。
 * それらしい版を埋めると、掲げていなかった事実が消える。
 */
export interface OrderLegalSnapshot {
  readonly termsVersionId: string | null;
  readonly termsVersion: number | null;
}

export function snapshotForOrder(effectiveTerms: LegalDocumentVersion | null): OrderLegalSnapshot {
  if (effectiveTerms === null) {
    return { termsVersionId: null, termsVersion: null };
  }
  return { termsVersionId: effectiveTerms.id, termsVersion: effectiveTerms.version };
}
