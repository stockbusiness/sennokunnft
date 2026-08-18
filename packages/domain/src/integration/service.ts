/**
 * 外部連携の対象と環境（管理画面・外部連携 指示書 §3）。
 *
 * ⚠️ **「キー名と値を自由入力する設定画面」を作らない。**
 * サービスごとに許された項目だけを受け取る。自由入力にすると、
 * 綴り違いの設定名が黙って保存され、どれが効いているのか分からなくなる。
 */

export const INTEGRATION_SERVICES = ['ovew_wallet', 'storage', 'auth'] as const;
export type IntegrationService = (typeof INTEGRATION_SERVICES)[number];

/**
 * 設定を持つ環境。
 *
 * ⚠️ **`APP_ENV` とは別物。** あちらは「このプロセスがどの環境か」で、
 * こちらは「どの環境向けの設定か」。1 つのプロセスが両方の設定を
 * 保持でき、実際に使うのは自分の `APP_ENV` に対応するほうだけ。
 * 混ぜると、staging の接続先へ本番の鍵を送る事故が起きうる。
 */
export const INTEGRATION_ENVIRONMENTS = ['staging', 'production'] as const;
export type IntegrationEnvironment = (typeof INTEGRATION_ENVIRONMENTS)[number];

export function isIntegrationService(value: string): value is IntegrationService {
  return (INTEGRATION_SERVICES as readonly string[]).includes(value);
}

export function isIntegrationEnvironment(value: string): value is IntegrationEnvironment {
  return (INTEGRATION_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * サービスと環境の組。暗号文の結び付け情報（AAD）にも使う。
 *
 * ⚠️ **区切り文字を値に現れないものにする。** サービス名と環境名は
 * どちらも決まった語彙なので `:` で安全に繋げる。将来ここへ自由入力の
 * 値を混ぜるなら、長さ付きの符号化に変えること。
 */
export function integrationScope(
  service: IntegrationService,
  environment: IntegrationEnvironment,
): string {
  return `${service}:${environment}`;
}
