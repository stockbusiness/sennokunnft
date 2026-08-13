import { beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { IdempotencyService, IDEMPOTENCY_TTL_MS } from '../src/common/idempotency';
import { FixedClock, InMemoryIdempotencyStore, TEST_NOW } from './helpers/doubles';

/**
 * 冪等キーの占有（API_DESIGN.md §3）。
 *
 * ⚠️ ここで確かめたいのは「2 回目が前回の結果を返すこと」だけではない。
 * **1 回目がまだ終わっていないときに 2 回目を走らせないこと**が本題。
 * 「探して無ければ実行」だと、同時に来た 2 本が両方実行されてしまう。
 */

const ACTOR = 'account-1';
const KEY = '01J8Z7Q4XXXXXXXXXXXXXXXXXX';

let store: InMemoryIdempotencyStore;
let service: IdempotencyService;

beforeEach(() => {
  store = new InMemoryIdempotencyStore();
  service = new IdempotencyService(store, new FixedClock(TEST_NOW));
});

describe('占有（先に場所を取る）', () => {
  it('最初の呼び出しは占有できる', async () => {
    const outcome = await service.begin(ACTOR, KEY, 'digest-a');
    expect(outcome.kind).toBe('proceed');
  });

  it('処理中に同じキーが来たら実行させない（409）', async () => {
    // ここが「探して無ければ実行」との差。1 本目が complete する前に
    // 2 本目が来ても、2 本目は実行に進めない。
    await service.begin(ACTOR, KEY, 'digest-a');

    await expect(service.begin(ACTOR, KEY, 'digest-a')).rejects.toSatisfy(
      (error) =>
        error instanceof ConflictException &&
        (error.getResponse() as { error: { code: string } }).error.code ===
          'IDEMPOTENCY_IN_PROGRESS',
    );
  });

  it('完了後の同じ再送は前回の結果を返す（処理は走らない）', async () => {
    const first = await service.begin<{ id: string }>(ACTOR, KEY, 'digest-a');
    if (first.kind !== 'proceed') throw new Error('占有できるはず');
    await first.claim.complete(200, { id: 'artwork-1' });

    const second = await service.begin<{ id: string }>(ACTOR, KEY, 'digest-a');
    expect(second.kind).toBe('replay');
    if (second.kind !== 'replay') return;
    expect(second.body).toEqual({ id: 'artwork-1' });
  });

  it('同じキーで内容が違えば 409', async () => {
    const first = await service.begin(ACTOR, KEY, 'digest-a');
    if (first.kind !== 'proceed') throw new Error('占有できるはず');
    await first.claim.complete(200, { id: 'artwork-1' });

    await expect(service.begin(ACTOR, KEY, 'digest-b')).rejects.toSatisfy(
      (error) =>
        error instanceof ConflictException &&
        (error.getResponse() as { error: { code: string } }).error.code === 'IDEMPOTENCY_CONFLICT',
    );
  });
});

describe('解放（失敗したキーを塞いだままにしない）', () => {
  it('失敗して解放したキーは、もう一度使える', async () => {
    // 解放しないと、一度失敗しただけで利用者がやり直せなくなる。
    const first = await service.begin(ACTOR, KEY, 'digest-a');
    if (first.kind !== 'proceed') throw new Error('占有できるはず');
    await first.claim.release();

    const retry = await service.begin(ACTOR, KEY, 'digest-a');
    expect(retry.kind).toBe('proceed');
  });

  it('完了済みのキーは解放しても消えない', async () => {
    // 完了しているなら、それは正しい応答として残すべきもの。
    const first = await service.begin(ACTOR, KEY, 'digest-a');
    if (first.kind !== 'proceed') throw new Error('占有できるはず');
    await first.claim.complete(200, { id: 'artwork-1' });
    await first.claim.release();

    const second = await service.begin(ACTOR, KEY, 'digest-a');
    expect(second.kind).toBe('replay');
  });
});

describe('アクターの区切りと期限', () => {
  it('他人が使ったキーを当てても、他人の応答は読めない', async () => {
    const first = await service.begin(ACTOR, KEY, 'digest-a');
    if (first.kind !== 'proceed') throw new Error('占有できるはず');
    await first.claim.complete(200, { secret: 'ほかの人のデータ' });

    // 別のアクターは同じキーでも新規に占有できる（＝前の応答は見えない）。
    const other = await service.begin('account-2', KEY, 'digest-a');
    expect(other.kind).toBe('proceed');
  });

  it('期限を過ぎたキーは未使用として扱う', async () => {
    const first = await service.begin(ACTOR, KEY, 'digest-a');
    if (first.kind !== 'proceed') throw new Error('占有できるはず');
    await first.claim.complete(200, { id: 'artwork-1' });

    // 時計を進める。実装が自分で時刻を読んでいたら、この操作は効かない。
    const later = new Date(TEST_NOW.getTime() + IDEMPOTENCY_TTL_MS + 1);
    const expired = new IdempotencyService(store, new FixedClock(later));

    const outcome = await expired.begin(ACTOR, KEY, 'digest-a');
    expect(outcome.kind).toBe('proceed');
  });
});
