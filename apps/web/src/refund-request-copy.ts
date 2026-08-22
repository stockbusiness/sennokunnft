import type { RefundRequestStatus, RefundRequestReason } from '@sengoku/contracts';
import type { StatusToneName } from '@sengoku/ui';

/**
 * 返金の申請と審査の画面文言（方針整理 2026-08-22）。
 *
 * ⚠️ **作家さまの画面に「返金する」という言葉を出さない。** 作家さまが
 * 返金を実行する口はこの仕組みに存在しない。言葉だけ置くと、押せば返せると
 * 思われる——そして「押しても動かない」と言われて、動くように直そうという
 * 話になる。
 *
 * ⚠️ **購入者へ「返金します」と読める言い方をしない。** 申し出は申し出で、
 * 返るかどうかは審査が決める。受け付けた時点で約束したことにしない。
 */

export const REFUND_REQUEST_COPY = {
  /* --- 運営 -------------------------------------------------------------- */
  adminTitle: '返金のお申し出',
  adminDescription:
    'お客さまからのお申し出と、運営が代わりにお受けしたものが並びます。事由によっては作家さまへ事実をお伺いしてから、運営が可否を決めます。',

  listHeading: 'お申し出の一覧',
  listEmpty: 'まだお申し出はありません',
  filterStatus: '状態でしぼる',
  filterAll: 'すべて',

  detailHeading: 'お申し出の内容',
  fieldOrder: 'ご注文',
  fieldReason: '事由',
  fieldCategory: '取り扱い',
  fieldAmount: 'お申し出の金額',
  fieldRemaining: 'このご注文でお返しできる残り',
  fieldDisposition: 'デジタル会員証',
  fieldRequestedBy: 'お申し出',
  fieldReviewedBy: '調べた人',
  fieldApprovedBy: '承認した人',
  fieldCreatedAt: 'お受けした日時',
  fieldUpdatedAt: '最後に動いた日時',

  buyerStatementHeading: 'お客さまからの経緯',
  buyerStatementEmpty: 'ご記入はありません',
  noteHeading: '運営の記録',
  noteEmpty: 'まだ記録はありません',
  /** ⚠️ 運営の記録は購入者へ出さない。画面上でも別の節に分ける。 */
  noteHint: 'ここに書いた内容は、お客さまにも作家さまにも表示されません。',

  eventsHeading: '経過',
  eventsEmpty: '経過はまだありません',
  /** ⚠️ 追記のみ。直す口も消す口も無い。 */
  eventsHint: '経過は書き換えられません。押した操作がそのまま残ります。',

  /* --- 操作 -------------------------------------------------------------- */
  investigateHeading: '調べ終える',
  investigateHint:
    '調べた内容を残して、承認の判断へ回します。これは承認ではありません。作家さまのご回答を待たずに進めても構いません。',
  investigateNoteLabel: '調べた内容',
  investigateSubmit: '調べ終えたことにする',
  investigating: '記録しています…',
  investigated: '調べ終えたことを記録しました。',

  askCreatorHeading: '作家さまへ事実をお伺いする',
  askCreatorHint:
    'お伺いするのは事実だけです。返金の可否は運営が決めます。ご回答の期限は設定の営業日数から決まり、この画面からは変えられません。期限を過ぎても、待たずに審査を進められます。',
  askCreatorNoteLabel: 'お伝えする補足（任意）',
  askCreatorSubmit: '作家さまへお伺いする',
  asking: 'お送りしています…',
  asked: '作家さまへお伺いしました。',
  /** ⚠️ 事由で決まる。画面から選ばせない。 */
  askCreatorUnavailable:
    'この事由は運営だけで判断するものです。作家さまへお伺いする必要はありません。',

  approveHeading: '承認する',
  approveHint:
    'お金をお返しすると決める操作です。金額をもう一度ご入力ください。画面に出ている額をそのまま通さないための確認です。',
  approveAmountLabel: 'お返しする金額（円）',
  approveAmountHint: '1 円以上、上の「お返しできる残り」までの範囲でご入力ください。',
  approveDispositionLabel: 'デジタル会員証をどうするか',
  approveDispositionRevoke: '取り消す',
  approveDispositionKeep: 'そのまま残す',
  approveDispositionHint:
    '一部だけお返しする場合、どちらにするかは運営がお決めください。すでに外部へお渡し済みのものは、取り消しても戻せません。',
  approveExceptionLabel: '原則お受けしない事由ですが、例外としてお返しします',
  approveExceptionHint:
    'お気が変わった・お渡し済みなど、規約では原則お返ししない事由です。例外にする理由を、下の記録へ必ずお書きください。',
  approveNoteLabel: '判断の記録（任意）',
  approveSubmit: 'この金額で承認する',
  approving: '承認しています…',
  approved: '承認しました。お返しの手続きは「決済会社へ送る」から行ってください。',
  approvedFirst: '1 人目の承認を記録しました。この金額は、別の方のご承認が必要です。',
  /** ⚠️ オーナー限定。持っていない人には理由を出す。 */
  approveForbidden:
    'お金をお返しすると決める操作は、オーナーの方だけが行えます。オーナーの方へお声かけください。',

  rejectHeading: '却下する',
  rejectHint: '理由が必ず残ります。お客さまへのご説明にそのまま使える言葉でお書きください。',
  rejectNoteLabel: '却下の理由',
  rejectSubmit: 'このお申し出を却下する',
  rejecting: '記録しています…',
  rejected: '却下しました。',

  executeHeading: '決済会社へ送る',
  executeHint:
    '承認された金額で、決済会社へお返しの手続きを送ります。二重にはなりませんが、押したあとに止まった場合は決済会社の画面をお確かめください。',
  executeSubmit: '決済会社へ送る',
  executing: '送っています…',
  executed: (amount: number): string =>
    `決済会社が ${amount.toLocaleString('ja-JP')} 円のお返しを受け付けました。お客さまの口座に入るまで、数日かかることがあります。`,
  /** ⚠️ 「入金された」ではない。ここを曖昧に書くと、入金の問い合わせが増える。 */
  executeCaution: 'これは決済会社が受け付けたところまでです。お客さまへの入金は後日になります。',

  /* --- 運営が代わりにお受けする ------------------------------------------ */
  openHeading: '運営が代わりにお受けする',
  openHint:
    'お電話やメールでお申し出をいただいたときに使います。押した方が「お申し出をされた方」として記録され、二重承認では承認できなくなります。',
  openOrderLabel: 'ご注文の番号',
  openSubmit: 'お申し出としてお受けする',
  opening: 'お受けしています…',
  opened: 'お申し出としてお受けしました。',

  /* --- 作家さま ---------------------------------------------------------- */
  creatorTitle: '事実確認のお願い',
  creatorDescription:
    'ご購入者さまから返金のお申し出があり、事実をお伺いしています。お返しするかどうかは運営が判断しますので、ご心配なくご記入ください。',
  creatorEmpty: 'いまお伺いしていることはありません',
  creatorDueAt: 'ご回答の期限',
  creatorAnswerLabel: 'お心当たりやご説明',
  creatorAnswerHint:
    'お客さまがお書きの内容について、事実をお聞かせください。「返金してよい・いけない」をお選びいただく欄はありません。',
  creatorSubmit: 'ご回答を送る',
  creatorSending: 'お送りしています…',
  creatorSent: 'ご回答をお送りしました。ありがとうございます。',
  creatorAnswered: 'ご回答済み',
  /** ⚠️ 期限を過ぎても受け付ける。「もう遅い」と読ませない。 */
  creatorExpired: '期限を過ぎています（運営が先に判断している場合があります）',
  creatorExpiredHint: '期限を過ぎてもご回答はお受けします。遅れて届いた事実にも意味があります。',
  creatorAlreadyAnswered: 'このお伺いには、すでにご回答をいただいています。',

  receivablesHeading: '売上からのお戻し',
  receivablesHint:
    'お支払いを済ませたあとに返金が起きた分です。金額はこちらでは変更できません。次回以降の精算でお引きするか、別途ご相談させていただきます。',
  receivablesEmpty: 'お戻しいただく分はありません',
  receivablesTotal: '未解消の合計',

  /* --- 購入者 ------------------------------------------------------------ */
  buyerHeading: '返金のご相談',
  buyerHint:
    'ご事情をお聞かせください。内容を確かめたうえで、運営からご連絡いたします。お申し出をいただいた時点でご返金が決まるものではありません。',
  buyerReasonLabel: 'どのようなご事情ですか',
  buyerStatementLabel: '差し支えなければ、経緯をお聞かせください',
  buyerStatementHint: '10 文字以上でお願いします。お調べするうえで手がかりになります。',
  buyerSubmit: 'この内容でご相談する',
  buyerSending: 'お送りしています…',
  buyerSent:
    'お申し出をお受けしました。内容を確かめて、運営からご連絡いたします。しばらくお待ちください。',
  buyerAlreadyOpen:
    'このご注文には、まだお返事が済んでいないお申し出があります。重ねてのお申し出は不要です。',
  /** ⚠️ 「返金されます」と読める言い方をしない。 */
  buyerCaution:
    'デジタル作品という商品の性質上、お客さまのご都合による返品はお受けできない場合があります。',
} as const;

/* --- 状態 ---------------------------------------------------------------- */

const STATUS_LABELS: Readonly<Record<RefundRequestStatus, string>> = {
  submitted: 'お受けしました',
  creator_review: '作家さまへお伺い中',
  reviewed: '調べ終わりました',
  approval_pending: 'もう一名の承認待ち',
  approved: '承認済み（送信前）',
  rejected: '却下',
  executing: '決済会社へ送信中',
  executed: 'お返し済み',
  execution_failed: '送信できませんでした',
};

export function refundRequestStatusLabel(status: RefundRequestStatus): string {
  return STATUS_LABELS[status];
}

/**
 * 状態の色。
 *
 * ⚠️ **`executed` を「よかった」の色（`success`）にしない。** お金が出て
 * いった記録であって、めでたい結果ではない。並べたときに緑が目立つと、
 * 返金の多い月ほど一覧が明るく見える。
 *
 * ⚠️ **`rejected` も `danger` にしない。** 却下は正しい判断の結果でもある。
 * 赤くすると、断るたびに何か失敗したように読める。
 */
export function refundRequestStatusTone(status: RefundRequestStatus): StatusToneName {
  switch (status) {
    case 'execution_failed':
      return 'danger';
    case 'approval_pending':
    case 'approved':
      return 'warning';
    case 'executing':
      return 'progress';
    case 'rejected':
    case 'executed':
      return 'neutral';
    default:
      return 'progress';
  }
}

/* --- 事由 ---------------------------------------------------------------- */

/**
 * 事由の言葉。
 *
 * ⚠️ **Web3 の言葉を出さない**（`UI 方針`）。「Mint に失敗」ではなく
 * 「デジタル会員証をお渡しできなかった」。
 */
const REASON_LABELS: Readonly<Record<RefundRequestReason, string>> = {
  duplicate_payment: '二重にお支払いいただいた',
  wrong_amount: 'ご請求の金額が違っていた',
  system_failure: 'こちらの不具合でお手続きができなかった',
  issuance_failed: 'デジタル会員証をお渡しできなかった',
  wrong_grant: '違うものをお渡ししてしまった',
  fraudulent_use: '不正なご利用の疑いがある',
  chargeback: 'カード会社からの申し立て',
  not_as_described: 'ご説明と違うものだった',
  creator_cannot_deliver: '作家さまがお渡しできなくなった',
  rights_infringement: '権利を侵害している疑いがある',
  quality_issue: '品質に問題があった',
  buyer_change_of_mind: 'お気が変わった',
  after_transfer: 'すでにどなたかへお譲りになった',
  after_use: 'すでにご利用になった',
  after_resale: 'すでに転売された',
};

export function refundReasonLabel(reason: RefundRequestReason): string {
  return REASON_LABELS[reason];
}

/**
 * 購入者にお見せする事由の言葉。
 *
 * ⚠️ **一人称を変える。** 一覧の言葉（運営が読む）をそのまま選択肢にすると、
 * 「不正なご利用の疑いがある」を自分で選ぶことになって具合が悪い。
 */
const BUYER_REASON_LABELS: Partial<Record<RefundRequestReason, string>> = {
  duplicate_payment: '同じものを二重に購入してしまった／二重に請求された',
  wrong_amount: '請求された金額が違う',
  system_failure: '購入の手続きが最後まで進まなかった',
  issuance_failed: 'デジタル会員証が受け取れない',
  not_as_described: '説明と違うものだった',
  creator_cannot_deliver: '作家さまから受け取れないと連絡があった',
  rights_infringement: '権利を侵害している内容だと思う',
  quality_issue: '品質に問題があった',
  buyer_change_of_mind: '気が変わった・間違えて購入した',
  after_transfer: 'すでに他の方へ譲ったが、事情があって相談したい',
  after_use: 'すでに利用したが、事情があって相談したい',
  after_resale: 'すでに転売したが、事情があって相談したい',
};

export function buyerRefundReasonLabel(reason: RefundRequestReason): string {
  return BUYER_REASON_LABELS[reason] ?? REASON_LABELS[reason];
}

/* --- 取り扱い ------------------------------------------------------------ */

/**
 * 区分の言葉。
 *
 * ⚠️ **区分は事由から決まる。** 画面で選び直せない、と分かる言葉にする。
 */
export function refundCategoryLabel(
  category: 'operator_only' | 'creator_confirmation' | 'excluded',
): string {
  switch (category) {
    case 'operator_only':
      return '運営だけで判断します';
    case 'creator_confirmation':
      return '作家さまへ事実をお伺いします';
    case 'excluded':
      return '規約では原則お受けしません';
  }
}

export function entitlementDispositionLabel(disposition: 'revoke' | 'keep'): string {
  return disposition === 'revoke' ? '取り消す' : 'そのまま残す';
}

export function receivableStatusLabel(
  status: 'outstanding' | 'offset' | 'settled' | 'written_off',
): string {
  switch (status) {
    case 'outstanding':
      return '未解消';
    case 'offset':
      return '精算で相殺済み';
    case 'settled':
      return '解消済み';
    case 'written_off':
      return '見送り';
  }
}

/* --- 経過 ---------------------------------------------------------------- */

/**
 * 経過 1 行の言葉。
 *
 * ⚠️ **知らない符号を落とさない。** 新しい操作を足したときに、経過から
 * その行が消えるほうが困る。符号のまま出して、あとで言葉を足す。
 */
export function refundEventLabel(action: string): string {
  switch (action) {
    case 'refund_request.opened':
      return 'お申し出をお受けしました';
    case 'refund_request.creator_asked':
      return '作家さまへお伺いしました';
    case 'refund_request.creator_answered':
      return '作家さまからご回答がありました';
    case 'refund_request.reviewed':
      return '調べ終えました';
    case 'refund_request.approved':
      return '承認しました';
    case 'refund_request.rejected':
      return '却下しました';
    case 'refund_request.executing':
      return '決済会社へ送りはじめました';
    case 'refund_request.executed':
      return '決済会社が受け付けました';
    case 'refund_request.execution_failed':
      return '決済会社へ送れませんでした';
    default:
      return action;
  }
}
