import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, redact, REDACTED, runWithRequestContext } from '../src/index';

describe('redact（TEST_STRATEGY §3.8 L-1/L-2/L-3）', () => {
  it('秘匿キーの値を伏せる', () => {
    const result = redact({ password: 'hunter2', token: 'abc', userId: 'u-1' }) as Record<
      string,
      unknown
    >;
    expect(result.password).toBe(REDACTED);
    expect(result.token).toBe(REDACTED);
    // 秘匿対象でない値はそのまま残す（調査可能性のため）。
    expect(result.userId).toBe('u-1');
  });

  it('キー名の表記ゆれを吸収する', () => {
    const result = redact({
      API_KEY: 'x',
      'private-key': 'y',
      accessKey: 'z',
      Authorization: 'w',
    }) as Record<string, unknown>;
    expect(Object.values(result)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it('個人情報のキーを伏せる', () => {
    const result = redact({
      email: 'a@example.com',
      phone: '090-0000-0000',
      postalCode: '100-0001',
      cardNumber: '4242424242424242',
    }) as Record<string, unknown>;
    expect(Object.values(result)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it('Claim トークンを伏せる（L-3）', () => {
    const result = redact({ claimToken: 'secret-claim-token' }) as Record<string, unknown>;
    expect(result.claimToken).toBe(REDACTED);
  });

  it('入れ子のオブジェクトを再帰的に処理する（L-2）', () => {
    const result = redact({
      order: { id: 'o-1', payment: { cardNumber: '4242', amount: 1000 } },
    }) as Record<string, Record<string, Record<string, unknown>>>;
    expect(result.order!.payment!.cardNumber).toBe(REDACTED);
    expect(result.order!.payment!.amount).toBe(1000);
  });

  it('配列の中も処理する（L-2）', () => {
    const result = redact([{ secret: 'a' }, { secret: 'b' }]) as Record<string, unknown>[];
    expect(result.map((item) => item.secret)).toEqual([REDACTED, REDACTED]);
  });

  it('Error はスタックトレースを落として名前とメッセージのみ残す', () => {
    const result = redact(new Error('boom')) as Record<string, unknown>;
    expect(result).toEqual({ name: 'Error', message: 'boom' });
    expect(result.stack).toBeUndefined();
  });

  it('深すぎる構造を打ち切る（循環参照の保険）', () => {
    type Nested = { next?: Nested };
    const root: Nested = {};
    let cursor = root;
    for (let i = 0; i < 20; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(JSON.stringify(redact(root))).toContain('[TRUNCATED]');
  });

  it('入力を破壊しない', () => {
    const input = { password: 'hunter2' };
    redact(input);
    expect(input.password).toBe('hunter2');
  });
});

/** ロガーの出力行を集めるテスト用ストリーム。 */
function captureLogs(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('JSON 構造化ログを出力する', () => {
    const capture = captureLogs();
    const logger = createLogger({ service: 'test', destination: capture.stream });
    logger.info({ orderId: 'o-1' }, 'order created');

    const [entry] = capture.lines();
    expect(entry?.service).toBe('test');
    expect(entry?.orderId).toBe('o-1');
    expect(entry?.msg).toBe('order created');
  });

  it('ログ出力時に秘匿値がマスクされる（L-1）', () => {
    const capture = captureLogs();
    const logger = createLogger({ service: 'test', destination: capture.stream });
    logger.info({ authorization: 'Bearer aaa.bbb.ccc', claimToken: 'zzz' }, 'incoming');

    const raw = JSON.stringify(capture.lines());
    expect(raw).not.toContain('Bearer aaa.bbb.ccc');
    expect(raw).not.toContain('zzz');
    expect(raw).toContain(REDACTED);
  });

  it('相関IDが全ログに付与される', () => {
    const capture = captureLogs();
    const logger = createLogger({ service: 'test', destination: capture.stream });

    runWithRequestContext({ requestId: 'req-123' }, () => {
      logger.info('first');
      logger.info('second');
    });

    const entries = capture.lines();
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.requestId === 'req-123')).toBe(true);
  });

  it('コンテキスト外では相関IDが付かない', () => {
    const capture = captureLogs();
    const logger = createLogger({ service: 'test', destination: capture.stream });
    logger.info('no context');
    expect(capture.lines()[0]?.requestId).toBeUndefined();
  });
});
