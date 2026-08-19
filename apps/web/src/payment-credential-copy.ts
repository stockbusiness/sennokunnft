/**
 * 決済資格情報の世代の画面文言（`UD-118`）。
 *
 * ⚠️ **鍵に触れる言葉を慎重に選ぶ。** 「確認できます」と書くと、見えると
 * 期待させる。一度預けたら二度と表示しない。
 */
export const PAYMENT_CREDENTIAL_COPY = {
  title: '決済の資格情報',
  description:
    'お支払いを扱う事業者アカウントの鍵を、世代として管理します。運営会社が変わったときも、過去のご注文の返金経路が残るようにするための仕組みです。',

  /** ⚠️ 二重管理が黙って復活している状態。いちばん気づきにくい。 */
  emergencyOverride: '緊急上書きが有効になっています',
  emergencyOverrideHint:
    '配備環境の鍵が使われています。復旧が済んだら PAYMENT_EMERGENCY_CREDENTIAL_OVERRIDE を false へ戻してください。',

  cannotAccept: 'いまお支払いを受け付けられません',
  cannotAcceptHint:
    '新規のお支払いを受け付ける世代がありません。鍵を登録し、接続テストを行ってから有効化してください。',

  registerHeading: '新しい世代を登録する',
  registerHint:
    '登録しただけでは何も起きません。接続テストを行い、有効化してはじめて新規のお支払いに使われます。',
  fieldLabel: '覚え書き',
  /** ⚠️ 秘密を書かせない。 */
  fieldLabelHint: '「旧運営」「新会社」など。⚠️ 鍵やパスワードは書かないでください。',
  fieldSecretKey: '秘密鍵',
  fieldSecretKeyHint: '一度お預かりすると、二度と表示できません。お手元にも控えを残してください。',
  fieldWebhookSecret: 'Webhook 署名鍵',
  fieldApiVersion: 'API の版（任意）',
  submitRegister: 'この鍵を登録する',

  listHeading: 'これまでの世代',
  statusPending: '登録済み（未使用）',
  statusActive: '有効',
  statusRetired: '退役',
  accepting: '新規のお支払いを受付中',
  notAccepting: '新規の受付なし（返金と照会には使われます）',
  accountRef: '事業者アカウント',
  accountRefUnknown: '（接続テスト未実施）',
  lastCheck: '最終接続テスト',
  lastCheckNever: '未実施',
  lastCheckOk: '成功',
  lastCheckFailed: '失敗',
  lastWebhook: '最後にお知らせが届いた日時',
  paymentCount: 'この世代で扱ったお支払い',
  verifiable: '署名の確認対象',
  notVerifiable: '確認対象外（保持上限を超えています）',

  buttonCheck: '接続テストを行う',
  buttonActivate: 'この世代へ切り替える',
  buttonStopAccepting: '新規の受付を止める',
  buttonResumeAccepting: '新規の受付に戻す',
  buttonRetire: '退役させる',

  confirmationLabel: '確認のため「production」と入力してください',
  /** ⚠️ 押し慣れを防ぐ。「本当によろしいですか」の一段だけにしない。 */
  confirmationHint:
    '本番の設定です。切り替えると、これ以降のお支払いは新しい事業者アカウントへ入金されます。',

  activateWarning: '切り替えても、過去のご注文の返金経路は残ります',
  activateWarningHint:
    '前の世代は「新規の受付なし」になるだけで、退役はしません。返金と照会には引き続き使われます。',

  errorForbidden: '権限がありません。オーナーにご依頼ください。',
  errorReauth: 'お手数ですが、もう一度ログインしてからお試しください。',
  errorUnavailable: 'ただいま処理できませんでした。しばらくしてからお試しください。',
} as const;

export function paymentCredentialError(code: string | undefined, reason: string): string {
  switch (code) {
    case 'PAYMENT_CREDENTIAL_CHECK_REQUIRED':
      return '先に接続テストを行い、成功させてください。鍵の入力間違いをここで防いでいます。';
    case 'PAYMENT_CREDENTIAL_IN_USE':
      return 'この世代はいま新規のお支払いを受け付けています。先に切り替えてください。';
    case 'PAYMENT_CREDENTIAL_NOT_ACTIVATABLE':
      return 'この世代は有効化できません。画面を読み込み直してご確認ください。';
    case 'CONFIRMATION_REQUIRED':
      return '確認のため「production」と入力してください。';
    default:
      /*
        ⚠️ 401 は「権限が無い」ではなく「ログインし直せば通る」。
           言い分けないと、オーナー本人が権限を疑うことになる。
      */
      return reason === 'unauthorized'
        ? PAYMENT_CREDENTIAL_COPY.errorReauth
        : PAYMENT_CREDENTIAL_COPY.errorUnavailable;
  }
}
