import type { ConnectionCheckView, IntegrationStatusView } from '@sengoku/contracts';

/**
 * 外部連携の設定画面の文言（管理画面・外部連携 指示書 §4・§9・§11）。
 *
 * ⚠️ **「保存できた」と「繋がる」を言い分ける。** ひとつの言葉にすると
 * 「保存できたから繋がっている」と読まれる。
 *
 * ⚠️ **確かめていないことを、確かめた顔で書かない。** いまの確認は
 * 接続先へ届くかどうかまでで、鍵が正しいかどうかは分からない（要決定 06）。
 */
export const INTEGRATION_COPY = {
  title: '外部サービスとの接続',
  description: '提携先のサービスへつなぐための設定です。',

  environmentHeading: 'いまの環境',
  /**
   * ⚠️ **本番かどうかを、いちばん先に出す。** 同じ画面で staging と
   * production を扱うため、どちらを触っているのか分からないまま
   * 変更するのがいちばん危ない（指示書 §11）。
   */
  productionWarning: 'ここは本番の設定です',
  productionWarningHint:
    '変更すると、お客さまへのお届けにそのまま影響します。試すときは staging をお使いください。',
  stagingNotice: 'ここは staging の設定です',
  stagingNoticeHint: '本番のお届けには影響しません。',

  statusHeading: 'いまの状態',
  statusEnabled: '有効（お届けを行います）',
  statusDisabled: '停止中（お届けを行いません）',
  statusEndpoint: '接続先',
  statusKeyId: '鍵の名前',
  statusApiVersion: '版',
  statusTimeout: '応答を待つ上限',
  statusMaxAttempts: '送り直す回数の上限',
  notConfigured: '（未設定）',

  settingsHeading: '接続先を設定する',
  fieldEndpoint: '接続先の URL',
  fieldEndpointHint: 'https で始まる URL をお使いください。提携先からお知らせされたものです。',
  fieldKeyId: '鍵の名前（鍵ID）',
  /**
   * ⚠️ **秘密ではないことを書く。** 書かないと「見えてよいのか」と迷い、
   * 迷った人は鍵そのものをここへ入れてしまう。
   */
  fieldKeyIdHint:
    '署名につける名前です。秘密ではないため、そのまま表示されます。鍵そのものは下の欄でお預かりします。',
  fieldApiVersion: '版（任意）',
  fieldTimeout: '応答を待つ上限（ミリ秒）',
  fieldMaxAttempts: '送り直す回数の上限',
  submitSettings: 'この内容で保存する',
  settingsSavedNotice: '保存しました。まだ接続の確認はしていません。',

  secretHeading: '鍵をお預かりする',
  secretIntro:
    'お預かりした鍵は暗号化して保管し、この画面には二度と表示しません。取り違えを確かめられるよう、末尾 4 文字だけを表示します。',
  fieldSecret: '鍵（HMAC シークレット）',
  fieldSecretHint: '提携先からお知らせされた値を貼り付けてください。8 文字以上。',
  submitSecret: 'この鍵をお預かりする',
  secretSavedNotice:
    'お預かりしました。まだ使われません。下の一覧から「使いはじめる」を押してください。',

  secretsHeading: 'お預かりしている鍵',
  columnPurpose: '用途',
  columnLastFour: '末尾',
  columnSecretStatus: '状態',
  columnKeyVersion: '暗号鍵の版',
  columnActions: ' ',
  secretPending: '待機中（まだ使っていません）',
  secretActive: '使用中',
  secretRetired: '使い終わりました',
  submitActivate: 'この鍵を使いはじめる',
  submitDiscard: 'この鍵を捨てる',
  noSecrets: 'まだ鍵をお預かりしていません',
  noSecretsHint: '上の欄からお預けください。',

  checkHeading: '接続を確かめる',
  /**
   * ⚠️ **何を確かめていないかを、必ず併記する。**
   * 「テスト成功」だけを出すと、鍵まで確かめた気にさせる。
   */
  checkIntro: '接続先へ届くかどうかを確かめます。お客さまの情報は送りません。',
  checkLimitation: 'この確認では、鍵が正しいかどうかは分かりません',
  checkLimitationHint:
    '提携先に安全な確認方法があるかを、まだ伺えていないためです。分かるのは「接続先へ届くこと」までです。',
  submitCheck: '接続を確かめる',
  checkNeedsEndpoint: '先に接続先を保存してください',

  /*
    ⚠️ **管理外の連携では、言い方を変える。** あちらで確かめているのは
       公開されている場所への到達性で、Wallet の「鍵」は関係が無い。
       同じ文言を使い回すと、確かめていないものの名前を取り違える。
  */
  checkIntroUnmanaged: '公開されている場所へ届くかどうかを確かめます。',
  checkLimitationUnmanaged: 'この確認で分かるのは、その場所へ届くことだけです',
  checkLimitationUnmanagedHint:
    '保管先への書き込みや、ログインの検証がうまくいくかどうかは分かりません。それらは配備環境の設定として管理しています。',
  /** ⚠️ 「保存してください」と書かない。この画面からは保存できない。 */
  checkNoTarget: 'いまの方式では、確かめる先がありません',

  historyHeading: '確かめた記録',
  columnCheckedAt: '日時',
  columnResult: '結果',
  columnDetail: '内容',
  columnDuration: '所要',
  noChecks: 'まだ確かめていません',
  noChecksHint: '上の「接続を確かめる」を押してください。',
  checkOk: '届きました',
  checkNg: '届きませんでした',

  // --- 管理外の連携（画像の保管先・ログイン）---------------------------------
  /**
   * ⚠️ **「権限がありません」と書かない。** オーナーでも変えられない。
   * 権限の話だと思われると、権限を足せば変えられると誤解される。
   */
  unmanagedNotice: 'この設定は、この画面からは変更できません',
  unmanagedHint:
    '配備環境の設定として管理しています。変更するには配備の設定を直し、入れ直す必要があります。ここでは、いまどうなっているかだけをご確認いただけます。',
  unmanagedStorageReason:
    '画像の保管先は、起動時に一度だけ読み込みます。ここで変えても切り替わりません。本番の保管先自体もまだ決まっていません（UD-508）。',
  unmanagedAuthReason:
    'ログインの設定は、誤ると全員が入れなくなります。しかも直す手段がログインの先にあるため、この画面には置いていません。',

  envHeading: 'いまの設定',
  envProvider: '使っている方式',
  envComplete: '設定はそろっています',
  envIncomplete: '設定が足りません',
  envIncompleteHint: '下の項目が配備環境に設定されていません。設定してから入れ直してください。',
  envMissingHeading: '足りない設定',
  /** ⚠️ 出すのは名前だけ。値は API が返していない。 */
  envMissingNote: '設定の名前だけを表示しています。値は表示しません。',
  envPublicUrl: '公開されている場所',

  enableHeading: 'お届けの開始と停止',
  submitEnable: 'お届けを始める',
  submitDisable: 'お届けを止める',
  /** ⚠️ 押せるのに何も起きない、を作らない。理由を先に出す。 */
  enableBlocked: 'いまは始められません',
  enableBlockedHint:
    '接続先・鍵の名前・お預かりした鍵・直近の接続確認（30 分以内の成功）が、すべてそろっている必要があります。',
  disableHint: '止めるのはいつでもできます。押すとすぐに新しいお届けが止まります。',

  // --- お支払いの設定 ---
  paymentHeading: 'お支払いの設定',
  paymentIntro:
    'ここで保存した内容は、次のお支払いから使われます。再起動は要りません。まだ何も保存していない間は、配備時の設定がそのまま使われます。',
  fieldSuccessUrl: 'お支払い後に戻る画面の URL',
  fieldSuccessUrlHint:
    'https で始まり、{ORDER_ID} を含めてください。この目印が、どのご注文の結果を表示するかの手がかりになります。',
  fieldCancelUrl: 'お支払いをやめたときに戻る画面の URL',
  fieldCancelUrlHint: 'https で始まる URL をお使いください。',
  fieldFeeRate: '当社の手数料（％）',
  /*
    ⚠️ **0 を「手数料無料」と書かない。** 0 のまま売れると、こちらの
       取り分が無い注文が成立し、あとから請求し直すことはできない。
  */
  fieldFeeRateHint:
    '0 のままでは販売を開始できません（未設定として扱います）。作家さまへのお渡し分は、100％からこの割合を引いた残りです。',
  feeRateNotSet: '手数料が未設定のため、購入手続きに進めません',
  feeRateSet: (percent: string, creator: string): string =>
    `手数料 ${percent}％／作家さま ${creator}％`,
  // --- お支払いの鍵（この画面では扱わない） ---
  paymentKeyHeading: 'お支払いの鍵',
  /*
    ⚠️ **「なぜここで扱わないか」を書く。** 書かないと、探した人が
       「機能が足りない」と受け取り、別の場所へ鍵を置き始める。
  */
  paymentKeyIntro:
    '決済の鍵は、この画面では扱いません。配備環境の秘密情報管理に置いてあり、画面からの入力・表示・変更はできません。ここに出るのは、設定されているかどうかだけです。',
  paymentSecretKeyLabel: 'シークレットキー',
  paymentWebhookSecretLabel: 'Webhook 署名シークレット',
  paymentModeLabel: 'モード',
  paymentLastWebhookLabel: '最後にお知らせが届いた日時',
  paymentNoWebhookYet: 'まだ届いていません',
  paymentSettingsSourceLabel: '戻り先・API 版の出どころ',
  paymentConfigured: '設定されています',
  paymentNotConfigured: '設定されていません',
  paymentSourceDatabase: 'この画面の設定',
  paymentSourceEnvironment: '配備時の設定（この画面ではまだ保存していません）',
} as const;

/**
 * テストか本番か。
 *
 * ⚠️ **鍵の値は出さない。** 出すのは取り違えに気づける粒度まで。
 */
export function paymentModeLabel(mode: 'test' | 'live' | 'unknown'): string {
  switch (mode) {
    case 'test':
      return 'テストモード（本物のお金は動きません）';
    case 'live':
      return '本番モード（本物のお金が動きます）';
    case 'unknown':
      return '判別できません（鍵が未設定か、想定外の形式です）';
  }
}

/** どの提携先か。⚠️ 内部の名前をそのまま出さない。 */
export function integrationServiceLabel(service: IntegrationStatusView['service']): string {
  switch (service) {
    case 'ovew_wallet':
      return 'お受け取り先（OVEW Wallet）';
    case 'payment':
      return 'お支払い（クレジットカード決済）';
    case 'storage':
      return '画像の保管先';
    case 'auth':
      return 'ログイン';
    /*
      ⚠️ **鍵は管理画面から触れない。** ここに名前があるのは、
         本番販売の前に「送れること」を確かめた記録を置くため（P0-7）。
    */
    case 'mail':
      return 'メールの送信';
  }
}

export function secretPurposeLabel(
  purpose: 'api_key' | 'hmac_secret',
  service?: IntegrationStatusView['service'],
): string {
  if (service === 'payment') {
    // ⚠️ 決済では呼び名が違う。画面の言葉を提携先の画面に合わせる。
    return purpose === 'api_key' ? 'シークレットキー' : 'Webhook 署名シークレット';
  }
  return purpose === 'api_key' ? 'API キー' : '署名の鍵';
}

export function secretStatusLabel(status: 'pending' | 'active' | 'retired'): string {
  switch (status) {
    case 'pending':
      return INTEGRATION_COPY.secretPending;
    case 'active':
      return INTEGRATION_COPY.secretActive;
    case 'retired':
      return INTEGRATION_COPY.secretRetired;
  }
}

/**
 * 確認の結果を、運用が読める言葉にする。
 *
 * ⚠️ **知らない符号を推測で言い換えない。** 決めつけると、
 * 実際は別の原因だったときに調査が遠回りになる。
 */
export function checkDetailLabel(check: ConnectionCheckView): string {
  if (check.succeeded) {
    if (check.httpStatus === null) {
      return '';
    }
    /*
      ⚠️ 4xx でも「届いた」として扱っている。こちらが送るのは
         本文の無い問い合わせで、受け取り専用の経路では 404 や 405 が
         正しい応答になる。ただし綴り違いも同じ見え方をするので、
         状態コードは隠さずに出す。
    */
    if (check.httpStatus >= 400) {
      return `届きましたが、応答は ${String(check.httpStatus)} でした。接続先の綴りをご確認ください`;
    }
    return `応答 ${String(check.httpStatus)}`;
  }

  switch (check.failureCode) {
    case null:
      return '';
    case 'timeout':
      return '時間内に応答がありませんでした';
    case 'http_5xx':
      return `提携先で問題が起きています（${String(check.httpStatus ?? 0)}）`;
    case 'SETTINGS_CHANGED':
      return '接続先を変えたため、この結果は使えなくなりました';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '接続先の名前を引けませんでした。URL をご確認ください';
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EPIPE':
      return '接続できませんでした。提携先の状況をご確認ください';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return '接続先の証明書を確認できませんでした';
    default:
      // 知らない符号は、そのまま出す。勝手な理由を断定しない。
      return check.failureCode;
  }
}
