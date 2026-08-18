import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';
import type { IntegrationEnvironment, IntegrationService } from './service';

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

export interface EnableInput {
  readonly settings: IntegrationSettings;
  readonly hasActiveSecret: boolean;
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
  */
  if (settings.keyId === null) {
    return err(domainError('INTEGRATION_SETTINGS_INVALID', 'key id is not configured'));
  }
  if (!input.hasActiveSecret) {
    return err(domainError('INTEGRATION_SECRET_MISSING', 'no active secret'));
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
