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

  historyHeading: '確かめた記録',
  columnCheckedAt: '日時',
  columnResult: '結果',
  columnDetail: '内容',
  columnDuration: '所要',
  noChecks: 'まだ確かめていません',
  noChecksHint: '上の「接続を確かめる」を押してください。',
  checkOk: '届きました',
  checkNg: '届きませんでした',

  enableHeading: 'お届けの開始と停止',
  submitEnable: 'お届けを始める',
  submitDisable: 'お届けを止める',
  /** ⚠️ 押せるのに何も起きない、を作らない。理由を先に出す。 */
  enableBlocked: 'いまは始められません',
  enableBlockedHint:
    '接続先・鍵の名前・お預かりした鍵・直近の接続確認（30 分以内の成功）が、すべてそろっている必要があります。',
  disableHint: '止めるのはいつでもできます。押すとすぐに新しいお届けが止まります。',
} as const;

/** どの提携先か。⚠️ 内部の名前をそのまま出さない。 */
export function integrationServiceLabel(service: IntegrationStatusView['service']): string {
  switch (service) {
    case 'ovew_wallet':
      return 'お受け取り先（OVEW Wallet）';
    case 'storage':
      return '画像の保管先';
    case 'auth':
      return 'ログイン';
  }
}

export function secretPurposeLabel(purpose: 'api_key' | 'hmac_secret'): string {
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
