/**
 * ドメインエラーのコード一覧。
 *
 * HTTP ステータスへの対応付けは api 層が持つ（API_DESIGN.md §2.1）。
 * ドメイン層は HTTP を知らない。
 */
export const DOMAIN_ERROR_CODES = [
  'ARTWORK_NOT_AVAILABLE',
  'ARTWORK_NOT_PUBLISHED',
  'ARTWORK_SUPPLY_IMMUTABLE',
  'ARTWORK_NOT_DELETABLE',
  'LISTING_NOT_ACTIVE',
  'LISTING_NOT_EDITABLE',
  'LISTING_PERIOD_INVALID',
  'INSUFFICIENT_SUPPLY',
  'INVALID_QUANTITY',
  'INVALID_MONEY',
  'CURRENCY_MISMATCH',
  'ORDER_NOT_PENDING',
  'INVALID_STATE_TRANSITION',
  'ENTITLEMENT_NOT_CLAIMABLE',
  'ENTITLEMENT_OWNER_MISMATCH',
  /*
    受取権の発行（P0-1）。

    ⚠️ **2 つを分けてある。** 「売った数より受取権が多い」は二重発行で、
       「押さえた枠が足りない」は在庫の記録の壊れ。原因も直し方も違う
       ので、同じ符号にすると調べるときに区別できない。
  */
  'ENTITLEMENT_OVER_ISSUED',
  'ENTITLEMENT_SUPPLY_MISMATCH',
  /** 発行しようとした注文が見つからない。 */
  'ENTITLEMENT_ORDER_NOT_FOUND',
  /**
   * 決済が済んでいない注文に受取権を作ろうとした。
   *
   * ⚠️ **緩めない。** ここを通すと、失敗した決済や期限切れの注文からも
   * 権利が生まれる。
   */
  'ENTITLEMENT_ORDER_NOT_PAID',
  'CLAIM_TOKEN_INVALID',
  // Claim API（API_DESIGN.md §3-2）で確定した符号。
  // ⚠️ 相手システムと合わせた契約なので、**綴りを変えない**。
  'CLAIM_EXPIRED',
  'CLAIM_REVOKED',
  'CLAIM_PROCESSING',
  'MINT_ALREADY_EXISTS',
  'MINT_ATTEMPTS_EXHAUSTED',
  'IDEMPOTENCY_CONFLICT',
  // --- 運営スタッフの招待と権限（`UD-803` 決定 2026-08-18）---
  'STAFF_INVITE_INVALID',
  /**
   * その招待はいま受け取れない。
   *
   * ⚠️ **「宛先が違う」と「招待が無い」を分けない。** 分けると、
   * どの宛先に招待が出ているかを総当たりで探れる。
   */
  'STAFF_INVITE_NOT_OPEN',
  'STAFF_INVITE_EXPIRED',
  'STAFF_INVITE_DUPLICATE',
  'STAFF_ALREADY_MEMBER',
  'STAFF_NOT_MEMBER',
  'STAFF_SELF_CHANGE',
  'STAFF_LAST_OWNER',
  'STAFF_OWNER_MUST_BE_OPERATOR',
  // --- 外部連携の設定と資格情報（管理画面・外部連携 指示書）---
  'INTEGRATION_SETTINGS_INVALID',
  'INTEGRATION_SETTINGS_CONFLICT',
  'INTEGRATION_ENDPOINT_INSECURE',
  'INTEGRATION_SECRET_MISSING',
  'INTEGRATION_SECRET_NOT_PENDING',
  /**
   * この連携は管理画面から変えられない。
   *
   * ⚠️ **「権限が無い」ではない。** オーナーでも変えられない。
   * 変えても誰も読まないため、受け付けること自体が嘘になる。
   */
  'INTEGRATION_NOT_MANAGED',
  // --- 決済の設定（管理画面から変える分）---
  'PAYMENT_SETTINGS_INVALID',
  'PAYMENT_SECRET_INVALID',
  /**
   * 鍵と環境が食い違っている。
   *
   * ⚠️ **「無効な鍵」と分けてある。** 形は正しいのに置き場所が違う、
   * という状態を、直す人がすぐ見分けられるようにするため。
   */
  'PAYMENT_SECRET_ENVIRONMENT_MISMATCH',
  /**
   * 決済連携が管理画面から止められている。
   *
   * ⚠️ **「設定が足りない」と分けてある。** 直し方が違う。止めたのなら
   * 戻す、足りないなら埋める。混ぜると、止めた本人が「壊れた」と読む。
   */
  'PAYMENT_PROVIDER_DISABLED',
  // --- 注文（決済 Phase P0・P1）---
  /** 注文時の手数料率が受け付けられない値。 */
  'INVALID_FEE_RATE',
  // --- 決済（決済 Phase P2）---
  /**
   * 販売の設定が完了していない。
   *
   * ⚠️ **手数料率 0 は「無料」ではなく「未設定」**（`UD-109` の決定）。
   * 0 のまま売ると、あとから率を決めても過去の注文は 0% のままになる。
   * 売れないほうが取り返しがつく。
   */
  'SALES_SETUP_INCOMPLETE',
  /** その注文では決済を始められない（支払済み・期限切れなど）。 */
  'CHECKOUT_NOT_ALLOWED',
  /** 在庫のお取り置きの期限が過ぎている。 */
  'RESERVATION_EXPIRED',
  /** 決済事業者から届いた内容が、こちらの注文と食い違う。 */
  'PAYMENT_MISMATCH',
  /** 決済事業者とのやり取りに失敗した。 */
  'PAYMENT_PROVIDER_ERROR',
  /** Webhook の署名を検証できなかった。 */
  'WEBHOOK_SIGNATURE_INVALID',
  /**
   * その状態からその状態へは移せない。
   *
   * ⚠️ **どの状態からどこへ、を符号に含めない。** 含めると、
   * 内部の状態名がそのまま外へ出る。何が起きたかは符号で足りる。
   */
  'ORDER_TRANSITION_NOT_ALLOWED',
  /**
   * 同じ冪等キーで、前回と違う内容を送ってきた。
   *
   * ⚠️ **前回の注文を返さない。** 返すと、頼んだものと違う注文を
   * 「成功」として受け取ることになる。断って、気づかせる。
   */
  'ORDER_IDEMPOTENCY_MISMATCH',
  /** 1 注文 1 明細の制限を超えた（MVP 期間）。 */
  'ORDER_TOO_MANY_ITEMS',
  /**
   * 接続テストの成功が要る。
   *
   * ⚠️ **「保存できた」と「繋がった」を分けるための符号。**
   * 保存は自分の DB へ書けたというだけで、相手に届くかは別の話。
   */
  'INTEGRATION_CHECK_REQUIRED',
  'INTEGRATION_CHECK_STALE',
  'IMAGE_INVALID',
  'IMAGE_TOO_LARGE',
  'IMAGE_UNSUPPORTED_TYPE',
  'COMMON_USER_ID_INVALID',
  'COMMON_USER_PENDING',
  'COMMON_USER_MISMATCH',
  // --- 法務文書（利用規約・プライバシーポリシー・特商法表記）---
  /**
   * 公開済みの版を書き換えようとした。
   *
   * ⚠️ **「権限が無い」ではない。** オーナーでも書き換えられない。
   * 過去にどう書いてあったかが変わると、あとから確かめられなくなる。
   */
  'LEGAL_VERSION_NOT_DRAFT',
  /** 入力が受け付けられない（長すぎる・HTML が入っている等）。 */
  'LEGAL_DOCUMENT_INVALID',
  /**
   * 公開に必要な項目が埋まっていない。
   *
   * ⚠️ **`LEGAL_DOCUMENT_INVALID` と分けてある。** 直し方が違う。
   * 片方は書き直し、片方は書き足し。
   */
  'LEGAL_DOCUMENT_INCOMPLETE',
  /** 施行日が過去、または現行版より前。 */
  'LEGAL_EFFECTIVE_DATE_INVALID',
  /**
   * 画面が見ていた版と、いま施行中の版が違う。
   *
   * ⚠️ **黙って差し替えない。** 差し替えると、利用者が読んだものと
   * 記録が食い違う。「読んでいない条件に同意したことになっている」を
   * 作らないための符号。
   */
  'LEGAL_CONSENT_VERSION_MISMATCH',
  // --- 決済資格情報の世代（`UD-118`）---
  /** 接続確認を通っていないので有効化できない。 */
  'PAYMENT_CREDENTIAL_CHECK_REQUIRED',
  /** その世代は有効化できる状態にない（退役済み・すでに受付中など）。 */
  'PAYMENT_CREDENTIAL_NOT_ACTIVATABLE',
  /** まだ使われているので退役させられない。 */
  'PAYMENT_CREDENTIAL_IN_USE',
  // --- 返金と精算（`UD-104` / `UD-119`。決定 2026-08-20）---
  /**
   * その注文は返金できない（未払い・記録が壊れている等）。
   *
   * ⚠️ **「期限切れ」と分けてある。** 直し方が違う。期限切れなら
   * 運営の判断で `our_fault` として通す道があるが、未払いには無い。
   */
  'REFUND_NOT_ALLOWED',
  /** 返金を受け付ける期限を過ぎている。 */
  'REFUND_WINDOW_CLOSED',
  /** すでに全額返している。⚠️ 二度目を通すと二重返金になる。 */
  'REFUND_ALREADY_DONE',
  /** 返金・精算の設定が受け付けられない値。 */
  'SETTLEMENT_SETTINGS_INVALID',
  // --- 精算（`UD-119`）---
  /** 締め期間の指定が読めない（`2026-08` の形）。 */
  'PAYOUT_PERIOD_INVALID',
  /**
   * まだ締めを迎えていない期間を精算しようとした。
   *
   * ⚠️ **「まだ売れる余地がある」ということ。** 締めの当日に集計すると、
   * その日の売上が漏れる。
   */
  'PAYOUT_PERIOD_NOT_CLOSED',
  /**
   * 返金の窓が開いている注文が残っている（`SETTLEMENT_AND_REFUND.md` §2-3）。
   *
   * ⚠️ **これを緩めない。** 閉じる前に確定すると、返金のたびに作家さまから
   * 返してもらう話になる。いちばん揉める作業で、少額なら回収を諦めることに
   * なり、諦めた分は運営の損になる。
   */
  'PAYOUT_WINDOW_OPEN',
  /**
   * その精算はもう書き換えられない。
   *
   * ⚠️ **`confirmed` 以降は動かさない。** 締めたあとに金額が動くと、
   * 作家さまへ渡した明細と食い違う。訂正は次の期間での調整で行う。
   */
  'PAYOUT_NOT_EDITABLE',
  /** その精算は見つからない。 */
  'PAYOUT_NOT_FOUND',
  // --- 作家さまの表示名（決定 2026-08-20）---
  /** 表示名として受け付けられない（長さ・見えない文字など）。 */
  'DISPLAY_NAME_INVALID',
  /**
   * すでに使われている表示名。
   *
   * ⚠️ **`DISPLAY_NAME_INVALID` と分ける。** 直し方が違う——前者は書き方を
   * 直す、こちらは別の名前を考える。まとめると、本人が同じ名前を
   * 何度も試すことになる。
   */
  'DISPLAY_NAME_TAKEN',
  /** 運営を名乗る表示名。⚠️ なりすましを止めるため。 */
  'DISPLAY_NAME_RESERVED',
  /**
   * 返金は決められたが、決済事業者へ届かなかった（`UD-120`）。
   *
   * ⚠️ **「返さない」ではなく「まだ返せていない」。** 記録は
   * `failed` として残るので、直してからやり直せる。ここを
   * `REFUND_NOT_ALLOWED` に丸めると、通信の失敗が「対象外」に化ける。
   */
  'REFUND_PROVIDER_ERROR',
  /**
   * どの世代の鍵で決済したか分からず、返金の口を開けない（`UD-118`）。
   *
   * ⚠️ **これは運営会社の切り替えで実際に起きる。** 旧世代を退役させて
   * 鍵を消すと、その世代で受けた決済は二度と返金できない。
   * 直し方は「その世代の鍵を取り込み直す」であって、注文側ではない。
   */
  'REFUND_CREDENTIAL_UNAVAILABLE',
  /**
   * 機械では決められない（`UD-104`）。
   *
   * ⚠️ **「返金できない」ではない。** 発行処理中・発行済みは回収できない
   * ので、返すかどうかは事業の判断になる。画面から自動では返さないが、
   * 判断のうえで返すことはある。断りの言葉にしないこと。
   */
  'REFUND_NEEDS_REVIEW',
  // --- 注文の検索と問い合わせ対応（`UD-121`）---
  /**
   * 検索条件が受け付けられない。
   *
   * ⚠️ **どの条件が悪いかを符号に含めない。** 含めると符号が増え続ける。
   * 直すのは入力した本人なので、画面側の文言で伝える。
   */
  'ORDER_SEARCH_INVALID',
  /**
   * この配備ではメールアドレスから引けない。
   *
   * ⚠️ **「見つからなかった」と必ず分ける。** 同じ扱いにすると、鍵を
   * 入れ忘れた配備で「その注文は存在しません」と答えてしまう。
   * 問い合わせてきた方に、事実でないことを伝えることになる。
   */
  'EMAIL_LOOKUP_UNAVAILABLE',
  /** 対応メモの本文が受け付けられない（空・長すぎ・平文のメールを含む等）。 */
  'ORDER_NOTE_INVALID',
  /**
   * Wallet へ送るイベントを組み立てられなかった。
   *
   * ⚠️ これは**外へ返す符号ではない**。相手へ送る前に落ちているので、
   * 利用者への応答ではなく運用ログとアラートへ出す。
   */
  'WALLET_EVENT_INVALID',
  /**
   * 運用確認の行が、すでに対応済みだった（M3a）。
   *
   * ⚠️ **「対応済みにできない」ではなく「もう対応済み」。** 上書きを許すと、
   * 最初に確認した人の記録が、あとから押した人で置き換わる。
   */
  'OPERATIONS_REVIEW_NOT_OPEN',

  // --- 購入者への知らせ（P0-4） ---
  /** 文面として成立していない（件名が空・長すぎる・改行が入っている等）。 */
  'NOTIFICATION_TEMPLATE_INVALID',
  /** 差し込み語彙に無い語が書かれている。⚠️ 公開の時点で弾く。 */
  'NOTIFICATION_TEMPLATE_UNKNOWN_VARIABLE',
  /** 差し込む値が足りない。⚠️ 空文字で埋めずに落とす。 */
  'NOTIFICATION_RENDER_INCOMPLETE',
  /** その種別の文面がまだ公開されていない。 */
  'NOTIFICATION_TEMPLATE_NOT_PUBLISHED',
  /** その状態の知らせは送り直せない（送信中・送信済み・送らないと決めた）。 */
  'NOTIFICATION_NOT_RESENDABLE',

  // --- 運営ダッシュボード（P0-6） ---
  /** この配備では発行のやり直しができない。 */
  'ISSUANCE_UNAVAILABLE',
  /** この配備ではウォレットへの再配送ができない（連携が無効）。 */
  'WALLET_DELIVERY_UNAVAILABLE',

  // --- 本番販売ガード（P0-7） ---
  /** この配備ではメールを送れない（送信の設定が無い）。 */
  'MAIL_UNAVAILABLE',
  /** 押した人に業務用アドレスが登録されていない。⚠️ 宛先は受け取らない。 */
  'MAIL_RECIPIENT_MISSING',
  /** 受付中の決済世代が無い。⚠️ 証跡を紐づける先が無い。 */
  'PRODUCTION_CREDENTIAL_MISSING',
  /** 覚え書きが長すぎる。 */
  'ATTESTATION_NOTE_TOO_LONG',
  /** 「不成立」には理由が要る。 */
  'ATTESTATION_NOTE_REQUIRED',
  /**
   * 本番販売の条件が満たされていない（P0-7）。
   *
   * ⚠️ **購入者には理由の内訳を出さない。** どの条件が欠けているかは
   * 運営の内部事情で、買おうとした方に伝えることではない。
   */
  'PRODUCTION_NOT_READY',
  // --- 顧客サポート（P1-1） ---
  /**
   * ご連絡先の変更申請を、いまその状態から動かせない。
   *
   * ⚠️ **理由を分けていない。** 「本人確認がまだ」「もう決着している」の
   * 違いは、押した運営には「いまはできない」としか読めない。文言は画面側で
   * 状態から作る（状態は一覧に出ている）。
   */
  'EMAIL_CHANGE_NOT_ALLOWED',

  // --- 作家さま運営（P1-2） ---
  /**
   * プロフィールの内容を受け付けられない。
   *
   * ⚠️ **理由を分けていない。** 長すぎる・HTML が混じっている・リンクが
   * `https` でない——どれも「書き直してください」に落ちる。何が悪いかは
   * 画面側が入力欄ごとに案内する（そちらのほうが直しやすい）。
   */
  'CREATOR_PROFILE_INVALID',
  /** お振込先の内容を受け付けられない（P1-3）。⚠️ どの項目かは返さない。 */
  'PAYOUT_ACCOUNT_INVALID',
  /** この配備ではお振込先を預かれない（暗号鍵が未設定）。 */
  'PAYOUT_ACCOUNT_UNAVAILABLE',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  readonly code: DomainErrorCode;
  /**
   * 開発者向けの補足。**利用者の入力値や秘匿値を含めてはならない。**
   * 利用者向け文言は表示層で `code` から解決する。
   */
  readonly detail?: string;
}

export function domainError(code: DomainErrorCode, detail?: string): DomainError {
  return detail === undefined ? { code } : { code, detail };
}
