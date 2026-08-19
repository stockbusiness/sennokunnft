import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';
import type { IntegrationEnvironment, IntegrationService } from './service';
import type { SecretPurpose } from './secret';
import { isSalesSetupComplete, type PaymentSettingsFields } from './payment-settings';

/**
 * 外部連携の設定（指示書 §4・§9）。
 *
 * ⚠️ **「設定の保存成功」と「接続成功」を混ぜない。**
 * 保存は自分の DB へ書けたというだけで、相手に届くかは別の話。
 * 混ぜると「保存できたから繋がっている」と読まれる。
 */

export interface IntegrationSettings {
  readonly id: string;
  readonly service: IntegrationService;
  readonly environment: IntegrationEnvironment;
  readonly endpointUrl: string | null;
  /**
   * 署名に使う鍵の識別子。
   *
   * ⚠️ **秘密ではない。** 鍵そのものは資格情報の側にある。
   * ここに入るのは署名ヘッダへそのまま載る名前で、伏せる必要が無い。
   * 伏せてしまうと、取り違えたときに画面から確かめられなくなる。
   */
  readonly keyId: string | null;
  readonly apiVersion: string | null;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly enabled: boolean;
  /**
   * 決済にだけ意味のある欄。ほかの連携では既定値のまま使わない。
   *
   * ⚠️ **1 つの表に全サービスの欄を並べている。** 連携ごとに表を分けると、
   * 有効化・接続テスト・監査ログの仕組みも同じ数だけ増える。増えた分は
   * いつか片方だけ直される。欄が余ることのほうを受け入れている。
   */
  readonly payment: PaymentSettingsFields;
  /** 楽観ロック用。読んだときの値を書き戻しで送る。 */
  readonly rowVersion: number;
}

export interface UpdateSettingsInput {
  readonly endpointUrl?: string | null;
  readonly keyId?: string | null;
  readonly apiVersion?: string | null;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

/**
 * 設定を書き換える。
 *
 * ⚠️ **接続先を変えたら、それまでの接続テストの成功は無効になる。**
 * 別の相手に対する成功だからで、そのまま有効化を許すと
 * 「テスト済み」の顔をした未確認の接続先が本番に載る。
 * 呼び出し側は、戻り値の `endpointChanged` を見て記録を無効化すること。
 */
export interface UpdatedSettings {
  readonly settings: IntegrationSettings;
  readonly endpointChanged: boolean;
}

export function updateSettings(
  settings: IntegrationSettings,
  input: UpdateSettingsInput,
): Result<UpdatedSettings, DomainError> {
  const endpointUrl = input.endpointUrl === undefined ? settings.endpointUrl : input.endpointUrl;

  if (endpointUrl !== null && endpointUrl !== '') {
    // ⚠️ **https に限る。** 平文で送ると、経路上で資格情報を抜かれる。
    //    値そのものは例外へ載せない（ホスト名が混ざる）。
    if (!endpointUrl.startsWith('https://')) {
      return err(domainError('INTEGRATION_ENDPOINT_INSECURE', 'endpoint must be https'));
    }
  }

  const timeoutMs = input.timeoutMs ?? settings.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    return err(domainError('INTEGRATION_SETTINGS_INVALID', 'timeoutMs out of range'));
  }

  const maxAttempts = input.maxAttempts ?? settings.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    return err(domainError('INTEGRATION_SETTINGS_INVALID', 'maxAttempts out of range'));
  }

  return ok({
    settings: {
      ...settings,
      endpointUrl: endpointUrl === '' ? null : endpointUrl,
      keyId: normalizeKeyId(input.keyId === undefined ? settings.keyId : input.keyId),
      apiVersion: input.apiVersion === undefined ? settings.apiVersion : input.apiVersion,
      timeoutMs,
      maxAttempts,
    },
    endpointChanged: endpointUrl !== settings.endpointUrl,
  });
}

/** 空文字を `null` に寄せる。「入れたつもりで空」を有効な値にしない。 */
function normalizeKeyId(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value.trim();
}

/**
 * その連携を動かすのに要る資格情報。
 *
 * ⚠️ **決済は 2 本要る。** 支払い口を作るための秘密鍵と、通知の署名を
 * 検証するための鍵。片方だけでは「支払い口は作れるが入金を確定できない」
 * という、いちばん質の悪い半端な状態になる。
 */
export function requiredSecretPurposes(service: IntegrationService): readonly SecretPurpose[] {
  switch (service) {
    case 'ovew_wallet':
      return ['hmac_secret'];
    /*
      決済の鍵は**この保管庫に置かない**（2026-08-19 決定）。秘密鍵も
      Webhook 署名鍵も配備環境の Secret 管理に置く。管理画面から
      交換できる仕組みは、再認証・二者承認・ローテーション・復旧経路まで
      揃えた別仕様として扱う。半端に口だけ開けると、
      「画面から替えられるが、間違えたときに戻せない」状態になる。
    */
    case 'payment':
    default:
      return [];
  }
}

/**
 * その連携の資格情報を、この保管庫で預かるか。
 *
 * ⚠️ **偽のときは登録の口そのものが断る。** 画面で隠すだけにすると、
 * 直接叩けば預かれてしまい、置かないと決めた場所に鍵が残る。
 */
export function storesSecrets(service: IntegrationService): boolean {
  return service === 'ovew_wallet';
}

export interface EnableInput {
  readonly settings: IntegrationSettings;
  /** いま有効になっている資格情報の用途。 */
  readonly activeSecretPurposes: readonly SecretPurpose[];
  readonly lastCheck: { readonly succeeded: boolean; readonly executedAt: Date } | null;
  readonly freshnessMs: number;
  readonly now: Date;
}

/**
 * 連携を有効にする。
 *
 * ⚠️ **接続テストの成功なしに有効化させない**（指示書 §9・§14）。
 * 有効にした瞬間から本物の送信が始まる。届かない設定で有効にすると、
 * 失敗が溜まってから気づくことになる。
 *
 * ⚠️ **有効化の条件を環境で緩めない。** staging でも同じ条件を課す。
 * 緩めると、staging で通した手順がそのまま production では通らず、
 * 「本番だけ余計な手順がある」と受け取られて回避される。
 */
export function enableIntegration(input: EnableInput): Result<IntegrationSettings, DomainError> {
  const { settings, lastCheck, now } = input;

  if (settings.endpointUrl === null || settings.endpointUrl === '') {
    return err(domainError('INTEGRATION_SETTINGS_INVALID', 'endpoint is not configured'));
  }
  /*
    ⚠️ **鍵の識別子も揃っていることを条件にする。** 署名ヘッダに載る値で、
       欠けていると相手は誰の署名か分からず、必ず断られる。
       有効化してから毎回断られるより、有効化の前に止める。

       決済には鍵の識別子が無い（署名ヘッダに載せる仕組みではない）ので
       課さない。無い概念を必須にすると、埋めるための嘘の値が入る。
  */
  if (settings.service !== 'payment' && settings.keyId === null) {
    return err(domainError('INTEGRATION_SETTINGS_INVALID', 'key id is not configured'));
  }

  for (const purpose of requiredSecretPurposes(settings.service)) {
    if (!input.activeSecretPurposes.includes(purpose)) {
      return err(domainError('INTEGRATION_SECRET_MISSING', `no active secret: ${purpose}`));
    }
  }

  if (settings.service === 'payment') {
    /*
      ⚠️ **手数料率 0 のまま有効にしない。** 0 は「無料」ではなく
         「まだ決めていない」。決めないまま売れると、こちらの取り分が
         無い注文が成立し、あとから請求し直すことはできない。

      ⚠️ **戻り先はここで必須にしない。** 配備環境の値を引き継いで
         動いている状態がありうる。欠けていれば支払い口の作成が断る。
    */
    if (!isSalesSetupComplete(settings.payment)) {
      return err(domainError('PAYMENT_SETTINGS_INVALID', 'fee rate is not configured'));
    }
  }

  if (lastCheck === null || !lastCheck.succeeded) {
    return err(domainError('INTEGRATION_CHECK_REQUIRED', 'no successful connection check'));
  }
  if (now.getTime() - lastCheck.executedAt.getTime() > input.freshnessMs) {
    return err(domainError('INTEGRATION_CHECK_STALE', 'connection check is too old'));
  }

  return ok({ ...settings, enabled: true });
}

/**
 * 連携を止める。
 *
 * ⚠️ **止めるほうに条件を付けない。** 事故を止める操作なので、
 * いつでも通らなければならない。条件を足すと、止めたいときに止められない。
 */
export function disableIntegration(settings: IntegrationSettings): IntegrationSettings {
  return { ...settings, enabled: false };
}

/**
 * 接続テストの成功が、いま有効とみなせるか（指示書 §9）。
 *
 * ⚠️ **画面の表示と有効化の判定で、同じ関数を使う。** 別々に書くと、
 * 「画面では有効に見えるのに有効化できない」がいつか生まれる。
 */
export function isCheckFresh(
  check: { readonly succeeded: boolean; readonly executedAt: Date } | null,
  freshnessMs: number,
  now: Date,
): boolean {
  if (check === null || !check.succeeded) {
    return false;
  }
  return now.getTime() - check.executedAt.getTime() <= freshnessMs;
}

/**
 * 接続テストの成功が有効とみなされる長さ（要決定 07 で 30 分に決定）。
 *
 * ⚠️ **長くしない。** 長いほど「設定を直してからテストせずに有効化」が
 * 通りやすくなり、この仕組み自体が形だけになる。
 */
export const CHECK_FRESHNESS_MS = 30 * 60 * 1000;
