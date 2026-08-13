import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger as PinoLogger } from 'pino';
import { redact } from './redact';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  /** どのプロセスのログかを識別する名前（`api` / `worker` / `web`）。 */
  readonly service: string;
  readonly level?: LogLevel;
  /** 出力先。テストで差し替えられるようにしてある。既定は標準出力。 */
  readonly destination?: pino.DestinationStream;
}

export interface RequestContext {
  /** リクエスト単位の相関ID。全ログに自動付与される。 */
  readonly requestId: string;
}

const contextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * 相関IDを持つコンテキストの中で処理を実行する。
 *
 * AsyncLocalStorage を使うことで、ロガーを引数で持ち回らずに
 * すべてのログへ `requestId` を付けられる。
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return contextStorage.run(context, fn);
}

export function currentRequestId(): string | undefined {
  return contextStorage.getStore()?.requestId;
}

export type Logger = PinoLogger;

/**
 * 構造化ロガーを作る。
 *
 * 常に JSON を出力する。整形表示の切り替えを持たせていないのは、
 * 環境ごとに出力経路を分けるとマスキングの適用漏れが起きやすいため
 * （SECURITY_DESIGN.md §4「開発時だけ詳細ログ」を作らない）。
 * すべてのログは `redact` を通るので、秘匿キーの値は自動的に伏せられる。
 */
export function createLogger(options: LoggerOptions): Logger {
  const { service, level = 'info', destination } = options;

  const baseOptions: pino.LoggerOptions = {
    level,
    base: { service },
    formatters: {
      level: (label: string) => ({ level: label }),
      // すべてのログオブジェクトがここを通る。マスキングを回避する経路を作らない。
      log: (object: Record<string, unknown>): Record<string, unknown> => {
        const requestId = currentRequestId();
        const redacted = redact(object) as Record<string, unknown>;
        return requestId === undefined ? redacted : { ...redacted, requestId };
      },
    },
    // pino 既定のシリアライザは Error のスタックを出すため、独自処理に任せる。
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (destination !== undefined) {
    return pino(baseOptions, destination);
  }

  // 標準出力へは**同期書き込み**する。
  // 既定のバッファリングだと、起動直後のログや異常終了直前のログが
  // フラッシュされずに失われる。障害調査でいちばん必要になるのは
  // まさにその区間なので、書き込み性能よりも取りこぼさないことを優先する。
  return pino(baseOptions, pino.destination({ dest: 1, sync: true }));
}
