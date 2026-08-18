import type { IntegrationEnvironment, IntegrationRepository } from '@sengoku/domain';

/**
 * 送信のたびに接続先と鍵を解決する（要決定 03）。
 *
 * ⚠️ **起動時に 1 個作って使い回さない。** 管理画面で鍵を交換しても、
 * worker を再起動するまで古い鍵で送り続けることになる。手順で埋める前提は、
 * 忘れられたときに「古い鍵で送り続けている」ことに誰も気づけない。
 *
 * ⚠️ **1 巡ごとに解決する（1 行ごとではない）。** 1 巡は数件・数秒なので、
 * 反映の速さは実用上変わらない。それでいて、解決に失敗したときに
 * **行を掴む前に止められる**。行ごとに解決すると、掴んでから失敗するので
 * 試行回数だけが減っていき、設定を直す前に `DEAD` へ落ちる。
 */

export interface ResolvedWalletDelivery {
  readonly endpoint: string;
  readonly keyId: string;
  /** ⚠️ ログにも例外にも出さない。 */
  readonly secret: string;
  readonly timeoutMs: number;
  /** どこから読んだか。運用ログに出す（値そのものは出さない）。 */
  readonly source: 'database' | 'environment';
}

export type ResolveFailure =
  /** 管理画面から止められている。**環境変数へ落ちない。** */
  | 'disabled'
  /** 管理画面で設定の途中。鍵か鍵IDが揃っていない。 */
  | 'incomplete';

export type ResolveResult =
  | { readonly ok: true; readonly config: ResolvedWalletDelivery }
  | { readonly ok: false; readonly reason: ResolveFailure };

/** 環境変数から読んだ設定（DB に設定が無いときの落ち先）。 */
export interface EnvWalletDelivery {
  readonly endpoint: string;
  readonly keyId: string;
  readonly secret: string;
  readonly timeoutMs: number;
}

export interface WalletDeliveryResolverOptions {
  /**
   * 設定の保管庫。
   *
   * ⚠️ **暗号鍵が無い環境では `null` を渡す。** 見に行っても復号できず、
   * 毎巡「半端な設定」で止まる。落ち先（環境変数）だけで動かすほうが正しい。
   */
  readonly integrations: IntegrationRepository | null;
  /** このプロセスがどの環境か。⚠️ 設定の `environment` とは別物。 */
  readonly appEnvironment: IntegrationEnvironment;
  /**
   * DB に設定が無いときの落ち先。
   *
   * ⚠️ **落ち先を残しておく。** PR 1〜2 の移行期間は、環境変数を正として
   * 動いている環境がある。落ちる先が無い状態で切り替えると、
   * 管理画面を一度も開いていない環境で配送が止まる。
   */
  readonly fallback: EnvWalletDelivery | null;
}

/**
 * 解決の規則。
 *
 * 1. DB に接続先が入っていれば、**DB が正**。
 *    - 止められていれば送らない。**環境変数へ落ちない。**
 *      落ちてしまうと、管理画面の「停止」が効かない。事故を止める操作が
 *      効かないのがいちばん困る。
 *    - 鍵か鍵IDが欠けていれば送らない。半端な設定で送っても必ず断られる。
 * 2. DB に接続先が入っていなければ、環境変数へ落ちる。
 *    管理画面を開いただけで行はできる（`ensureSettings`）ので、
 *    **行の有無ではなく接続先の有無**で「引き継いだか」を判定する。
 */
export function createWalletDeliveryResolver(
  options: WalletDeliveryResolverOptions,
): () => Promise<ResolveResult> {
  return async (): Promise<ResolveResult> => {
    const integrations = options.integrations;
    const settings =
      integrations === null
        ? null
        : await integrations.findSettings('ovew_wallet', options.appEnvironment);

    const adopted =
      settings !== null && settings.endpointUrl !== null && settings.endpointUrl !== '';

    if (!adopted) {
      const fallback = options.fallback;
      if (fallback === null) {
        return { ok: false, reason: 'incomplete' };
      }
      return { ok: true, config: { ...fallback, source: 'environment' } };
    }

    // ここから先、`settings` は非 null（`adopted` の条件に含まれている）。
    const row = settings;
    if (!row.enabled) {
      return { ok: false, reason: 'disabled' };
    }
    if (row.keyId === null) {
      return { ok: false, reason: 'incomplete' };
    }

    // `adopted` が真ということは保管庫がある。
    const secret = await (integrations as IntegrationRepository).revealForAdapter(
      'ovew_wallet',
      options.appEnvironment,
      'hmac_secret',
    );
    if (secret === null) {
      return { ok: false, reason: 'incomplete' };
    }

    return {
      ok: true,
      config: {
        endpoint: row.endpointUrl ?? '',
        keyId: row.keyId,
        secret,
        timeoutMs: row.timeoutMs,
        source: 'database',
      },
    };
  };
}
