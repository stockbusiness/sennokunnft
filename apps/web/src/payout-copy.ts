import type { PayoutViewDto } from '@sengoku/contracts';

/**
 * 精算の画面文言（`UD-119`）。
 *
 * ⚠️ **「支払い済みにする」は「振り込んだ」という宣言である。** 押しても
 * 振込は起きない。ここを曖昧に書くと、押せば振り込まれると思われる。
 */
export const PAYOUT_COPY = {
  title: '作家さまへのお支払い',
  description:
    '月末で締めて、翌月末にお支払いします。返金をお受けする期間が終わったご注文だけが対象です。',

  closeHeading: '締める',
  closeHint:
    'その月の売上を集計して、作家さまごとの下書きを作ります。何度押しても下書きは 1 件のままです。確定済みのものは作り直しません。',
  periodLabel: '締め月',
  periodPlaceholder: '2026-08',
  submitClose: 'この月を締める',
  closing: '集計しています…',
  closed: (count: number): string => `${String(count)} 件の下書きを作りました。`,

  listHeading: 'これまでの精算',
  listEmpty: 'まだ精算はありません',

  statusDraft: '下書き',
  statusConfirmed: '確定済み（未払い）',
  statusPaid: 'お支払い済み',

  fieldPeriod: '締め月',
  fieldDueAt: 'お支払いの期日',
  fieldGross: '販売額',
  fieldFee: '手数料',
  fieldRefunded: '差し戻し',
  fieldCarriedIn: '前月からの繰越',
  fieldNet: '今回のお支払額',
  fieldCarriedOut: '翌月への繰越',
  fieldMinimum: '最低支払額（当時）',
  fieldBearer: '振込手数料（当時）',
  bearerCreator: '作家さま負担',
  bearerPlatform: '当方負担',
  fieldLines: '明細',

  /** ⚠️ 待てば通ることを伝える。伝えないと毎日押して確かめることになる。 */
  windowOpen: (count: number): string =>
    `返金をお受けする期間が終わっていないご注文が ${String(count)} 件あります`,
  windowOpenHint: '期間が過ぎると確定できるようになります。それまでお待ちください。',

  submitConfirm: 'この内容で確定する',
  confirming: '確定しています…',
  confirmed: '確定しました。お振込のうえ、「お支払い済みにする」を押してください。',
  confirmWarning: '確定した内容は変更できません',
  confirmHint:
    '確定後に金額が変わると、作家さまへお渡しした明細と食い違います。訂正は翌月の精算での調整として行います。',

  submitMarkPaid: 'お支払い済みにする',
  markingPaid: '記録しています…',
  paid: 'お支払い済みとして記録しました。',
  /** ⚠️ ここがいちばん誤解されやすい。押しても振込は起きない。 */
  markPaidWarning: 'この操作では振込は行われません',
  markPaidHint:
    '実際にお振込を済ませてから押してください。押すと「お支払い済み」として記録され、作家さまにもそう見えます。',

  linesHeading: '明細（ご注文ごと）',
  clawbackLabel: '差し戻し',
  clawbackHint: '確定済みの精算に含まれていたご注文が、あとから返金されたぶんです。',

  errorUnauthorized:
    '権限が無いか、ログインしてから時間が経っています。「お支払い済みにする」はオーナーの方が、ログインし直してからお試しください。',
} as const;

export function payoutStatusLabel(status: PayoutViewDto['status']): string {
  if (status === 'paid') return PAYOUT_COPY.statusPaid;
  if (status === 'confirmed') return PAYOUT_COPY.statusConfirmed;
  return PAYOUT_COPY.statusDraft;
}

export function payoutStatusTone(
  status: PayoutViewDto['status'],
): 'neutral' | 'progress' | 'success' {
  if (status === 'paid') return 'success';
  if (status === 'confirmed') return 'progress';
  return 'neutral';
}

export function transferFeeBearerLabelForPayout(
  bearer: PayoutViewDto['transferFeeBearer'],
): string {
  return bearer === 'creator' ? PAYOUT_COPY.bearerCreator : PAYOUT_COPY.bearerPlatform;
}
