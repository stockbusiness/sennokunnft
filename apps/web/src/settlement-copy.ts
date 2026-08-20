import type { SettlementSettingsView } from '@sengoku/contracts';
import type { AdminFailureReason } from './admin-copy';
import { adminErrorMessage } from './admin-copy';

/**
 * 返金と精算の設定の画面文言（`UD-104` / `UD-119`）。
 *
 * ⚠️ **「変えられる」ことと「過去に効く」ことを取り違えさせない。**
 * ここで直せるのは**これからのご注文**だけで、すでに頂いたご注文の
 * 返金期限も、確定した精算の内訳も動かない
 * （`docs/SETTLEMENT_AND_REFUND.md` §1）。画面でそう言い切っておかないと、
 * 「日数を延ばせば先月の分も返金できる」と思ったまま操作されてしまう。
 */
export const SETTLEMENT_COPY = {
  title: '返金と精算の取り決め',
  description:
    'ご購入者さまからの返金を受け付ける期間と、作家さまへのお支払いの条件です。オーナーだけが変更できます。',

  /** ⚠️ いちばん先に出す。取り違えたときの影響がいちばん大きい。 */
  scopeTitle: 'ここでの変更は、これからのご注文にだけ効きます',
  scopeHint:
    'すでにお支払いいただいたご注文の返金期限は、そのご注文にお支払いの時点で書き留めてあります。日数を変えても、過去のご注文の期限は動きません。確定した精算の内訳も同じです。',

  unsetTitle: 'まだ取り決めが登録されていません',
  unsetHint:
    'この環境では返金と精算の条件が未設定です。設定するまで、返金の期限をご注文へ書き留められません。下の欄からご登録ください。',

  currentHeading: 'いまの取り決め',
  editHeading: '取り決めを変える',

  fieldRefundWindow: '返金を受け付ける日数',
  fieldRefundWindowHint:
    'お支払いが済んだ日から数えます。0 と入れると「ご購入者さまからのお申し出による返金を受け付けない」という意味になります（当方の不具合による返金は、この日数にかかわらずお受けします）。0〜180 日。',
  fieldPayoutOffset: '精算の猶予（月数）',
  fieldPayoutOffsetHint:
    '1 なら「月末締め・翌月末払い」です。⚠️ 返金を受け付ける日数より長くしてください。短いと、お支払い済みのご注文があとから返金され、作家さまへ返金分をお返しいただく作業が毎月発生します。0〜6 か月。',
  fieldMinimumPayout: '最低支払額（円）',
  fieldMinimumPayoutHint:
    'この額に満たない月は、翌月へ繰り越します。振込手数料が売上を上回るのを防ぐためです。0〜100,000 円。',
  fieldTransferFeeBearer: '振込手数料の負担',
  bearerCreator: '作家さま（お支払い額から差し引く）',
  bearerPlatform: '当方（差し引かない）',

  submit: 'この内容に変える',
  submitting: '保存しています…',
  saved: '保存しました。これからのご注文に使われます。',
  savedHint: 'すでに頂いているご注文の返金期限と、確定した精算の内訳は変わりません。',

  /**
   * ⚠️ **401 を「権限がありません」だけで済ませない。** この口はオーナー
   * 限定かつ再認証つきなので、断られる理由は「権限が無い」と「ログインから
   * 時間が経った」の 2 通りある。API は区別できる符号を返さない（どちらも
   * 401）ので、こちらも決めつけずに両方を書く。
   */
  errorUnauthorized:
    '権限が無いか、ログインしてから時間が経っています。オーナーの方が、ログインし直してからお試しください。',
} as const;

/**
 * 断られたときの言葉。
 *
 * ⚠️ **どの項目が範囲外だったかを断定しない。** API は符号しか返さない
 * （本文には内部の詳細が混ざりうる）ので、確かめる先を案内するに留める。
 */
export function settlementError(code: string | undefined, reason: AdminFailureReason): string {
  if (code === 'SETTLEMENT_SETTINGS_INVALID') {
    return 'この内容では保存できません。それぞれの欄の範囲に収まっているか、返金を受け付ける日数が精算の猶予を超えていないかをご確認ください。';
  }
  if (reason === 'unauthorized') {
    return SETTLEMENT_COPY.errorUnauthorized;
  }
  return adminErrorMessage(reason, code);
}

export function transferFeeBearerLabel(
  bearer: SettlementSettingsView['transferFeeBearer'],
): string {
  return bearer === 'creator' ? SETTLEMENT_COPY.bearerCreator : SETTLEMENT_COPY.bearerPlatform;
}
