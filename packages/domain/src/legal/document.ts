import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';

/**
 * 法務文書（利用規約・プライバシーポリシー・特定商取引法に基づく表記）。
 *
 * ⚠️ **普通のコンテンツと同じに扱わない。** 作品の説明文なら、直したら
 * 直った内容だけが残っていればよい。法務文書は違って、**過去にどの版が
 * 有効だったか**が意味を持つ。「その注文の時点でどう書いてあったか」を
 * 示せないと、返金や苦情の場面で説明ができない。
 *
 * ⚠️ **公開した版は書き換えない。** 直すときは新しい版を作る。
 * 上書きを許すと、過去の版が失われ、上のことが成り立たなくなる。
 *
 * ⚠️ **削除の口を作らない。** 消せると、いつか「古いから」と消される。
 * 消えて困るのは、消したあとに問い合わせが来たときで、そのときには
 * もう戻せない。
 */

export const LEGAL_DOCUMENT_KINDS = ['terms', 'privacy', 'tokushoho'] as const;
export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];

export function isLegalDocumentKind(value: string): value is LegalDocumentKind {
  return (LEGAL_DOCUMENT_KINDS as readonly string[]).includes(value);
}

/**
 * 版の状態。
 *
 * ⚠️ **「施行中」を状態として持たない。** 施行中かどうかは施行日と
 * 現在時刻から決まる。状態として持つと、日付が来ても誰かが切り替えるまで
 * 変わらない、という食い違いが生まれる。時計に任せる。
 */
export const LEGAL_VERSION_STATUSES = ['draft', 'published'] as const;
export type LegalVersionStatus = (typeof LEGAL_VERSION_STATUSES)[number];

/**
 * 特定商取引法に基づく表記の項目。
 *
 * ⚠️ **自由文 1 枚にしない。** 法で示すべき項目が決まっている。1 枚の
 * 文章で持つと、抜けているかどうかを誰も判定できない。項目で持てば、
 * 欠けを機械が見つけられる。
 *
 * ⚠️ **「なし」も書かせる。** 空欄と「かかりません」は別。空欄は
 * 「まだ書いていない」で、公開させない。
 */
export interface TokushohoFields {
  /** 事業者の名称 */
  readonly sellerName: string;
  /** 運営統括責任者 */
  readonly representativeName: string;
  /** 所在地 */
  readonly address: string;
  /** 電話番号 */
  readonly phoneNumber: string;
  /** 連絡先メールアドレス */
  readonly contactEmail: string;
  /** 販売価格 */
  readonly priceDescription: string;
  /** 商品代金以外の必要料金 */
  readonly additionalFees: string;
  /** 支払方法 */
  readonly paymentMethods: string;
  /** 支払時期 */
  readonly paymentTiming: string;
  /** 引渡時期 */
  readonly deliveryTiming: string;
  /** 返品・交換（返品特約） */
  readonly returnPolicy: string;
  /** 動作環境 */
  readonly operatingEnvironment: string;
}

export const TOKUSHOHO_FIELD_KEYS = [
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

export interface LegalDocumentVersion {
  readonly id: string;
  readonly kind: LegalDocumentKind;
  /** 1 から始まる連番。⚠️ 種類ごとに一意。 */
  readonly version: number;
  readonly status: LegalVersionStatus;
  readonly title: string;
  /**
   * 本文。規約とプライバシーポリシーで使う。
   *
   * ⚠️ **HTML を入れさせない。** 保存も描画もしない。見出しと箇条書きは
   * 限られた印だけを解釈する（`renderLegalBody` 参照）。HTML を許すと、
   * 法務文書という「利用者が疑わずに読む場所」に、任意の内容を
   * 差し込める道ができる。
   */
  readonly bodyText: string | null;
  /** 特商法の項目。ほかの種類では `null`。 */
  readonly tokushoho: TokushohoFields | null;
  /** 施行日。⚠️ 未来の日付を入れられる。公開の予約になる。 */
  readonly effectiveFrom: Date | null;
  /**
   * この版から、利用者へ**もう一度同意を求める**か（`UD-126`）。
   *
   * ⚠️ **システムに判定させない。** 誤字を直しただけの改定で全員を
   * 止めると、同意の画面が「とりあえず押すもの」になり、同意という
   * 記録の意味が薄れる。実質的な変更かどうかは、公開する人が決める。
   *
   * ⚠️ 同意を求めるのは利用規約だけ（`consent.ts`）。ほかの種類で
   * 立てても効かない。
   */
  readonly requiresReconsent: boolean;
  readonly publishedAt: Date | null;
  readonly createdByAccountId: string;
  readonly publishedByAccountId: string | null;
  readonly createdAt: Date;
}

export const LEGAL_TITLE_MAX = 200;
export const LEGAL_BODY_MAX = 100_000;
export const TOKUSHOHO_FIELD_MAX = 1_000;

/**
 * 特商法の表記で、まだ埋まっていない項目。
 *
 * ⚠️ **項目名を返す。** 「未完成です」だけでは、どこを直せばよいか
 * 分からない。埋める人が画面を見て回ることになる。
 */
export function missingTokushohoFields(
  fields: TokushohoFields | null,
): readonly (typeof TOKUSHOHO_FIELD_KEYS)[number][] {
  if (fields === null) {
    return TOKUSHOHO_FIELD_KEYS;
  }
  return TOKUSHOHO_FIELD_KEYS.filter((key) => fields[key].trim() === '');
}

export interface SaveDraftInput {
  readonly title: string;
  readonly bodyText?: string | null;
  readonly tokushoho?: TokushohoFields | null;
}

/**
 * 下書きを書き換える。
 *
 * ⚠️ **公開済みの版には使えない。** 公開した内容を書き換えると、
 * 「その時点でどう書いてあったか」が失われる。
 */
export function saveDraft(
  version: LegalDocumentVersion,
  input: SaveDraftInput,
): Result<LegalDocumentVersion, DomainError> {
  if (version.status !== 'draft') {
    return err(domainError('LEGAL_VERSION_NOT_DRAFT', 'published version is immutable'));
  }

  const title = input.title.trim();
  if (title === '' || title.length > LEGAL_TITLE_MAX) {
    return err(domainError('LEGAL_DOCUMENT_INVALID', 'title length out of range'));
  }

  if (version.kind === 'tokushoho') {
    const fields = input.tokushoho ?? version.tokushoho;
    if (fields === null) {
      return err(domainError('LEGAL_DOCUMENT_INVALID', 'tokushoho fields are required'));
    }
    for (const key of TOKUSHOHO_FIELD_KEYS) {
      if (fields[key].length > TOKUSHOHO_FIELD_MAX) {
        return err(domainError('LEGAL_DOCUMENT_INVALID', `field too long: ${key}`));
      }
    }
    /*
      ⚠️ **下書きの時点では、空欄を許す。** 書きかけで保存できないと、
         一度に全部書ける人しか使えない。欠けを止めるのは公開のとき。
    */
    return ok({ ...version, title, bodyText: null, tokushoho: normalize(fields) });
  }

  const bodyText = input.bodyText ?? version.bodyText ?? '';
  if (bodyText.length > LEGAL_BODY_MAX) {
    return err(domainError('LEGAL_DOCUMENT_INVALID', 'body is too long'));
  }
  if (containsHtmlTag(bodyText)) {
    /*
      ⚠️ **保存の時点で断る。** 描画側で無視するだけにすると、いつか
         別の描画経路（メール本文・PDF）ができたときに、そちらへ流れる。
    */
    return err(domainError('LEGAL_DOCUMENT_INVALID', 'html is not allowed'));
  }

  return ok({ ...version, title, bodyText, tokushoho: null });
}

export interface PublishInput {
  readonly version: LegalDocumentVersion;
  readonly effectiveFrom: Date;
  readonly publishedByAccountId: string;
  /**
   * この版から再同意を求めるか。
   *
   * ⚠️ **公開のときにしか決められない。** あとから立てられる形にすると、
   * 「いつから求め始めたのか」が版から読み取れなくなる。
   */
  readonly requiresReconsent: boolean;
  readonly now: Date;
  /**
   * いま施行中の版の施行日。無ければ `null`。
   *
   * ⚠️ **さかのぼって施行しない。** 過去の日付で公開できると、
   * 「その注文の時点で有効だった版」があとから変わる。
   */
  readonly currentEffectiveFrom: Date | null;
}

export function publish(input: PublishInput): Result<LegalDocumentVersion, DomainError> {
  const { version, effectiveFrom, now } = input;

  if (version.status !== 'draft') {
    return err(domainError('LEGAL_VERSION_NOT_DRAFT', 'already published'));
  }
  if (version.title.trim() === '') {
    return err(domainError('LEGAL_DOCUMENT_INCOMPLETE', 'title is empty'));
  }

  if (version.kind === 'tokushoho') {
    /*
      ⚠️ **欠けたまま公開させない。** 特商法は表示義務なので、抜けたまま
         公開すると、販売そのものが法に触れる。0 のまま売らせない
         手数料率と同じ考え方で、「出せない」ほうへ倒す。
    */
    const missing = missingTokushohoFields(version.tokushoho);
    if (missing.length > 0) {
      return err(domainError('LEGAL_DOCUMENT_INCOMPLETE', `missing: ${missing.join(',')}`));
    }
  } else if ((version.bodyText ?? '').trim() === '') {
    return err(domainError('LEGAL_DOCUMENT_INCOMPLETE', 'body is empty'));
  }

  /*
    ⚠️ **過去の日付で施行できない。** 施行日をさかのぼれると、
       過去の注文に紐づく「その時点の版」が入れ替わる。
       同じ理由で、いま施行中の版より前の日付も認めない。
  */
  if (effectiveFrom.getTime() < now.getTime()) {
    return err(domainError('LEGAL_EFFECTIVE_DATE_INVALID', 'effective date is in the past'));
  }
  if (
    input.currentEffectiveFrom !== null &&
    effectiveFrom.getTime() <= input.currentEffectiveFrom.getTime()
  ) {
    return err(domainError('LEGAL_EFFECTIVE_DATE_INVALID', 'not after the current version'));
  }

  return ok({
    ...version,
    status: 'published',
    effectiveFrom,
    publishedAt: now,
    publishedByAccountId: input.publishedByAccountId,
    requiresReconsent: input.requiresReconsent,
  });
}

/**
 * いま施行されている版を選ぶ。
 *
 * ⚠️ **施行日が来ていない版は選ばない。** 公開の予約ができる以上、
 * 「公開済み＝いま有効」ではない。
 *
 * ⚠️ **同じ関数を画面と公開ページの両方で使う。** 別々に書くと、
 * 管理画面で「施行中」と出ているのに公開ページには古い版が出る、
 * という食い違いがいつか生まれる。
 */
export function effectiveVersion(
  versions: readonly LegalDocumentVersion[],
  now: Date,
): LegalDocumentVersion | null {
  const candidates = versions
    .filter(
      (version) =>
        version.status === 'published' &&
        version.effectiveFrom !== null &&
        version.effectiveFrom.getTime() <= now.getTime(),
    )
    .sort((a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0));
  return candidates[0] ?? null;
}

/**
 * HTML のタグらしきものが含まれるか。
 *
 * ⚠️ **厳しすぎるくらいでよい。** 法務文書に `<` を書きたい場面は
 * ほとんど無い。取りこぼすより、断って書き換えてもらうほうが安い。
 */
function containsHtmlTag(value: string): boolean {
  return /<[a-zA-Z/!]/.test(value);
}

function normalize(fields: TokushohoFields): TokushohoFields {
  const entries = TOKUSHOHO_FIELD_KEYS.map((key) => [key, fields[key].trim()] as const);
  return Object.fromEntries(entries) as unknown as TokushohoFields;
}
