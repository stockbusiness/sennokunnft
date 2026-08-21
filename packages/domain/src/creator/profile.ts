/**
 * 作家さまのプロフィール（実運営 指示書 P1-2）。
 *
 * **買う人は「誰が作ったのか」を見てから決める。** 名前だけの一行しか
 * 無いと、その判断ができない。
 *
 * ⚠️ **表示名（`accounts.display_name`）とは別に持つ。** あちらは
 * **一意である必要がある**（なりすまし防止・`UD-102`）。こちらは
 * 紹介文や画像で、一意性とは関係がない。同じ表に混ぜると、紹介文を
 * 直すたびに一意性の検査が走る。
 *
 * ⚠️ **HTML を保存しない。** 紹介文は本文として扱う。保存の時点で断る
 * （法務文書と同じ扱い）。作家さまが書いた `<script>` が、買う人の
 * ブラウザで動いてよい理由は無い。
 */

/** 紹介文の上限。⚠️ 長文の置き場にしない。 */
export const CREATOR_BIO_MAX_LENGTH = 2000;
/** 屋号・ショップ名の上限。 */
export const CREATOR_SHOP_NAME_MAX_LENGTH = 60;
/** SNS・Web サイトの登録数の上限。⚠️ 無制限にしない。 */
export const CREATOR_LINK_MAX_COUNT = 5;
export const CREATOR_LINK_LABEL_MAX_LENGTH = 30;

/**
 * インボイス（適格請求書発行事業者）の登録番号。
 *
 * ⚠️ **形だけを確かめる。** `T` + 13 桁の数字。実在するかどうかは
 * 国税庁の公表サイトでしか分からず、こちらでは確かめられない。
 * **確かめていないものを「確認済み」と表示しない。**
 */
export const INVOICE_NUMBER_PATTERN = /^T\d{13}$/;

export interface CreatorLink {
  /** 表示名（「X」「ホームページ」など）。 */
  readonly label: string;
  readonly url: string;
}

export interface CreatorProfileDraft {
  readonly shopName: string | null;
  readonly bio: string | null;
  readonly links: readonly CreatorLink[];
  readonly invoiceNumber: string | null;
}

export type ProfileRejection =
  | 'SHOP_NAME_TOO_LONG'
  | 'BIO_TOO_LONG'
  | 'BIO_CONTAINS_HTML'
  | 'TOO_MANY_LINKS'
  | 'LINK_LABEL_TOO_LONG'
  /** ⚠️ `https` 以外を受け取らない。 */
  | 'LINK_URL_NOT_ALLOWED'
  | 'INVOICE_NUMBER_MALFORMED';

export type ProfileDecision =
  | { readonly ok: true; readonly value: CreatorProfileDraft }
  | { readonly ok: false; readonly reason: ProfileRejection };

/**
 * 保存してよいか。
 *
 * ⚠️ **すべて任意。** 空でも保存できる。埋めないと売れない、という作りに
 * すると、作りたい人が最初の一歩で止まる。
 */
export function validateCreatorProfile(input: {
  readonly shopName: string | null;
  readonly bio: string | null;
  readonly links: readonly CreatorLink[];
  readonly invoiceNumber: string | null;
}): ProfileDecision {
  const shopName = normalize(input.shopName);
  if (shopName !== null && shopName.length > CREATOR_SHOP_NAME_MAX_LENGTH) {
    return { ok: false, reason: 'SHOP_NAME_TOO_LONG' };
  }

  const bio = normalize(input.bio);
  if (bio !== null && bio.length > CREATOR_BIO_MAX_LENGTH) {
    return { ok: false, reason: 'BIO_TOO_LONG' };
  }
  /*
    ⚠️ **タグらしきものを見つけたら断る。** 「消して保存する」にすると、
       書いた本人には消えたことが分からない。断って、書き直してもらう。
  */
  if (bio !== null && /<[^>]+>/.test(bio)) {
    return { ok: false, reason: 'BIO_CONTAINS_HTML' };
  }

  if (input.links.length > CREATOR_LINK_MAX_COUNT) {
    return { ok: false, reason: 'TOO_MANY_LINKS' };
  }
  const links: CreatorLink[] = [];
  for (const link of input.links) {
    const label = normalize(link.label);
    if (label !== null && label.length > CREATOR_LINK_LABEL_MAX_LENGTH) {
      return { ok: false, reason: 'LINK_LABEL_TOO_LONG' };
    }
    if (!isAllowedUrl(link.url)) {
      return { ok: false, reason: 'LINK_URL_NOT_ALLOWED' };
    }
    links.push({ label: label ?? link.url, url: link.url.trim() });
  }

  const invoiceNumber = normalize(input.invoiceNumber);
  if (invoiceNumber !== null && !INVOICE_NUMBER_PATTERN.test(invoiceNumber)) {
    return { ok: false, reason: 'INVOICE_NUMBER_MALFORMED' };
  }

  return { ok: true, value: { shopName, bio, links, invoiceNumber } };
}

/**
 * 受け取ってよい URL か。
 *
 * ⚠️ **`https` だけ。** `javascript:` は言うまでもなく、`http:` も断る。
 * 画面から辿る先が平文だと、そこで何が起きても分からない。
 */
function isAllowedUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalize(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 売る準備が整っているか。
 *
 * ⚠️ **ここで「売らせない」判定はしない。** 何が足りないかを並べるだけ。
 * 揃っていないと出品できない作りにすると、作りたい人が最初の一歩で止まる。
 * **足りないことを伝えるのと、止めるのは別**である。
 */
export const CREATOR_SETUP_KEYS = [
  /** 表示名（`UD-102`）。⚠️ 無いと買う人に誰の作品か伝わらない。 */
  'display_name',
  /** 販売規約への同意。 */
  'sales_terms_accepted',
  /** 振込先の登録。⚠️ **無いとお支払いできない。** */
  'payout_account',
  /** インボイスの登録番号。⚠️ 任意（免税事業者もいる）。 */
  'invoice_number',
] as const;
export type CreatorSetupKey = (typeof CREATOR_SETUP_KEYS)[number];

export interface CreatorSetupItem {
  readonly key: CreatorSetupKey;
  readonly label: string;
  readonly done: boolean;
  /** ⚠️ **任意のものは「済んでいない」でも支障がない。** 区別して出す。 */
  readonly required: boolean;
  readonly detail: string;
}

/**
 * 何が済んでいて、何が済んでいないか。
 *
 * ⚠️ **振込先は「まだこの仕組みに無い」。** 登録の口は P1-3。無いものを
 * 「未登録」と出すのは正しいが、**登録できるかのように見せない**。
 */
export function creatorSetupChecklist(input: {
  readonly hasDisplayName: boolean;
  readonly salesTermsAcceptedAt: Date | null;
  readonly hasPayoutAccount: boolean;
  readonly hasInvoiceNumber: boolean;
}): readonly CreatorSetupItem[] {
  return [
    {
      key: 'display_name',
      label: '作家名（表示名）',
      done: input.hasDisplayName,
      required: true,
      detail: input.hasDisplayName
        ? '登録済みです。'
        : '買ってくださる方に、どなたの作品かが伝わりません。',
    },
    {
      key: 'sales_terms_accepted',
      label: '販売規約への同意',
      done: input.salesTermsAcceptedAt !== null,
      required: true,
      detail:
        input.salesTermsAcceptedAt === null
          ? 'まだご同意いただいていません。'
          : 'ご同意いただいています。',
    },
    {
      key: 'payout_account',
      label: 'お振込先',
      done: input.hasPayoutAccount,
      required: true,
      detail: input.hasPayoutAccount
        ? '登録済みです。'
        : 'お振込先をお預かりする仕組みは準備中です。決まりましたらご案内します。',
    },
    {
      key: 'invoice_number',
      label: 'インボイス登録番号',
      done: input.hasInvoiceNumber,
      // ⚠️ 免税事業者もいる。無いことは不備ではない。
      required: false,
      detail: input.hasInvoiceNumber
        ? '登録済みです（実在の確認はしていません）。'
        : '課税事業者の方はご登録ください。免税事業者の方は不要です。',
    },
  ];
}
