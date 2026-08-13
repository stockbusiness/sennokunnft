import { describe, expect, it, vi } from 'vitest';
import { WorkerRunner, type JobHandler, type RunnerLogger } from '../src/runner';

function silentLogger(): RunnerLogger & { errors: Record<string, unknown>[] } {
  const errors: Record<string, unknown>[] = [];
  return {
    errors,
    info: () => undefined,
    error: (payload) => {
      errors.push(payload);
    },
  };
}

function handler(name: string, impl: () => Promise<number>): JobHandler {
  return { name, runOnce: impl };
}

describe('WorkerRunner.runOnce', () => {
  it('ハンドラがなくても正常に完了する（Phase 1 の最小構成）', async () => {
    const runner = new WorkerRunner({ handlers: [], logger: silentLogger(), pollIntervalMs: 10 });
    const result = await runner.runOnce();
    expect(result).toEqual({ processed: 0, failures: 0 });
  });

  it('すべてのハンドラを実行し、処理件数を合算する', async () => {
    const runner = new WorkerRunner({
      handlers: [handler('a', () => Promise.resolve(2)), handler('b', () => Promise.resolve(3))],
      logger: silentLogger(),
      pollIntervalMs: 10,
    });
    const result = await runner.runOnce();
    expect(result.processed).toBe(5);
  });

  it('1つのハンドラが失敗しても他を止めない（障害の連鎖を防ぐ）', async () => {
    const second = vi.fn(() => Promise.resolve(1));
    const logger = silentLogger();
    const runner = new WorkerRunner({
      handlers: [
        handler('failing', () => Promise.reject(new Error('boom'))),
        handler('healthy', second),
      ],
      logger,
      pollIntervalMs: 10,
    });

    const result = await runner.runOnce();

    expect(second).toHaveBeenCalledOnce();
    expect(result.failures).toBe(1);
    expect(result.processed).toBe(1);
  });

  it('失敗ログに例外の詳細メッセージを含めない', async () => {
    const logger = silentLogger();
    const runner = new WorkerRunner({
      handlers: [
        handler('failing', () => Promise.reject(new Error('connection to secret-host failed'))),
      ],
      logger,
      pollIntervalMs: 10,
    });

    await runner.runOnce();

    expect(JSON.stringify(logger.errors)).not.toContain('secret-host');
    expect(logger.errors[0]?.error).toBe('Error');
  });
});

describe('WorkerRunner の停止', () => {
  it('停止要求を受けるとループを抜ける', async () => {
    const logger = silentLogger();
    let iterations = 0;
    const runner = new WorkerRunner({
      handlers: [
        handler('counting', () => {
          iterations += 1;
          if (iterations >= 3) {
            runner.requestStop();
          }
          return Promise.resolve(1);
        }),
      ],
      logger,
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
    });

    await runner.runForever();

    expect(iterations).toBe(3);
    expect(runner.isRunning()).toBe(false);
  });

  it('進行中の 1 巡を中断せず、完了してから止まる', async () => {
    // 送信途中で殺すと、外部へ送ったかどうか不明な行が残り自動復旧できない。
    const logger = silentLogger();
    let completed = false;
    const runner = new WorkerRunner({
      handlers: [
        handler('slow', async () => {
          runner.requestStop();
          await Promise.resolve();
          completed = true;
          return 1;
        }),
      ],
      logger,
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
    });

    await runner.runForever();

    expect(completed).toBe(true);
  });

  it('停止要求後は残りのハンドラを開始しない', async () => {
    const logger = silentLogger();
    const later = vi.fn(() => Promise.resolve(1));
    const runner = new WorkerRunner({
      handlers: [
        handler('first', () => {
          runner.requestStop();
          return Promise.resolve(1);
        }),
        handler('second', later),
      ],
      logger,
      pollIntervalMs: 1,
    });

    await runner.runOnce();

    expect(later).not.toHaveBeenCalled();
  });
});
