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

  negativeHeading: 'お戻しが残っている作家さま',
  /*
    ⚠️ **「取り立てる」と書かない。** 請求書を出す仕組みは作っていない。
       ここは気づくための一覧で、額が大きいときに個別にご相談する。
  */
  negativeHint:
    'お支払いのあとに返金が起きて、次の売上から引ききれなかった分です。次に売れたときに差し引かれます。額が大きい場合や、長く残っている場合は、個別にご相談ください。',
  negativeEmpty: 'お戻しが残っている作家さまはいません',
  negativeAmount: '残っている額',
  negativeSince: 'いつから',
  negativePeriod: '最後の精算',

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

  /* --- お振込先（決定 2026-08-21）--- */

  accountHeading: 'お振込先',
  /**
   * ⚠️ **「確認済み」と書かない。** 確かめてあるのは形だけで、口座が
   * 実在するかは振込を試みたときに初めて分かる（P1-3 と同じ考え方）。
   */
  accountRegistered: 'ご登録いただいています',
  accountMissing: 'まだご登録いただいていません',
  accountMissingHint:
    'このままでは振り込めません。作家さまご自身に、マイページの「お振込先」からご登録いただいてください。⚠️ お電話やメールで口座を伺わないでください——お預かりする場所がありません。',
  accountUnavailable: 'この配備では、お振込先をお預かりできません',
  accountUnavailableHint: '暗号鍵が設定されていません。設定が要る旨を運用担当へお伝えください。',

  revealButton: 'お振込先を表示する',
  revealAgainButton: 'もう一度表示する',
  revealing: '読み取っています…',
  /**
   * ⚠️ **押す前に、記録が残ることを伝える。** 伝えずに残すと、
   * 「見られていると思わなかった」が生まれる。
   */
  revealNotice:
    '⚠️ 表示すると、どなたが・いつ・どの精算のために見たかが記録に残ります。お振込のときにお使いください。',
  revealNotPayableYet: '確定してから表示できます',
  revealNotPayableYetHint:
    'お振込先は、お振込のために読むものです。下書きのうちは開きません。まず内容を確かめて確定してください。',
  revealUndecipherable: 'お振込先を読み取れませんでした',
  /** ⚠️ **ここでいちばん大事なのは「振り込まないこと」。** */
  revealUndecipherableHint:
    '⚠️ このままお振込にならないでください。暗号鍵の入れ替えを誤ったか、記録が差し替えられた疑いがあります。運用担当へお伝えのうえ、作家さまに登録し直していただいてください。',

  accountFieldBank: '金融機関',
  accountFieldBranch: '支店',
  accountFieldType: '預金種別',
  accountFieldNumber: '口座番号',
  accountFieldHolder: '口座名義（カナ）',
  accountFieldUpdatedAt: 'ご登録の日時',
  /**
   * ⚠️ **直前に変わっていれば疑う手掛かりになる。** 乗っ取りは、
   * お支払いの直前に差し替えるのがいちばん実入りがよい。
   */
  accountUpdatedAtHint:
    'お振込の直前に変わっている場合は、作家さまご本人に心当たりがあるかお確かめください。',
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

/**
 * 預金種別の呼び名。
 *
 * ⚠️ **通帳の表記に合わせる。** `ordinary` / `checking` のまま出すと、
 * 振込の依頼書と突き合わせられない。
 *
 * ⚠️ **ドメイン層の同名関数を web から呼ばない**（`@sengoku/web` は
 * `@sengoku/domain` へ依存しない）。値の集合は契約側で固定してある。
 */
export function payoutAccountTypeLabel(type: 'ordinary' | 'checking'): string {
  return type === 'ordinary' ? '普通' : '当座';
}
