import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type { OrderPaymentStatus, OrderStatus } from './order-status';
import { ORDER_NUMBER_PATTERN } from './order-number';

/**
 * 注文の検索（`UD-121`）。
 *
 * 問い合わせは「注文番号を控えていない」ところから始まることが多い。
 * 「先週、これくらいの金額で、この作品を買った」から辿れないと、
 * 電話口で待たせたまま何も返せない。
 *
 * ⚠️ **探せることと、並べて見えることは別**（`ADMIN_OPERATIONS_GAP.md` §3-C）。
 * ここが決めるのは絞り込みの条件だけで、一覧に何を出すかは別の話。
 * 購入者の情報を一覧へ足すために、この型を広げないこと。
 *
 * ⚠️ **平文のメールアドレスを条件に持たない**（`UD-503`）。持つのは
 * 照合用に変換したあとの値で、変換は API の入口で 1 回だけ行う。
 */

/** 作品名の部分一致に要る最短の長さ。 */
const MIN_TITLE_QUERY_LENGTH = 2;
const MAX_TITLE_QUERY_LENGTH = 100;

/** 注文番号の末尾（乱数部）の長さ。電話で聞き取るのはここだけのことが多い。 */
const ORDER_NUMBER_SUFFIX_LENGTH = 8;
const ORDER_NUMBER_SUFFIX_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

/**
 * 運用のタイムゾーン（JST）の時差（分）。
 *
 * ⚠️ **保存は UTC、運用は JST**（コーディング規約）。日付だけで
 * 絞り込むとき、どちらで日付を区切るかで結果が変わる。8/19 の朝 8 時
 * （JST）に届いた注文は UTC では 8/18 で、UTC で区切ると「8/19 から」の
 * 検索に出てこない。**運用の人が見ている日付**で区切る。
 *
 * ⚠️ 日本は夏時間を採らないので固定値でよい。他の時差を扱う日が来たら、
 * ここを設定へ出す（そのときまで設定にしない）。
 */
const JST_OFFSET_MINUTES = 9 * 60;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface OrderSearchInput {
  readonly orderNumber?: string | undefined;
  /** JST の日付（`YYYY-MM-DD`）。その日の 00:00（JST）から。 */
  readonly createdFrom?: string | undefined;
  /**
   * JST の日付（`YYYY-MM-DD`）。**その日の終わりまで**を含む。
   *
   * ⚠️ 「まで」に指定した日の注文が出てこないのは、探す側からは
   * ただの不具合に見える。境界の解釈はここ 1 か所に置く。
   */
  readonly createdTo?: string | undefined;
  readonly minTotalAmount?: number | undefined;
  readonly maxTotalAmount?: number | undefined;
  readonly artworkTitle?: string | undefined;
  readonly status?: OrderStatus | undefined;
  readonly paymentStatus?: OrderPaymentStatus | undefined;
  /** ⚠️ 変換済みの照合値。平文を入れない（`UD-503`）。 */
  readonly emailHash?: string | undefined;
}

/**
 * 注文番号の探し方。
 *
 * ⚠️ **末尾だけの一致を用意してある。** 電話で読み上げてもらうと
 * `SNK-` と日付は飛ばされ、末尾 8 文字しか手元に残らないことが多い。
 * 完全一致しか無いと、そこで手が止まる。
 */
export type OrderNumberMatch =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'suffix'; readonly value: string };

export interface OrderSearchCriteria {
  readonly orderNumber: OrderNumberMatch | null;
  readonly createdFrom: Date | null;
  readonly createdTo: Date | null;
  readonly minTotalAmount: number | null;
  readonly maxTotalAmount: number | null;
  readonly artworkTitle: string | null;
  readonly status: OrderStatus | null;
  readonly paymentStatus: OrderPaymentStatus | null;
  readonly emailHash: string | null;
}

/** 条件が 1 つも無い検索。⚠️ これは誤りではなく、ただの一覧。 */
export const EMPTY_ORDER_SEARCH: OrderSearchCriteria = {
  orderNumber: null,
  createdFrom: null,
  createdTo: null,
  minTotalAmount: null,
  maxTotalAmount: null,
  artworkTitle: null,
  status: null,
  paymentStatus: null,
  emailHash: null,
};

/**
 * 入力を検索条件へそろえる。
 *
 * ⚠️ **矛盾した条件を通さない。** 「10 日から 3 日まで」「1000 円以上
 * 500 円以下」は、必ず 0 件になる。0 件を返すと、探し方が悪いのか
 * 本当に無いのかが分からず、同じ検索を何度も繰り返すことになる。
 */
export function normalizeOrderSearch(
  input: OrderSearchInput,
): Result<OrderSearchCriteria, DomainError> {
  const orderNumber = normalizeOrderNumberQuery(input.orderNumber);
  if (!orderNumber.ok) {
    return orderNumber;
  }

  const from = parseJstDate(input.createdFrom, 'start');
  if (!from.ok) {
    return from;
  }
  const to = parseJstDate(input.createdTo, 'end');
  if (!to.ok) {
    return to;
  }
  const createdFrom = from.value;
  const createdTo = to.value;
  if (createdFrom !== null && createdTo !== null && createdFrom.getTime() > createdTo.getTime()) {
    return err(domainError('ORDER_SEARCH_INVALID', 'period reversed'));
  }

  const min = input.minTotalAmount ?? null;
  const max = input.maxTotalAmount ?? null;
  for (const amount of [min, max]) {
    if (amount !== null && (!Number.isInteger(amount) || amount < 0)) {
      // ⚠️ 金額は円の整数（コーディング規約）。小数を通すと、
      //    比較のたびに端数の扱いを決めることになる。
      return err(domainError('ORDER_SEARCH_INVALID', 'amount not a non-negative integer'));
    }
  }
  if (min !== null && max !== null && min > max) {
    return err(domainError('ORDER_SEARCH_INVALID', 'amount range reversed'));
  }

  const artworkTitle = normalizeTitleQuery(input.artworkTitle);
  if (!artworkTitle.ok) {
    return artworkTitle;
  }

  const emailHash = input.emailHash ?? null;

  return ok({
    orderNumber: orderNumber.value,
    createdFrom,
    createdTo,
    minTotalAmount: min,
    maxTotalAmount: max,
    artworkTitle: artworkTitle.value,
    status: input.status ?? null,
    paymentStatus: input.paymentStatus ?? null,
    emailHash,
  });
}

/** 条件が 1 つでも指定されているか。画面の文言を分けるために使う。 */
export function hasSearchCriteria(criteria: OrderSearchCriteria): boolean {
  return Object.values(criteria).some((value) => value !== null);
}

function normalizeOrderNumberQuery(
  raw: string | undefined,
): Result<OrderNumberMatch | null, DomainError> {
  if (raw === undefined) {
    return ok(null);
  }
  // ⚠️ 空白と大文字小文字だけを吸収する。読み違えやすい字
  //    （`0/O`・`1/I/L`）の読み替えはしない。読み替えると、
  //    打ち間違いが「別の実在する注文」に化ける。
  const value = raw.trim().toUpperCase().replace(/\s+/gu, '');
  if (value.length === 0) {
    return ok(null);
  }
  if (ORDER_NUMBER_PATTERN.test(value)) {
    return ok({ kind: 'exact', value });
  }
  if (value.length === ORDER_NUMBER_SUFFIX_LENGTH && ORDER_NUMBER_SUFFIX_PATTERN.test(value)) {
    return ok({ kind: 'suffix', value });
  }
  return err(domainError('ORDER_SEARCH_INVALID', 'order number shape'));
}

function normalizeTitleQuery(raw: string | undefined): Result<string | null, DomainError> {
  if (raw === undefined) {
    return ok(null);
  }
  const value = raw.trim();
  if (value.length === 0) {
    return ok(null);
  }
  if (value.length < MIN_TITLE_QUERY_LENGTH) {
    // ⚠️ 1 文字を通さない。ほぼ全件に当たり、絞り込みにならないまま
    //    表を舐めることになる。
    return err(domainError('ORDER_SEARCH_INVALID', 'title query too short'));
  }
  if (value.length > MAX_TITLE_QUERY_LENGTH) {
    return err(domainError('ORDER_SEARCH_INVALID', 'title query too long'));
  }
  return ok(value);
}

/**
 * JST の日付を、その日の始まり／終わりの瞬間へ変換する。
 *
 * ⚠️ **`new Date('2026-08-19')` を使わない。** あれは UTC の 00:00 と
 * 解釈される。JST で見ている人には 9 時間ずれ、8/19 の朝に届いた注文が
 * 「8/19 から」の検索から漏れる。
 */
function parseJstDate(
  raw: string | undefined,
  edge: 'start' | 'end',
): Result<Date | null, DomainError> {
  if (raw === undefined) {
    return ok(null);
  }
  const value = raw.trim();
  if (value.length === 0) {
    return ok(null);
  }
  if (!DATE_ONLY_PATTERN.test(value)) {
    return err(domainError('ORDER_SEARCH_INVALID', 'date shape'));
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return err(domainError('ORDER_SEARCH_INVALID', 'date shape'));
  }
  // JST の 00:00 は UTC の前日 15:00。終わりは翌日の 00:00 の 1 ミリ秒前。
  const startUtcMs = Date.UTC(year, month - 1, day) - JST_OFFSET_MINUTES * 60_000;
  const instant = new Date(edge === 'start' ? startUtcMs : startUtcMs + 86_400_000 - 1);
  if (Number.isNaN(instant.getTime())) {
    return err(domainError('ORDER_SEARCH_INVALID', 'date invalid'));
  }
  // ⚠️ `Date.UTC` は 2026-02-31 を 3/3 へ繰り上げる。繰り上がった日付を
  //    黙って受け入れると、打ち間違いが「別の期間の検索」になる。
  const normalized = new Date(startUtcMs + JST_OFFSET_MINUTES * 60_000);
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + 1 !== month ||
    normalized.getUTCDate() !== day
  ) {
    return err(domainError('ORDER_SEARCH_INVALID', 'date out of range'));
  }
  return ok(instant);
}
