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

/**
 * 管理画面から設定を変えられるサービス。
 *
 * ⚠️ **ここに無いサービスは、画面から保存できない。**
 * 保存できても誰も読まない設定を受け付けるのは、嘘をつくのと同じ。
 * 「保存できたのに効かない」は、効かない理由を誰も説明できない状態を作る。
 *
 * `storage`（Cloudflare R2）を入れていない理由:
 *  - 保存先のアダプタは api の起動時に 1 個作る。DB を変えても効かない。
 *    効かせるには送信ごとに解決する作りへ変える必要があり、それは
 *    指示書 §14 の「R2 アダプターの無断変更」にあたる。
 *  - 本番のストレージ自体がまだ決まっていない（`UD-508`）。
 *    決まる前に切り替えの口を作ると、決めたときに作り直しになる。
 *
 * `auth`（Supabase Auth）を入れていない理由:
 *  - 誤ると**全員が締め出される**。しかも直す経路がログインの先にある。
 *    取り返しのつかなさが、ほかの設定と桁違い。
 *  - 指示書 §14 が「Supabase の認証方式変更」を禁じている。
 *
 * ⚠️ **どちらも「状態を見る」ことはできる。** 見えないと、
 * 設定が欠けていることに配備してから気づくことになる。
 */
export const MANAGED_INTEGRATION_SERVICES = ['ovew_wallet'] as const;

/** その連携を管理画面から変えてよいか。 */
export function isManagedFromAdmin(service: IntegrationService): boolean {
  return (MANAGED_INTEGRATION_SERVICES as readonly string[]).includes(service);
}

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
