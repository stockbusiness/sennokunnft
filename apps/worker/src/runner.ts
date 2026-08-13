/**
 * ジョブ実行ループ。
 *
 * ⚠️ Phase 1 では**実際のジョブを処理しない**。
 * ここで用意するのは、起動・停止・エラー隔離といった「器」だけである。
 * 発行ジョブの本実装は Phase 5（チェーン仕様の決定後）。
 */

export interface JobHandler {
  readonly name: string;
  /**
   * 1 回分の処理を行い、処理した件数を返す。
   *
   * 例外を投げてよい。ランナーが捕捉してログに残し、
   * 他のハンドラの実行を止めない。
   */
  runOnce(): Promise<number>;
}

export interface RunnerLogger {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface RunnerOptions {
  readonly handlers: readonly JobHandler[];
  readonly logger: RunnerLogger;
  /** 常駐モードでのポーリング間隔。 */
  readonly pollIntervalMs: number;
  /** 待機の実装。テストから差し替えられるようにしてある。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunOnceResult {
  readonly processed: number;
  readonly failures: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * ワーカー本体。
 *
 * **常駐モードと 1 回実行モードの両方**を持つ。
 * デプロイ先が常駐プロセスを許すかが未決定（UD-302）なため、
 * cron 起動の環境でも動くようにしてある。
 */
export class WorkerRunner {
  private stopping = false;
  private running = false;

  constructor(private readonly options: RunnerOptions) {}

  /**
   * 全ハンドラを 1 巡させる。
   *
   * 1 つのハンドラが失敗しても他を止めない。
   * 「発行ジョブが落ちたせいで期限切れ注文の回収まで止まる」という
   * 障害の連鎖を避けるため。
   */
  async runOnce(): Promise<RunOnceResult> {
    let processed = 0;
    let failures = 0;

    for (const handler of this.options.handlers) {
      if (this.stopping) {
        break;
      }
      try {
        processed += await handler.runOnce();
      } catch (error) {
        failures += 1;
        // エラーの詳細（外部APIの本文など）は載せない。分類できる情報のみ残す。
        this.options.logger.error(
          { handler: handler.name, error: error instanceof Error ? error.name : 'UnknownError' },
          'ジョブハンドラが失敗しました',
        );
      }
    }

    return { processed, failures };
  }

  /** 停止要求が来るまでポーリングし続ける。 */
  async runForever(): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    this.running = true;
    this.options.logger.info(
      { handlers: this.options.handlers.map((handler) => handler.name) },
      'worker started',
    );

    while (!this.stopping) {
      await this.runOnce();
      if (this.stopping) {
        break;
      }
      await sleep(this.options.pollIntervalMs);
    }

    this.running = false;
    this.options.logger.info({}, 'worker stopped');
  }

  /**
   * 停止を要求する。
   *
   * ⚠️ **進行中の処理を強制終了しない。**
   * 発行ジョブを送信途中で殺すと、外部へ送ったかどうかが分からない行が残り、
   * 自動復旧できなくなる（LAZY_MINT_FLOW.md §3.6）。
   * 現在の 1 巡が終わるまで待ってから止まる。
   */
  requestStop(): void {
    this.stopping = true;
  }

  isRunning(): boolean {
    return this.running;
  }
}
