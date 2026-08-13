import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@sengoku/observability';

/**
 * NestJS 内部のログを、共通の構造化ロガーへ流す。
 *
 * これを入れないと、フレームワークが出す起動ログだけが
 * 色付きの平文で出力され、**マスキングもされない**まま残る。
 * ログ出力の経路を 1 本にまとめることで、
 * 「この経路だけ秘匿値が素通りする」状態を作らない。
 */
export class NestStructuredLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.info(this.toPayload(optional), this.toMessage(message));
  }

  error(message: unknown, ...optional: unknown[]): void {
    // スタックトレースには内部パスが含まれるため、そのままは載せない。
    this.logger.error(this.toPayload(optional), this.toMessage(message));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn(this.toPayload(optional), this.toMessage(message));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(this.toPayload(optional), this.toMessage(message));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.trace(this.toPayload(optional), this.toMessage(message));
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    this.logger.fatal(this.toPayload(optional), this.toMessage(message));
  }

  private toMessage(message: unknown): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
  }

  /** Nest は末尾に context 名を渡してくる。それだけを構造化フィールドに取る。 */
  private toPayload(optional: readonly unknown[]): Record<string, unknown> {
    const context = optional.at(-1);
    return typeof context === 'string' ? { nestContext: context } : {};
  }
}
