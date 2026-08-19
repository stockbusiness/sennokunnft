import {
  LEGAL_BODY_MAX,
  LEGAL_DOCUMENT_KINDS,
  LEGAL_TITLE_MAX,
  TOKUSHOHO_FIELD_KEYS,
  TOKUSHOHO_FIELD_MAX,
} from '@sengoku/domain';
import { renderLegalBody } from '@sengoku/domain';
import type { LegalBlock, LegalDocumentKind } from '@sengoku/domain';

/*
  ⚠️ **web はドメインへ直接依存できない**（`check:deps` の許可表）。
     本文の組み直しは画面が要るので、契約の側から通す。
     ここで書き直さないこと。書き直すと、管理画面の下書きと公開ページで
     見出しの解釈が食い違う。
*/
export { renderLegalBody };
export type { LegalBlock, LegalDocumentKind };
import { z } from '@sengoku/validation';

/**
 * 法務文書（利用規約・プライバシーポリシー・特商法表記）の契約。
 *
 * ⚠️ **ドメインから引く。書き写さない。** 種類・上限を二重に持つと、
 * 片方だけ直したときに「保存できるのに公開できない」が起きる。
 */

export const LEGAL_DOCUMENT_KIND_VALUES = LEGAL_DOCUMENT_KINDS;
export const LEGAL_VERSION_STATUS_VALUES = ['draft', 'published'] as const;

/*
  ⚠️ **HTML を弾くのは、保存の入口でも行う。** ドメインでも弾いているが、
     契約でも弾く。二重に見えるが、片方は「受け付けない」を相手へ
     伝えるためのもので、もう片方は経路が増えたときの最後の砦。
*/
const NO_HTML = /^[^<]*$/;

const bodyTextSchema = z.string().max(LEGAL_BODY_MAX).regex(NO_HTML, 'html is not allowed');

const tokushohoFieldSchema = z
  .string()
  .max(TOKUSHOHO_FIELD_MAX)
  .regex(NO_HTML, 'html is not allowed');

export const tokushohoFieldsSchema = z.object(
  Object.fromEntries(TOKUSHOHO_FIELD_KEYS.map((key) => [key, tokushohoFieldSchema])) as Record<
    (typeof TOKUSHOHO_FIELD_KEYS)[number],
    typeof tokushohoFieldSchema
  >,
);
export type TokushohoFieldsInput = z.infer<typeof tokushohoFieldsSchema>;

export const legalVersionSchema = z.object({
  id: z.string(),
  kind: z.enum(LEGAL_DOCUMENT_KIND_VALUES),
  version: z.number().int(),
  status: z.enum(LEGAL_VERSION_STATUS_VALUES),
  title: z.string(),
  bodyText: z.string().nullable(),
  tokushoho: tokushohoFieldsSchema.nullable(),
  effectiveFrom: z.string().nullable(),
  /** この版から再同意を求めるか（`UD-126`）。 */
  requiresReconsent: z.boolean(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  /**
   * いま施行されている版か。
   *
   * ⚠️ **保存されている値ではない。** 施行日と現在時刻から毎回決める。
   * 状態として持つと、日付が来ても切り替わらない食い違いが生まれる。
   */
  isEffective: z.boolean(),
  /** 公開に足りていない項目の名前。⚠️ 値は含めない。 */
  missingFields: z.array(z.string()),
});
export type LegalVersionView = z.infer<typeof legalVersionSchema>;

export const legalVersionListResponseSchema = z.object({
  kind: z.enum(LEGAL_DOCUMENT_KIND_VALUES),
  versions: z.array(legalVersionSchema),
});
export type LegalVersionListResponse = z.infer<typeof legalVersionListResponseSchema>;

/**
 * 公開ページが読む形。
 *
 * ⚠️ **下書きを出さない。** 施行中の版が無ければ `version` は `null`。
 * 空の文書を作って取り繕わない。何も無いことが分かるほうがよい。
 */
export const publicLegalDocumentSchema = z.object({
  kind: z.enum(LEGAL_DOCUMENT_KIND_VALUES),
  version: legalVersionSchema.nullable(),
});
export type PublicLegalDocument = z.infer<typeof publicLegalDocumentSchema>;

export const saveLegalDraftRequestSchema = z
  .object({
    title: z.string().min(1).max(LEGAL_TITLE_MAX).regex(NO_HTML, 'html is not allowed'),
    bodyText: bodyTextSchema.nullish(),
    tokushoho: tokushohoFieldsSchema.nullish(),
  })
  .strict();
export type SaveLegalDraftRequest = z.infer<typeof saveLegalDraftRequestSchema>;

export const publishLegalVersionRequestSchema = z
  .object({
    /**
     * 施行日時（ISO 8601）。
     *
     * ⚠️ **必須にする。** 既定を「いま」にすると、確認せずに押した公開が
     * その場で効いてしまう。いつから効くのかを毎回書かせる。
     */
    effectiveFrom: z.string().datetime(),
    /**
     * この版から、利用者へもう一度同意を求めるか（`UD-126`）。
     *
     * ⚠️ **既定は false。** 誤字を直しただけの改定で全員を止めると、
     * 同意の画面が「とりあえず押すもの」になり、同意という記録の意味が
     * 薄れる。実質的な変更かどうかは、公開する人が決める。
     */
    requiresReconsent: z.boolean().default(false),
  })
  .strict();
export type PublishLegalVersionRequest = z.infer<typeof publishLegalVersionRequestSchema>;

/**
 * 同意の状態（`UD-126`）。
 *
 * ⚠️ **同意を求めるのは利用規約だけ。** プライバシーポリシーを同じ
 * チェックへ束ねない。個人情報保護法では利用目的は原則「公表」で足り、
 * 「同意」が要るのは第三者提供などの場面。
 */
export const legalConsentStatusSchema = z.object({
  required: z.boolean(),
  /**
   * なぜそう判定したか。
   *
   * ⚠️ `no_document` は「規約をまだ公開していない」。このとき同意は
   * 求めない。求めると、規約を公開する人自身がログインできなくなる。
   */
  reason: z.enum(['no_document', 'already_consented', 'never_consented', 'reconsent']),
  /** 同意を求める対象の版。求めないときは `null`。 */
  version: legalVersionSchema.nullable(),
  /** その人が最後に同意した版番号。まだ無ければ `null`。 */
  consentedVersion: z.number().int().nullable(),
});
export type LegalConsentStatus = z.infer<typeof legalConsentStatusSchema>;

export const recordConsentRequestSchema = z
  .object({
    /**
     * 同意する版の ID。
     *
     * ⚠️ **画面が見ていた版を送らせる。** サーバー側で「いまの版」に
     * 差し替えると、利用者が読んだものと記録が食い違う。読んだものと
     * 違う版に同意させないため、食い違えば断る。
     */
    versionId: z.string().min(1),
  })
  .strict();
export type RecordConsentRequest = z.infer<typeof recordConsentRequestSchema>;
