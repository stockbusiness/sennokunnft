import type { LegalDocumentKind, LegalVersionView } from './legal-types';

/**
 * 法務文書の画面の文言。
 *
 * ⚠️ **Web3 用語も法律用語も、そのまま出さない。** 読むのは購入者と、
 * 法律の専門家ではない運営者。「施行」より「適用開始」のほうが伝わる。
 *
 * ⚠️ **「公開」の重さを言葉で伝える。** 取り消せない操作なので、
 * 押す前に何が起きるかを書く。押したあとに書いても遅い。
 */

export const LEGAL_KIND_LABEL: Readonly<Record<LegalDocumentKind, string>> = {
  terms: '利用規約',
  privacy: 'プライバシーポリシー',
  tokushoho: '特定商取引法に基づく表記',
};

export const LEGAL_KIND_PATH: Readonly<Record<LegalDocumentKind, string>> = {
  terms: '/legal/terms',
  privacy: '/legal/privacy',
  tokushoho: '/legal/tokushoho',
};

/** 特商法の項目名。⚠️ 法で定められた呼び方に寄せる。 */
export const TOKUSHOHO_LABEL: Readonly<Record<string, string>> = {
  sellerName: '販売事業者',
  representativeName: '運営統括責任者',
  address: '所在地',
  phoneNumber: '電話番号',
  contactEmail: 'メールアドレス',
  priceDescription: '販売価格',
  additionalFees: '商品代金以外の必要料金',
  paymentMethods: 'お支払い方法',
  paymentTiming: 'お支払い時期',
  deliveryTiming: 'お引渡し時期',
  returnPolicy: '返品・キャンセルについて',
  operatingEnvironment: '動作環境',
};

export const LEGAL_COPY = {
  adminTitle: '規約・法務の表記',
  adminDescription:
    '利用規約、プライバシーポリシー、特定商取引法に基づく表記を編集します。公開した内容は、お客さまとのお約束になります。',

  /**
   * ⚠️ **いちばん先に出す注意。** 公開は取り消せない。
   */
  immutableNotice: '公開した内容は、あとから書き換えられません',
  immutableNoticeHint:
    '直したいときは、新しい版を作って公開します。過去の版は「そのときどう書いてあったか」を示すために残します。',

  draftHeading: '下書き',
  draftNone: 'まだ下書きがありません。下の欄に入力して保存してください。',
  draftSaveButton: '下書きを保存する',
  draftSaved: '下書きを保存しました。まだ公開されていません。',

  publishHeading: '公開する',
  publishEffectiveFrom: '適用開始日時',
  publishEffectiveFromHint:
    '未来の日時を指定できます。指定した日時になると、自動的にこちらの内容へ切り替わります。',
  publishButton: 'この内容で公開する',
  /** ⚠️ 押す前に読ませる。 */
  publishConfirm:
    '公開すると、あとから書き換えられません。直すときは新しい版を作ることになります。よろしいですか。',
  published: '公開しました。',

  historyHeading: 'これまでの版',
  statusDraft: '下書き',
  statusScheduled: '公開済み（適用開始前）',
  statusEffective: '適用中',
  statusSuperseded: '公開済み（過去の版）',

  missingHeading: '公開に足りない項目',
  missingBody: '本文',

  fieldTitle: '表題',
  fieldBody: '本文',
  fieldBodyHint: '行の先頭に「## 」で見出し、「- 」で箇条書きになります。HTMLタグは使えません。',

  publicPreparingTitle: '準備中です',
  publicPreparing: 'この内容は現在準備中です。お手数ですが、しばらくしてからご確認ください。',
  publicUnavailable: 'ただいま表示できません。しばらくしてからお試しください。',
  publicEffectiveFrom: '適用開始日',

  errorNotDraft: 'すでに公開されている版は書き換えられません。画面を読み込み直してください。',
  errorIncomplete: '公開に必要な項目が入力されていません。',
  errorInvalid: '入力内容をご確認ください。HTMLタグは使えません。',
  errorEffectiveDate: '適用開始日時は、現在より後で、いま適用中の版より後にしてください。',
  errorForbidden: '公開する権限がありません。オーナーにご依頼ください。',
  errorUnavailable: 'ただいま保存できませんでした。しばらくしてからお試しください。',
} as const;

/**
 * 版の状態を、画面の言葉にする。
 *
 * ⚠️ **「公開済み」だけで済ませない。** 予約公開があるので、公開済みでも
 * まだ適用されていない版がある。同じ言葉にすると、運営が
 * 「もう切り替わった」と思い込む。
 */
export function versionStatusLabel(version: LegalVersionView, hasNewerEffective: boolean): string {
  if (version.status === 'draft') {
    return LEGAL_COPY.statusDraft;
  }
  if (version.isEffective) {
    return hasNewerEffective ? LEGAL_COPY.statusSuperseded : LEGAL_COPY.statusEffective;
  }
  return LEGAL_COPY.statusScheduled;
}

/** API の符号から、画面へ出す言葉を引く。⚠️ API の本文をそのまま出さない。 */
export function legalErrorMessage(code: string | undefined, reason: string): string {
  switch (code) {
    case 'LEGAL_VERSION_NOT_DRAFT':
      return LEGAL_COPY.errorNotDraft;
    case 'LEGAL_DOCUMENT_INCOMPLETE':
      return LEGAL_COPY.errorIncomplete;
    case 'LEGAL_DOCUMENT_INVALID':
    case 'VALIDATION_ERROR':
      return LEGAL_COPY.errorInvalid;
    case 'LEGAL_EFFECTIVE_DATE_INVALID':
      return LEGAL_COPY.errorEffectiveDate;
    default:
      return reason === 'unauthorized' ? LEGAL_COPY.errorForbidden : LEGAL_COPY.errorUnavailable;
  }
}
