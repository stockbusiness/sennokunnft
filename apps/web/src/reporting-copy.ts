import type { CreatorDirectoryRow, SalesReportRowDto } from '@sengoku/contracts';

/**
 * 運営の売上レポートと作家さまの一覧の文言（`UD-123` / `UD-124` の一部）。
 *
 * ⚠️ **「入金額」と書かない。** 決済事業者の手数料を引く前の値であって、
 * 入金額ではない。名前を間違えると、合わない額の原因を探す先を間違える。
 *
 * ⚠️ **「消費税」の欄を作らない**（`UD-401` 未決）。空欄はいつか埋められる。
 */
export const SALES_REPORT_COPY = {
  title: '売上',
  description:
    '日ごと・月ごとの販売額と返金額です。会計へお渡しする数字は、下の CSV から書き出せます。',

  /** ⚠️ ここがいちばん誤解されやすい。念を押して書く。 */
  notInflowWarning: 'ここに出ているのは入金額ではありません',
  notInflowHint:
    '決済事業者の手数料を引く前の金額です。実際の入金額との突き合わせは、まだこの画面ではできません。決済事業者の管理画面と合わせてご確認ください。',

  taxHint:
    '金額はすべて税込の合計です。消費税の内訳は、取り決めが決まっていないため出していません。',

  granularityDaily: '日ごと',
  granularityMonthly: '月ごと',

  columnPeriod: '期間',
  columnOrders: '件数',
  columnGross: '販売額（税込）',
  columnFee: '手数料',
  columnCreator: '作家さま配分',
  columnRefundCount: '返金件数',
  columnRefunded: '返金額',
  columnNet: '差引',

  totalsHeading: 'この期間の合計',
  csvLabel: 'CSV で書き出す',

  /*
    ⚠️ **売上と返金で数える日が違うことを、画面に書く。** 書かないと
       「返金した日の売上がマイナスになっている」と読まれる。
  */
  refundDayHint:
    '返金額は「返金が成立した日」で数えています。売れた日ではありません。過去の月の数字が、あとから変わらないようにするためです。',

  empty: 'この期間に記録はありません',
} as const;

export const CREATOR_DIRECTORY_COPY = {
  title: '作家さま',
  description: '作品を出してくださっている方の一覧です。売上の多い順に並びます。',

  searchLabel: 'お名前・ショップ名でさがす',
  searchSubmit: 'さがす',

  /** ⚠️ 黙って切らない。上限に達したことを画面から伝える。 */
  limited: (limit: number): string =>
    `${String(limit)} 件まで表示しています。絞り込んでお探しください。`,

  columnName: 'お名前',
  columnArtworks: '作品',
  columnListings: '販売中',
  columnOrders: 'ご注文',
  columnGross: '販売額（税込）',
  columnRefunded: '返金額',
  columnLastSold: '最後に売れた日',
  columnPayoutAccount: 'お振込先',
  columnSalesTerms: '販売規約',

  payoutAccountRegistered: 'ご登録あり',
  payoutAccountMissing: '未登録',
  /*
    ⚠️ **ここに口座の値を出さない。** 出るのは「預かってあるか」まで。
       読むのは精算の画面から（権限と記録が要る）。
  */
  payoutAccountHint:
    'お振込先の内容は、この画面には出ません。お振込のときに、精算の画面から表示してください。',

  salesTermsAccepted: '同意済み',
  salesTermsPending: '未同意',
  salesTermsHint:
    '未同意の方には、まだお支払いできません。作家さまご自身にご同意いただく必要があります。',

  noName: '（お名前の登録がありません）',
  empty: 'まだ作品を出された方はいません',

  detailHeading: 'この方について',
  bioLabel: '紹介文',
  invoiceLabel: 'インボイス登録番号',
  /*
    ⚠️ **「確認済み」と書かない。** 形（`T` + 13 桁）しか確かめていない。
       実在は国税庁の公表サイトでしか分からない。
  */
  invoiceHint: '形だけを確かめています。実在するかは国税庁の公表サイトでご確認ください。',
  payoutsHeading: '最近の精算',
  payoutsEmpty: 'まだ精算はありません',

  /*
    ⚠️ **止める口を作っていないことを、画面で伝える。** 「探しても無い」
       と思われるより、「無い」と書いてあるほうが早い。
  */
  noSuspendNotice: 'この画面から、作家さまの出品を止めることはできません',
  noSuspendHint:
    '止めたときにご注文や発行待ちの受取権をどう扱うかが決まっていないため、まだ作っていません。急ぎの場合は、作品ごとに公開を止めてください。',

  backLink: '作家さまの一覧へ戻る',
} as const;

/** 金額の表示。⚠️ マイナスを隠さない（返金だけの期間はマイナスになる）。 */
export function formatSignedYen(amount: number): string {
  const formatted = Math.abs(amount).toLocaleString('ja-JP');
  return amount < 0 ? `−${formatted} 円` : `${formatted} 円`;
}

export function salesRowIsEmpty(row: SalesReportRowDto): boolean {
  return row.orderCount === 0 && row.refundCount === 0;
}

/** 販売規約への同意の有無。⚠️ `null` は「まだ」であって「不明」ではない。 */
export function creatorSalesTermsLabel(row: CreatorDirectoryRow): string {
  return row.salesTermsAcceptedAt === null
    ? CREATOR_DIRECTORY_COPY.salesTermsPending
    : CREATOR_DIRECTORY_COPY.salesTermsAccepted;
}
