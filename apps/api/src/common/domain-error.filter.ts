import { Catch, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { DomainErrorCode } from '@sengoku/domain';
import type { ApiError } from '@sengoku/contracts';
import { currentRequestId } from '@sengoku/observability';

/**
 * ドメインエラーコード → HTTP ステータスの対応（API_DESIGN.md §2.1）。
 *
 * この表を api 層に置くのは、ドメイン層に HTTP を知らせないため。
 * ドメイン層は「在庫が足りない」までを表現し、
 * それが 409 なのか 400 なのかは境界層の関心事。
 */
export const DOMAIN_ERROR_HTTP_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  ARTWORK_NOT_AVAILABLE: HttpStatus.NOT_FOUND,
  ARTWORK_NOT_PUBLISHED: HttpStatus.CONFLICT,
  ARTWORK_SUPPLY_IMMUTABLE: HttpStatus.CONFLICT,
  ARTWORK_NOT_DELETABLE: HttpStatus.CONFLICT,
  LISTING_NOT_ACTIVE: HttpStatus.CONFLICT,
  LISTING_NOT_EDITABLE: HttpStatus.CONFLICT,
  LISTING_PERIOD_INVALID: HttpStatus.BAD_REQUEST,
  INSUFFICIENT_SUPPLY: HttpStatus.CONFLICT,
  INVALID_QUANTITY: HttpStatus.BAD_REQUEST,
  INVALID_MONEY: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.BAD_REQUEST,
  ORDER_NOT_PENDING: HttpStatus.CONFLICT,
  INVALID_STATE_TRANSITION: HttpStatus.CONFLICT,
  ENTITLEMENT_NOT_CLAIMABLE: HttpStatus.CONFLICT,
  /*
    受取権の発行（P0-1）。

    ⚠️ **どれも 500 にしている。** これは利用者の入力の誤りではなく、
       こちら側の記録が食い違っている状態である。4xx にすると、
       呼び出し元（決済の Webhook・時計）に「送り方が悪い」と伝わり、
       直すべき場所を見誤らせる。
  */
  ENTITLEMENT_OVER_ISSUED: HttpStatus.INTERNAL_SERVER_ERROR,
  ENTITLEMENT_SUPPLY_MISMATCH: HttpStatus.INTERNAL_SERVER_ERROR,
  ENTITLEMENT_ORDER_NOT_FOUND: HttpStatus.INTERNAL_SERVER_ERROR,
  ENTITLEMENT_ORDER_NOT_PAID: HttpStatus.INTERNAL_SERVER_ERROR,
  ENTITLEMENT_OWNER_MISMATCH: HttpStatus.FORBIDDEN,
  // 403 にしない。有効なトークンが存在するかを攻撃者に教えないため。
  CLAIM_TOKEN_INVALID: HttpStatus.NOT_FOUND,
  // 期限切れは「かつては有効だった」ことを伝えてよい。相手が再取得を諦められる。
  CLAIM_EXPIRED: HttpStatus.GONE,
  CLAIM_REVOKED: HttpStatus.CONFLICT,
  CLAIM_PROCESSING: HttpStatus.CONFLICT,
  MINT_ALREADY_EXISTS: HttpStatus.CONFLICT,
  MINT_ATTEMPTS_EXHAUSTED: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  // --- 注文と決済（決済 Phase P0・P1）---
  // 設定の誤り。利用者の操作では起こらないので 5xx 側に置く。
  INVALID_FEE_RATE: HttpStatus.INTERNAL_SERVER_ERROR,
  ORDER_TRANSITION_NOT_ALLOWED: HttpStatus.CONFLICT,
  ORDER_IDEMPOTENCY_MISMATCH: HttpStatus.CONFLICT,
  ORDER_TOO_MANY_ITEMS: HttpStatus.BAD_REQUEST,
  // --- 決済（決済 Phase P2）---
  // ⚠️ 403 にしない。権限の話ではなく、販売の準備が終わっていない。
  SALES_SETUP_INCOMPLETE: HttpStatus.CONFLICT,
  CHECKOUT_NOT_ALLOWED: HttpStatus.CONFLICT,
  RESERVATION_EXPIRED: HttpStatus.GONE,
  // 事業者の知らせとこちらの記録が食い違う。利用者の操作の問題ではない。
  PAYMENT_MISMATCH: HttpStatus.CONFLICT,
  PAYMENT_PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
  // ⚠️ 401 にしない。誰かの資格情報の問題ではなく、署名が合っていない。
  WEBHOOK_SIGNATURE_INVALID: HttpStatus.BAD_REQUEST,
  // --- 決済の設定（管理画面から変える分）---
  // 運営の入力の誤り。利用者には出ない。
  PAYMENT_SETTINGS_INVALID: HttpStatus.BAD_REQUEST,
  PAYMENT_SECRET_INVALID: HttpStatus.BAD_REQUEST,
  PAYMENT_SECRET_ENVIRONMENT_MISMATCH: HttpStatus.BAD_REQUEST,
  // ⚠️ 「壊れている」ではなく「止めてある」。運営が戻せる。
  PAYMENT_PROVIDER_DISABLED: HttpStatus.CONFLICT,
  // --- 運営スタッフの招待と権限（`UD-803`）---
  STAFF_INVITE_INVALID: HttpStatus.BAD_REQUEST,
  // ⚠️ 「宛先が違う」も「もう使えない」もこれ 1 つ。
  //    分けると、どの宛先に招待が出ているかを総当たりで探れる。
  STAFF_INVITE_NOT_OPEN: HttpStatus.CONFLICT,
  STAFF_INVITE_EXPIRED: HttpStatus.GONE,
  STAFF_INVITE_DUPLICATE: HttpStatus.CONFLICT,
  STAFF_ALREADY_MEMBER: HttpStatus.CONFLICT,
  STAFF_NOT_MEMBER: HttpStatus.CONFLICT,
  STAFF_SELF_CHANGE: HttpStatus.CONFLICT,
  STAFF_LAST_OWNER: HttpStatus.CONFLICT,
  STAFF_OWNER_MUST_BE_OPERATOR: HttpStatus.CONFLICT,
  // --- 外部連携 ---
  INTEGRATION_SETTINGS_INVALID: HttpStatus.BAD_REQUEST,
  // 古い画面からの上書き。もう一度読み直してもらう。
  INTEGRATION_SETTINGS_CONFLICT: HttpStatus.CONFLICT,
  INTEGRATION_ENDPOINT_INSECURE: HttpStatus.BAD_REQUEST,
  INTEGRATION_SECRET_MISSING: HttpStatus.CONFLICT,
  INTEGRATION_SECRET_NOT_PENDING: HttpStatus.CONFLICT,
  // ⚠️ 403 にしない。権限の話ではなく、そもそも変えられない対象。
  INTEGRATION_NOT_MANAGED: HttpStatus.CONFLICT,
  INTEGRATION_CHECK_REQUIRED: HttpStatus.CONFLICT,
  INTEGRATION_CHECK_STALE: HttpStatus.CONFLICT,
  IMAGE_INVALID: HttpStatus.BAD_REQUEST,
  IMAGE_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  IMAGE_UNSUPPORTED_TYPE: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  // 相手の応答が契約と違う。利用者の操作の問題ではないので 5xx 側に置く。
  COMMON_USER_ID_INVALID: HttpStatus.BAD_GATEWAY,
  // まだ解決していないだけで、失敗ではない。受取権は失効させない。
  COMMON_USER_PENDING: HttpStatus.ACCEPTED,
  COMMON_USER_MISMATCH: HttpStatus.CONFLICT,
  // ⚠️ 外へ返す想定が無い符号。Wallet へ送る本文を組み立てられなかった
  //    ときにだけ立ち、運用ログとアラートで扱う。万一 HTTP へ漏れたときに
  //    利用者の入力のせいに見せないよう 5xx 側へ置く。
  WALLET_EVENT_INVALID: HttpStatus.INTERNAL_SERVER_ERROR,
  // すでに誰かが対応済み。⚠️ 競合であって、権限や入力の誤りではない。
  OPERATIONS_REVIEW_NOT_OPEN: HttpStatus.CONFLICT,
  // --- 法務文書 ---
  // ⚠️ 403 にしない。権限の話ではなく、公開済みの版は誰であっても
  //    書き換えられない。
  LEGAL_VERSION_NOT_DRAFT: HttpStatus.CONFLICT,
  LEGAL_DOCUMENT_INVALID: HttpStatus.BAD_REQUEST,
  // ⚠️ 400 にしない。送った内容の形は正しく、足りないだけ。
  LEGAL_DOCUMENT_INCOMPLETE: HttpStatus.CONFLICT,
  LEGAL_EFFECTIVE_DATE_INVALID: HttpStatus.BAD_REQUEST,
  // 画面が古い。読み込み直せば直る。
  LEGAL_CONSENT_VERSION_MISMATCH: HttpStatus.CONFLICT,
  // --- 決済資格情報の世代（`UD-118`）---
  PAYMENT_CREDENTIAL_CHECK_REQUIRED: HttpStatus.CONFLICT,
  PAYMENT_CREDENTIAL_NOT_ACTIVATABLE: HttpStatus.CONFLICT,
  PAYMENT_CREDENTIAL_IN_USE: HttpStatus.CONFLICT,
  // --- 返金と精算（`UD-104` / `UD-119`）---
  // ⚠️ 409。状態が理由なので、同じ要求をやり直しても変わらない。
  REFUND_NOT_ALLOWED: HttpStatus.CONFLICT,
  REFUND_WINDOW_CLOSED: HttpStatus.CONFLICT,
  REFUND_ALREADY_DONE: HttpStatus.CONFLICT,
  // ⚠️ 409。「まだ決まっていない」であって、入力の誤りではない。
  REFUND_NEEDS_REVIEW: HttpStatus.CONFLICT,
  /*
    ⚠️ 502。こちら側は正しく、相手に届かなかった。400 にすると運営が
       入力を疑い、500 にすると「うちの不具合」に見える。どちらでもない。
  */
  REFUND_PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
  // ⚠️ 409。鍵を取り込み直すまで、やり直しても同じ結果になる。
  REFUND_CREDENTIAL_UNAVAILABLE: HttpStatus.CONFLICT,
  SETTLEMENT_SETTINGS_INVALID: HttpStatus.BAD_REQUEST,
  // --- 精算（`UD-119`）---
  PAYOUT_PERIOD_INVALID: HttpStatus.BAD_REQUEST,
  // ⚠️ 409。時が経てば通る。入力の誤りではない。
  PAYOUT_PERIOD_NOT_CLOSED: HttpStatus.CONFLICT,
  PAYOUT_WINDOW_OPEN: HttpStatus.CONFLICT,
  PAYOUT_DISPUTE_OPEN: HttpStatus.CONFLICT,
  PAYOUT_NOT_EDITABLE: HttpStatus.CONFLICT,
  PAYOUT_NOT_FOUND: HttpStatus.NOT_FOUND,
  // --- 作家さまの表示名（決定 2026-08-20）---
  DISPLAY_NAME_INVALID: HttpStatus.BAD_REQUEST,
  // ⚠️ 409。書き方は正しいが、その名前はもう使われている。
  DISPLAY_NAME_TAKEN: HttpStatus.CONFLICT,
  DISPLAY_NAME_RESERVED: HttpStatus.BAD_REQUEST,
  // --- 注文の検索と問い合わせ対応（`UD-121`）---
  ORDER_SEARCH_INVALID: HttpStatus.BAD_REQUEST,
  ORDER_NOTE_INVALID: HttpStatus.BAD_REQUEST,
  // ⚠️ 404 ではない。「見つからない」ではなく「この配備では引けない」。
  //    直すのは配備の設定で、探し直しても結果は変わらない。
  EMAIL_LOOKUP_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,

  // --- 購入者への知らせ（P0-4）---
  NOTIFICATION_TEMPLATE_INVALID: HttpStatus.BAD_REQUEST,
  NOTIFICATION_TEMPLATE_UNKNOWN_VARIABLE: HttpStatus.BAD_REQUEST,
  // ⚠️ 400 ではない。書いた人の入力ではなく、こちらの差し込み漏れ。
  NOTIFICATION_RENDER_INCOMPLETE: HttpStatus.INTERNAL_SERVER_ERROR,
  NOTIFICATION_TEMPLATE_NOT_PUBLISHED: HttpStatus.CONFLICT,
  NOTIFICATION_NOT_RESENDABLE: HttpStatus.CONFLICT,

  // --- 運営ダッシュボード（P0-6）---
  // ⚠️ 404 ではない。「無い」のではなく「この配備では使えない」。
  ISSUANCE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  WALLET_DELIVERY_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,

  // --- 本番販売ガード（P0-7）---
  MAIL_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  MAIL_RECIPIENT_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  PRODUCTION_CREDENTIAL_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  ATTESTATION_NOTE_TOO_LONG: HttpStatus.UNPROCESSABLE_ENTITY,
  ATTESTATION_NOTE_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  /*
    ⚠️ **403 ではなく 409。** 権限の問題ではない。「いまはまだその状態に
       なっていない」であって、押した人が悪いわけではない。
  */
  PRODUCTION_NOT_READY: HttpStatus.CONFLICT,
  // ⚠️ 状態が合わないので断る。要求そのものは正しい形をしている。
  EMAIL_CHANGE_NOT_ALLOWED: HttpStatus.CONFLICT,
  // ⚠️ 要求の形は正しい。中身が受け付けられない。
  CREATOR_PROFILE_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  // お振込先（P1-3）。
  PAYOUT_ACCOUNT_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  /*
    ⚠️ **422 ではなく 503。** 入力が悪いのではなく、**この配備が受け取れない**。
       422 にすると、作家さまが入力を直そうとして直らない。
  */
  PAYOUT_ACCOUNT_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  // 運営への知らせ（`UD-1102`）。
  OPERATIONS_ALERT_SETTINGS_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  /*
    ⚠️ **422 ではなく 503。** 入力が悪いのではなく、**この配備が受け取れない**。
       422 にすると、運営が入力を直そうとして直らない。
  */
  OPERATIONS_ALERT_WEBHOOK_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  // 返金の申請と審査。
  REFUND_AMOUNT_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  REFUND_REQUEST_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  /*
    ⚠️ **403 ではなく 409。権限はある。この申請では押せないだけ。**
       403 にすると、権限を足そうとして直らない。状態の食い違いは 409。
  */
  REFUND_REQUEST_NOT_ACTIONABLE: HttpStatus.CONFLICT,
  REFUND_REQUEST_SAME_PERSON: HttpStatus.CONFLICT,
  REFUND_REQUEST_ALREADY_OPEN: HttpStatus.CONFLICT,
  // ⚠️ 入力が悪いのではなく、**この配備がまだ決めていない**。
  SETTLEMENT_SETTINGS_MISSING: HttpStatus.SERVICE_UNAVAILABLE,
  /*
    ⚠️ **403 ではなく 409。** 権限の話ではない。決着した争いを開き直そうと
       している、という状態の食い違いである。
  */
  DISPUTE_NOT_ACTIONABLE: HttpStatus.CONFLICT,
};

/** 利用者に見せる文言。内部実装の詳細を含めない。 */
const USER_MESSAGES: Readonly<Record<DomainErrorCode, string>> = {
  ARTWORK_NOT_AVAILABLE: 'お探しの作品は見つかりませんでした。',
  ARTWORK_NOT_PUBLISHED: 'この作品はまだ公開されていません。先に公開してください。',
  ARTWORK_SUPPLY_IMMUTABLE: '公開後の作品は発行数を変更できません。',
  ARTWORK_NOT_DELETABLE:
    'この作品は削除できません。公開中のもの、お支払い待ちや発行済みがあるものは削除できません。',
  LISTING_NOT_ACTIVE: 'この作品は現在販売していません。',
  LISTING_NOT_EDITABLE:
    '販売中または終了した内容は変更できません。一度停止してから変更してください。',
  LISTING_PERIOD_INVALID: '販売期間の指定が正しくありません。',
  INSUFFICIENT_SUPPLY: '在庫が不足しています。',
  INVALID_QUANTITY: '数量の指定が正しくありません。',
  INVALID_MONEY: '金額の指定が正しくありません。',
  CURRENCY_MISMATCH: '通貨の指定が正しくありません。',
  ORDER_NOT_PENDING: 'このご注文はお支払い待ちの状態ではありません。',
  INVALID_STATE_TRANSITION: 'この操作は現在の状態では行えません。',
  ENTITLEMENT_NOT_CLAIMABLE: 'この受取り権利は現在お受け取りいただけません。',
  /*
    ⚠️ **どれも同じ文面にしてある。** 利用者に見せる画面には、どの記録が
       どう食い違っているかを書かない。伝えるべきは「お客さまの操作は
       済んでいて、こちらで確認している」という一点だけ。
  */
  ENTITLEMENT_OVER_ISSUED: 'ただいま確認しております。お手数ですがお問い合わせください。',
  ENTITLEMENT_SUPPLY_MISMATCH: 'ただいま確認しております。お手数ですがお問い合わせください。',
  ENTITLEMENT_ORDER_NOT_FOUND: 'ただいま確認しております。お手数ですがお問い合わせください。',
  ENTITLEMENT_ORDER_NOT_PAID: 'ただいま確認しております。お手数ですがお問い合わせください。',
  ENTITLEMENT_OWNER_MISMATCH: 'この受取り権利をお受け取りいただく権限がありません。',
  CLAIM_TOKEN_INVALID: 'お探しの受取りページは見つかりませんでした。',
  CLAIM_EXPIRED: 'この受取りの期限が過ぎています。運営までお問い合わせください。',
  CLAIM_REVOKED: 'この受取りは無効になっています。運営までお問い合わせください。',
  CLAIM_PROCESSING: 'ただいま処理中です。しばらくしてからお試しください。',
  MINT_ALREADY_EXISTS: 'すでに発行済みです。',
  MINT_ATTEMPTS_EXHAUSTED: '発行処理が完了しませんでした。運営までお問い合わせください。',
  IDEMPOTENCY_CONFLICT: '同じ操作が別の内容で送信されました。もう一度お試しください。',
  // 利用者に原因は無い。時間をおいて試せることだけ伝える。
  INVALID_FEE_RATE: 'ただいまお手続きできませんでした。しばらくしてからお試しください。',
  // ⚠️ どの状態からどの状態へ、を文言に出さない。内部の進み方を教えることになる。
  ORDER_TRANSITION_NOT_ALLOWED: 'この操作は、いまのご注文の状態では行えません。',
  ORDER_IDEMPOTENCY_MISMATCH:
    '先ほどのお手続きとは別の商品が指定されました。画面を開き直してお試しください。',
  ORDER_TOO_MANY_ITEMS: '一度にご注文いただけるのは1点までです。',
  /*
    ⚠️ **利用者に「手数料が未設定です」と言わない。** 内部の設定値は
       買う人に関係が無く、伝えても何もできない。伝えるのは
       「いまは買えない」ことと「あとでもう一度」だけ。
  */
  SALES_SETUP_INCOMPLETE:
    '現在、この作品の購入準備を行っています。しばらくしてからもう一度お試しください。',
  CHECKOUT_NOT_ALLOWED: 'このご注文は、いまお支払いにお進みいただけません。',
  RESERVATION_EXPIRED:
    'お取り置き時間が終了しました。作品ページから購入手続きをやり直してください。',
  // 利用者に原因は無い。運営が調べる。
  PAYMENT_MISMATCH: 'ただいまお手続きできませんでした。運営までお問い合わせください。',
  PAYMENT_PROVIDER_ERROR:
    'ただいまお支払いのお手続きができませんでした。しばらくしてからお試しください。',
  // 外へ返す想定が無い。Webhook の送信元にだけ返る。
  WEBHOOK_SIGNATURE_INVALID: 'ただいま処理できませんでした。',
  /*
    ⚠️ **設定の誤りは、運営にだけ具体的に伝える。** これらは管理画面の
       操作でしか出ない。利用者に見える経路（購入）では
       `SALES_SETUP_INCOMPLETE` に倒れる。
  */
  PAYMENT_SETTINGS_INVALID: '決済の設定に誤りがあります。入力内容をご確認ください。',
  PAYMENT_SECRET_INVALID: '鍵の形式が正しくありません。貼り付ける値をご確認ください。',
  PAYMENT_SECRET_ENVIRONMENT_MISMATCH:
    'この環境では使えない鍵です。本番用とテスト用を取り違えていないかご確認ください。',
  PAYMENT_PROVIDER_DISABLED:
    '決済連携が停止されています。管理画面の「外部連携」からご確認ください。',
  STAFF_INVITE_INVALID: 'この内容では招待できません。宛先と役割をご確認ください。',
  STAFF_INVITE_NOT_OPEN: 'この招待はお使いいただけません。',
  STAFF_INVITE_EXPIRED: 'この招待は期限が過ぎています。もう一度お送りください。',
  STAFF_INVITE_DUPLICATE: 'その宛先には、すでに招待をお送りしています。',
  STAFF_ALREADY_MEMBER: 'この方はすでにスタッフです。',
  STAFF_NOT_MEMBER: 'この方はスタッフではありません。招待からお迎えください。',
  STAFF_SELF_CHANGE: 'ご自身の権限は変更できません。ほかのオーナーにお願いしてください。',
  STAFF_LAST_OWNER:
    'オーナーが居なくなるため、この変更はできません。先にもうひとりオーナーを立ててください。',
  STAFF_OWNER_MUST_BE_OPERATOR: 'オーナーにできるのは運営の方だけです。',
  INTEGRATION_SETTINGS_INVALID: 'この内容では保存できません。入力をご確認ください。',
  INTEGRATION_SETTINGS_CONFLICT:
    'ほかの方が先に変更されました。画面を読み込み直してから、もう一度お試しください。',
  INTEGRATION_ENDPOINT_INSECURE: '接続先は https から始まるものだけをご登録いただけます。',
  INTEGRATION_SECRET_MISSING: '有効な資格情報がありません。先にご登録ください。',
  INTEGRATION_SECRET_NOT_PENDING: 'この資格情報は、いまその操作を行える状態ではありません。',
  INTEGRATION_NOT_MANAGED:
    'この連携は、この画面からは変更できません。配備環境の設定として管理しています。',
  INTEGRATION_CHECK_REQUIRED: '先に接続テストを行い、成功させてください。',
  INTEGRATION_CHECK_STALE:
    '接続テストの結果が古くなっています。もう一度テストしてからお試しください。',
  IMAGE_INVALID: '画像ファイルとして読み取れませんでした。',
  IMAGE_TOO_LARGE: '画像のサイズが大きすぎます。',
  IMAGE_UNSUPPORTED_TYPE: 'この形式の画像は登録できません。JPEG・PNG・WebP をご利用ください。',
  COMMON_USER_ID_INVALID: 'ただいま処理できませんでした。しばらくしてからお試しください。',
  COMMON_USER_PENDING: 'お客様情報の確認中です。しばらくしてからお試しください。',
  COMMON_USER_MISMATCH: 'この受取りは、ご購入されたご本人のアカウントでお受け取りください。',
  // 利用者に原因は無い。何が起きたかは伝えず、時間をおいて試せることだけ伝える。
  WALLET_EVENT_INVALID: 'ただいま処理できませんでした。しばらくしてからお試しください。',
  OPERATIONS_REVIEW_NOT_OPEN: 'この確認事項は、すでに対応済みになっています。',
  LEGAL_VERSION_NOT_DRAFT:
    'すでに公開されている版は書き換えられません。新しい版を作成してください。',
  LEGAL_DOCUMENT_INVALID: '入力内容を確認してください。HTMLタグは使用できません。',
  LEGAL_DOCUMENT_INCOMPLETE: '公開に必要な項目が入力されていません。',
  LEGAL_EFFECTIVE_DATE_INVALID:
    '適用開始日は、現在より後で、いま適用中の版より後の日時にしてください。',
  LEGAL_CONSENT_VERSION_MISMATCH:
    '規約が更新されました。お手数ですが、画面を読み込み直してからご確認ください。',
  PAYMENT_CREDENTIAL_CHECK_REQUIRED:
    '先に接続テストを行い、成功させてください。鍵の入力間違いをここで防いでいます。',
  PAYMENT_CREDENTIAL_NOT_ACTIVATABLE: 'この世代は有効化できません。状態をご確認ください。',
  PAYMENT_CREDENTIAL_IN_USE:
    'この世代はいま新規のお支払いを受け付けています。先に切り替えてください。',
  REFUND_NOT_ALLOWED: 'このご注文は返金の対象外です。お支払いの状況をご確認ください。',
  // ⚠️ 「できません」で終わらせない。運営の不具合なら期限の外でも返金する。
  REFUND_WINDOW_CLOSED:
    '返金を承れる期間を過ぎています。当方の不具合が原因の場合は期間を問わず対応しますので、事情をご確認ください。',
  REFUND_ALREADY_DONE: 'このご注文はすでに全額を返金済みです。',
  /*
    ⚠️ **「できません」で終わらせない。** 回収できないだけで、判断のうえで
       返すことはある。画面は確認のうえで進める導線を出す。
  */
  REFUND_NEEDS_REVIEW:
    'このご注文は、発行が進んでいるため自動では返金しません。内容をご確認のうえ、あらためてお手続きください。',
  REFUND_PROVIDER_ERROR:
    '決済事業者へ返金の依頼が届きませんでした。記録は残っていますので、しばらくしてからもう一度お試しください。',
  REFUND_CREDENTIAL_UNAVAILABLE:
    'このご注文をお預かりした当時の決済用の鍵が見つからないため、返金できません。その世代の鍵を取り込み直してください。',
  SETTLEMENT_SETTINGS_INVALID:
    'この設定では保存できません。返金を受け付ける期間が、お支払いまでの猶予を超えていないかご確認ください。',
  PAYOUT_PERIOD_INVALID: '締め月は 2026-08 の形でご指定ください。',
  PAYOUT_PERIOD_NOT_CLOSED: 'その月はまだ締めを迎えていません。月が明けてからお試しください。',
  /*
    ⚠️ **「精算できません」で終わらせない。** 待てば通る。いつ通るのかを
       運営が知れないと、毎日押して確かめることになる。
  */
  PAYOUT_WINDOW_OPEN:
    '返金をお受けする期間が終わっていないご注文が残っています。期間が過ぎてから確定してください。',
  /*
    ⚠️ **「期間が過ぎれば」と書かない。** 争いは待っても開かない。
       カード会社が決着させるまで閉じない、と伝える。
  */
  PAYOUT_DISPUTE_OPEN:
    'カード会社との間で決着していないお取引が残っています。結果が出てから確定してください。',
  PAYOUT_NOT_EDITABLE: 'この精算はすでに確定しているため、変更できません。',
  PAYOUT_NOT_FOUND: 'その精算は見つかりませんでした。',
  DISPLAY_NAME_INVALID: 'お名前は 1〜40 文字でご入力ください。目に見えない文字は使えません。',
  /*
    ⚠️ **「使えません」で終わらせない。** 別の名前を考えれば済む話だと
       伝わらないと、同じ名前を何度も試すことになる。
  */
  DISPLAY_NAME_TAKEN: 'そのお名前は、すでに他の方がお使いです。別のお名前をご検討ください。',
  DISPLAY_NAME_RESERVED:
    '運営とまぎらわしいお名前はお使いいただけません。「運営」「公式」「事務局」などを含まないお名前をご検討ください。',
  ORDER_SEARCH_INVALID:
    '検索の条件をご確認ください。期間や金額の範囲が逆になっていないでしょうか。',
  ORDER_NOTE_INVALID:
    'この内容では保存できません。空でないこと、2000 文字以内であること、メールアドレスを書かないことをご確認ください。',
  // ⚠️ 「見つかりません」と書かない。引けていないだけで、注文はあるかもしれない。
  EMAIL_LOOKUP_UNAVAILABLE:
    'この環境ではメールアドレスからのお調べができません。注文番号や期間でお探しください。',

  // --- 購入者への知らせ（P0-4）---
  NOTIFICATION_TEMPLATE_INVALID:
    'この文面では保存できません。件名と本文が空でないこと、件名が 1 行であることをご確認ください。',
  // ⚠️ **どの語が使えるかは画面が持っている。** ここで列挙すると、
  //    語彙を増やしたときに 2 か所を直すことになり、片方だけ古くなる。
  NOTIFICATION_TEMPLATE_UNKNOWN_VARIABLE:
    'この知らせでは使えない差し込み語が含まれています。使える語の一覧をご確認ください。',
  NOTIFICATION_RENDER_INCOMPLETE:
    '文面に差し込む値がそろわなかったため、送信を見合わせました。運営へお知らせください。',
  NOTIFICATION_TEMPLATE_NOT_PUBLISHED: 'この知らせの文面がまだ公開されていません。',
  // ⚠️ 「できません」で終わらせず、どの状態なら送り直せるかを書く。
  NOTIFICATION_NOT_RESENDABLE:
    'この知らせは送り直せません。送り直せるのは、送信に失敗した知らせだけです。',

  // --- 運営ダッシュボード（P0-6）---
  ISSUANCE_UNAVAILABLE: 'この環境では受取権の発行をやり直せません。設定をご確認ください。',
  WALLET_DELIVERY_UNAVAILABLE:
    'この環境ではウォレットへの再送ができません。外部サービスの設定をご確認ください。',

  // --- 本番販売ガード（P0-7）---
  MAIL_UNAVAILABLE: 'この環境ではメールを送れません。送信の設定をご確認ください。',
  MAIL_RECIPIENT_MISSING:
    'あなたの業務用メールアドレスが登録されていないため、試し送りができません。スタッフの画面でご登録ください。',
  PRODUCTION_CREDENTIAL_MISSING:
    '受付中の決済の鍵がありません。先に決済の鍵を有効化してから記録してください。',
  ATTESTATION_NOTE_TOO_LONG: '覚え書きが長すぎます。要点だけを書いてください。',
  ATTESTATION_NOTE_REQUIRED: '「不成立」として記録するときは、何が起きたかを書いてください。',
  /*
    ⚠️ **購入者に理由の内訳を出さない。** どの条件が欠けているかは
       運営の内部事情である。
  */
  PRODUCTION_NOT_READY:
    'ただいま販売の準備中です。恐れ入りますが、しばらくしてからお試しください。',
  // --- 顧客サポート（P1-1）---
  // ⚠️ 「できません」で終わらせず、次に何を見ればよいかを書く。
  EMAIL_CHANGE_NOT_ALLOWED:
    'この申請は、いまの状態では進められません。本人確認が済んでいるか、すでに決着していないかをご確認ください。',

  // --- 作家さま運営（P1-2）---
  // ⚠️ 「できません」で終わらせず、どこを直せばよいかへ誘導する。
  CREATOR_PROFILE_INVALID:
    'プロフィールの内容を保存できませんでした。文字数、リンクのアドレス（https から始まるもの）、インボイス登録番号の形をご確認ください。',
  // --- お振込先（P1-3）---
  /*
    ⚠️ **どの項目がどう悪かったかを断定しない。** 検証の中身を写すと判定の
       詳細が外へ出る。直しに行ける場所だけを伝える。
    ⚠️ **名義がカナであることを、はっきり書く。** ここがいちばん詰まる。
  */
  PAYOUT_ACCOUNT_INVALID:
    'お振込先を保存できませんでした。口座番号は数字で、口座名義はカタカナ（または英字）でご入力ください。',
  PAYOUT_ACCOUNT_UNAVAILABLE:
    'ただいまお振込先をお預かりできません。お手数ですが、時間をおいてからお試しください。',
  /*
    ⚠️ **どの項目が悪いかを返さない。** 画面が入力欄ごとに案内する
       （そちらのほうが直しやすい）。
  */
  OPERATIONS_ALERT_SETTINGS_INVALID:
    '知らせの設定を保存できませんでした。宛先の形（5 件まで）と、受け口の URL（https）をお確かめください。',
  OPERATIONS_ALERT_WEBHOOK_UNAVAILABLE:
    'この配備では、知らせの受け口をお預かりできません。暗号鍵の設定が要る旨を運用担当へお伝えください。',
  REFUND_AMOUNT_INVALID:
    '返金の金額を受け付けられませんでした。1 円以上、返金できる残りの金額までの範囲でご入力ください。',
  REFUND_REQUEST_INVALID:
    '返金のお申し出を受け付けられませんでした。事由の選択と、経緯のご記入をお確かめください。',
  REFUND_REQUEST_NOT_ACTIONABLE:
    'この返金のお申し出は、いまその操作ができない状態です。画面を読み込み直して、最新の状態をご確認ください。',
  REFUND_REQUEST_SAME_PERSON:
    'この金額のお申し出は、お申し出をされたご本人とは別の方の承認が必要です。',
  REFUND_REQUEST_ALREADY_OPEN:
    'このご注文には、まだ決着していない返金のお申し出があります。そちらをご確認ください。',
  SETTLEMENT_SETTINGS_MISSING:
    '返金と精算の設定がまだ登録されていません。管理画面の設定をご確認ください。',
  DISPUTE_NOT_ACTIONABLE:
    'このチャージバックは、いまその操作ができない状態です。画面を読み込み直して、最新の状態をご確認ください。',
};

/** ドメインエラーを HTTP 境界へ運ぶための例外。 */
export class DomainErrorException extends Error {
  public override readonly name = 'DomainErrorException';
  constructor(public readonly code: DomainErrorCode) {
    super(code);
  }
}

/**
 * ドメインエラーを統一形式の応答へ変換する。
 *
 * ⚠️ 応答にスタックトレース・SQL・内部パスを含めない。
 * 詳細はログにのみ残し、利用者には定型の文言を返す。
 */
@Catch(DomainErrorException)
export class DomainErrorFilter implements ExceptionFilter<DomainErrorException> {
  catch(exception: DomainErrorException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = DOMAIN_ERROR_HTTP_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = currentRequestId();

    const body: ApiError = {
      error: {
        code: exception.code,
        message: USER_MESSAGES[exception.code] ?? 'エラーが発生しました。',
        ...(requestId === undefined ? {} : { requestId }),
      },
    };

    response.status(status).json(body);
  }
}
