import type { CustomerAttentionView, DuplicateCandidateView } from '@sengoku/contracts';
import type { StatusToneName } from '@sengoku/ui';

/**
 * 顧客サポートの言葉（P1-1）。
 *
 * ⚠️ **「同一人物」と書かない。** 重複は**候補**であって、確定していない。
 * 読み違えたまま判断されると、他人の持ち物を渡すことになる。
 *
 * ⚠️ **氏名とメールアドレスを出す前提の文言を書かない。** 本システムは
 * そもそも平文を持っていない（`UD-503`）。
 */
export const CUSTOMER_COPY = {
  title: 'お客さまのご状況',
  description:
    'お問い合わせの応対に使います。注文番号・ご連絡先・共通顧客ID のいずれかからお探しください。',
  searchHeading: 'お探しする',
  searchHint:
    'ご連絡先で探すと、お聞きしたアドレスを同じ手順で変換して照合します。アドレスそのものは保存も表示もされません。',
  noCriteria: '手がかりを 1 つ以上ご指定ください。',
  notFound: 'あてはまるお客さまが見つかりませんでした。',
  attentionHeading: '応対の前に',
  allClear: 'とくに申し送りはありません。',
  ordersHeading: 'ご注文',
  entitlementsHeading: 'お渡ししたもの',
  refundsHeading: 'ご返金',
  notesHeading: '申し送り',
  notesHint: '⚠️ 書いたものは消せません。追記だけができます。',
  duplicatesHeading: '同じ方かもしれないアカウント',
  /*
    ⚠️ **統合できると読ませない。** この画面にできるのは、並べて見せる
       ところまで。判断も手続きも人が行う。
  */
  duplicatesHint:
    '手がかりが一致しただけで、同じ方とは限りません。この画面から統合することはできません。',
  emailChangeHeading: 'ご連絡先の変更',
  /*
    ⚠️ **ここでアドレスが変わらないことを、画面にも書く。** 書かないと、
       押した運営が「変わったはず」と思って応対してしまう。
  */
  emailChangeHint:
    'この画面では、ご連絡先そのものは変わりません。本人確認の記録を残したうえで、認証基盤側で変更してください。',
  referralUnavailable: '代理店・紹介元の記録は、まだこの仕組みにありません（連携の準備中です）。',
} as const;

/** 応対の前に知っておくべきことの色。⚠️ 停止中だけを赤にする。 */
export function attentionTone(key: CustomerAttentionView['key']): StatusToneName {
  switch (key) {
    /*
      ⚠️ **停止中だけが赤。** ログインできない・買えないという
         お問い合わせの答えが、ここにある。
    */
    case 'account_suspended':
      return 'danger';
    case 'wallet_delivery_stalled':
    case 'common_user_unresolved':
      return 'warning';
    case 'unclaimed_entitlements':
    case 'refund_in_progress':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** 手がかりの言い換え。⚠️ 「同一人物」と書かない。 */
export function duplicateSignalLabel(signal: DuplicateCandidateView['signals'][number]): string {
  switch (signal) {
    case 'email_hash':
      return 'ご連絡先が一致';
    case 'common_user_id':
      return '共通顧客IDが一致';
    default:
      return signal;
  }
}

/** アカウントの状態。 */
export function accountStatusLabel(status: 'active' | 'suspended'): string {
  return status === 'active' ? 'ご利用中' : '停止中';
}

/** ご連絡先の変更申請の状態。⚠️ 「済」が何を意味するかを取り違えさせない。 */
export function emailChangeStatusLabel(status: string): string {
  switch (status) {
    case 'requested':
      return 'お申し出を受付';
    case 'identity_verified':
      return '本人確認済み（未変更）';
    case 'completed':
      return '変更済み';
    case 'rejected':
      return '見送り';
    default:
      return status;
  }
}

export function emailChangeStatusTone(status: string): StatusToneName {
  switch (status) {
    case 'completed':
      return 'success';
    case 'identity_verified':
      return 'progress';
    case 'rejected':
      return 'neutral';
    default:
      return 'warning';
  }
}

/** 本人確認の方法。⚠️ 何をしたのかが、あとから読んで分かる言葉にする。 */
export function verificationMethodLabel(method: string | null): string {
  switch (method) {
    case 'existing_contact_reply':
      return '登録済みのご連絡先への確認に、ご返信をいただいた';
    case 'order_details_match':
      return 'ご注文の内容を照合した';
    case 'identity_document':
      return '本人確認書類を確認した（書類は保存していません）';
    case null:
      return '—';
    default:
      return method;
  }
}

/** 返金の理由。⚠️ 内部の語彙をそのまま出さない。 */
export function refundReasonLabel(reason: string): string {
  switch (reason) {
    case 'buyer_request':
      return 'お客さまのご希望';
    case 'our_fault':
      return 'こちらの不手際';
    case 'provider_initiated':
      return '決済事業者から';
    default:
      return reason;
  }
}

/** 金額。⚠️ 円で出す。桁区切りを入れる。 */
export function formatYen(amount: number): string {
  return `${amount.toLocaleString('ja-JP')} 円`;
}

/** 日時。⚠️ JST で出す。 */
export function formatJst(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const jst = new Date(date.getTime() + 9 * 60 * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(jst.getUTCFullYear())}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

/** アカウントIDの見分けがつく範囲。⚠️ 全部出しても読めない。 */
export function shortId(value: string): string {
  return value.slice(0, 8);
}
