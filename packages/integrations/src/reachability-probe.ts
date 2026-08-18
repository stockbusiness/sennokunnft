import type { ClockPort, ProbeOutcome } from '@sengoku/domain';

/**
 * 接続先へ届くかどうかだけを確かめる（指示書 §4.3・要決定 06）。
 *
 * ⚠️ **業務データを 1 バイトも送らない。** 指示書 §4.3 は
 * 「安全なテスト手段がなければ実送信ボタンを作らない」と定めている。
 * OVEW Wallet 側にテスト用の受け口があるかは、こちらでは確認できていない。
 * だから送るのは、本文を持たない `OPTIONS` だけにする。
 *
 * ⚠️ **`POST` を「空の本文で」送らない。** 相手の経路は受取権を作る口で、
 * 空だろうと不正だろうと、届いた時点で何が起きるかはこちらには分からない。
 * 「たぶん弾かれる」を根拠に本番の相手へ投げない。
 *
 * ⚠️ **署名を付けない。** 付ければ資格情報の正しさまで確かめられるように
 * 見えるが、それを確かめられる受け口があるかを知らないまま送ることになる。
 * この確認で分かるのは**到達性まで**で、それ以上を装わない。
 *
 * ⚠️ **これは「接続テスト」の全部ではない。** 資格情報が正しいかどうかは
 * 別の話で、いまは確かめる手段が無い。画面には必ずそう書くこと。
 */
export interface ReachabilityProbeOptions {
  readonly clock: ClockPort;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ProbeResult {
  readonly outcome: ProbeOutcome;
  readonly durationMs: number;
}

/**
 * 接続できなかったときの符号のうち、そのまま出してよいもの。
 *
 * ⚠️ **許可した符号だけを通す。** Node の例外に載る `cause` には、
 * 実装によってホスト名や証明書の主体名が混ざる。名前を見て通すのではなく、
 * **知っている名前だけ**を通す。知らないものは `network` に丸める。
 */
const SAFE_ERROR_CODES = new Set([
  // 名前を引けなかった
  'ENOTFOUND',
  'EAI_AGAIN',
  // 相手が受け付けなかった / 経路が無い
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  // 証明書まわり
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class ReachabilityProbe {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ReachabilityProbeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async probe(endpointUrl: string): Promise<ProbeResult> {
    const started = this.options.clock.now().getTime();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(endpointUrl, {
        // ⚠️ 本文を持たない方法にする。相手に何も起こさせない。
        method: 'OPTIONS',
        // ⚠️ リダイレクトを追わない。追うと、確かめたのは
        //    「設定した接続先」ではなく「その先」になる。
        redirect: 'manual',
        signal: controller.signal,
      });
      return {
        outcome: { kind: 'response', statusCode: response.status },
        durationMs: this.elapsed(started),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { outcome: { kind: 'timeout' }, durationMs: this.elapsed(started) };
      }
      return {
        outcome: { kind: 'network', code: safeCodeOf(error) },
        durationMs: this.elapsed(started),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private elapsed(startedMs: number): number {
    // ⚠️ 負にならないようにする。時計が巻き戻ることは実際にある。
    return Math.max(0, this.options.clock.now().getTime() - startedMs);
  }
}

/**
 * 例外から、出してよい符号だけを取り出す。
 *
 * ⚠️ **例外のメッセージを使わない。** URL や証明書の主体名が入りうる。
 */
function safeCodeOf(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  const code = (cause as { code?: unknown })?.code ?? (error as { code?: unknown }).code;
  if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) {
    return code;
  }
  return null;
}
