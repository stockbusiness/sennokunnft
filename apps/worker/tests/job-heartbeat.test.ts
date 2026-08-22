import { describe, expect, it } from 'vitest';
import { JOB_LABELS } from '@sengoku/domain';
import { withJobHeartbeat, WORKER_JOB_KEYS, type JobRunRecorderPort } from '../src/job-heartbeat';
import { SCHEDULED_INTERNAL_JOBS } from '../src/internal-job-caller';
import type { JobHandler, RunnerLogger } from '../src/runner';

const NOW = new Date('2026-08-22T09:00:00.000Z');

type RecordedRun = Parameters<JobRunRecorderPort['recordJobRun']>[0];

function stubLogger(): RunnerLogger & {
  readonly lines: { payload: Record<string, unknown>; message: string }[];
} {
  const lines: { payload: Record<string, unknown>; message: string }[] = [];
  return {
    lines,
    info: (payload, message) => lines.push({ payload, message }),
    warn: (payload, message) => lines.push({ payload, message }),
    error: (payload, message) => lines.push({ payload, message }),
  };
}

function stubRecorder(options?: { readonly throws?: Error }): JobRunRecorderPort & {
  readonly runs: RecordedRun[];
} {
  const runs: RecordedRun[] = [];
  return {
    runs,
    recordJobRun: (input) => {
      runs.push(input);
      return options?.throws === undefined ? Promise.resolve() : Promise.reject(options.throws);
    },
  };
}

function stubHandler(result: number | Error): JobHandler & { calls: number } {
  const handler = {
    calls: 0,
    name: 'reservation-release',
    runOnce: (): Promise<number> => {
      handler.calls += 1;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return handler;
}

describe('worker の心拍', () => {
  it('成功したら、見張っている種別で「成功」を控える', async () => {
    const recorder = stubRecorder();
    const wrapped = withJobHeartbeat({
      handler: stubHandler(3),
      jobKey: 'release-expired-reservations',
      recorder,
      now: () => NOW,
      logger: stubLogger(),
    });

    expect(await wrapped.runOnce()).toBe(3);
    expect(recorder.runs).toEqual([
      {
        jobKey: 'release-expired-reservations',
        outcome: 'succeeded',
        pickedCount: 3,
        now: NOW,
      },
    ]);
  });

  /*
    ⚠️ **これが本題。** 0 件でも控えを書かないと、暇な日が続いただけで
       画面は「まだ一度も成功していません」のままになる。**何も無かった
       ことと、動いていないことは違う。**
  */
  it('0 件でも「成功」を控える', async () => {
    const recorder = stubRecorder();
    const wrapped = withJobHeartbeat({
      handler: stubHandler(0),
      jobKey: 'release-expired-reservations',
      recorder,
      now: () => NOW,
      logger: stubLogger(),
    });

    expect(await wrapped.runOnce()).toBe(0);
    expect(recorder.runs).toHaveLength(1);
    expect(recorder.runs[0]?.outcome).toBe('succeeded');
    expect(recorder.runs[0]?.pickedCount).toBe(0);
  });

  it('失敗したら「失敗」を控え、例外はそのまま投げ直す', async () => {
    const recorder = stubRecorder();
    const failure = new TypeError('接続できません');
    const handler = stubHandler(failure);
    const wrapped = withJobHeartbeat({
      handler,
      jobKey: 'deliver-entitlements',
      recorder,
      now: () => NOW,
      logger: stubLogger(),
    });

    await expect(wrapped.runOnce()).rejects.toThrow(failure);
    expect(recorder.runs).toEqual([
      {
        jobKey: 'deliver-entitlements',
        outcome: 'failed',
        errorCode: 'TypeError',
        now: NOW,
      },
    ]);
  });

  /*
    ⚠️ **例外の本文を控えへ入れない。** 外部 API の応答や DB のメッセージ
       には、購入者や接続先が混じりうる。
  */
  it('控えに例外の本文を載せない', async () => {
    const recorder = stubRecorder();
    const wrapped = withJobHeartbeat({
      handler: stubHandler(new Error('buyer@example.com への送信に失敗')),
      jobKey: 'deliver-entitlements',
      recorder,
      now: () => NOW,
      logger: stubLogger(),
    });

    await expect(wrapped.runOnce()).rejects.toThrow();
    expect(JSON.stringify(recorder.runs)).not.toContain('buyer@example.com');
  });

  /*
    ⚠️ **控えが書けないことで仕事を止めない。** 見張りのために
       お取り置きの解放が止まるのは本末転倒。
  */
  it('控えが書けなくても、仕事の結果は返す', async () => {
    const recorder = stubRecorder({ throws: new Error('DB へ書けません') });
    const logger = stubLogger();
    const wrapped = withJobHeartbeat({
      handler: stubHandler(2),
      jobKey: 'release-expired-reservations',
      recorder,
      now: () => NOW,
      logger,
    });

    expect(await wrapped.runOnce()).toBe(2);
    // ⚠️ 黙って飲み込まない。実体のない障害を運営に追わせないため。
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.message).toContain('控えを書けませんでした');
  });

  it('控えが書けなくても、仕事の例外は握りつぶさない', async () => {
    const recorder = stubRecorder({ throws: new Error('DB へ書けません') });
    const failure = new Error('掃除に失敗');
    const wrapped = withJobHeartbeat({
      handler: stubHandler(failure),
      jobKey: 'release-expired-reservations',
      recorder,
      now: () => NOW,
      logger: stubLogger(),
    });

    await expect(wrapped.runOnce()).rejects.toThrow(failure);
  });

  it('包んでもハンドラの名前を変えない（ランナーのログが追えなくなる）', () => {
    const wrapped = withJobHeartbeat({
      handler: stubHandler(0),
      jobKey: 'release-expired-reservations',
      recorder: stubRecorder(),
      now: () => NOW,
      logger: stubLogger(),
    });

    expect(wrapped.name).toBe('reservation-release');
  });

  it('仕事は 1 巡につき 1 回しか呼ばない', async () => {
    const handler = stubHandler(1);
    const wrapped = withJobHeartbeat({
      handler,
      jobKey: 'release-expired-reservations',
      recorder: stubRecorder(),
      now: () => NOW,
      logger: stubLogger(),
    });

    await wrapped.runOnce();
    expect(handler.calls).toBe(1);
  });
});

describe('worker が控える種別名', () => {
  /*
    ⚠️ **これが「直した黄色がまた戻る」を防ぐ唯一の縛り。** 種別名を
       打ち間違えても、ジョブは動くし控えも増える。増えないのは
       **画面が見ている種別の控えだけ**なので、誰も気づけない。
  */
  it('画面の呼び名（JOB_LABELS）に載っている', () => {
    for (const jobKey of Object.values(WORKER_JOB_KEYS)) {
      expect(Object.keys(JOB_LABELS)).toContain(jobKey);
    }
  });

  /*
    ⚠️ **API の内部ジョブの一覧と重ならないこと。** 重ねると同じ待ち行列を
       2 経路から掃き、控えも 2 か所から書かれる。
  */
  it('API を叩く一覧と重ならない', () => {
    const paths = SCHEDULED_INTERNAL_JOBS.map((job) => job.path);
    for (const jobKey of Object.values(WORKER_JOB_KEYS)) {
      expect(paths).not.toContain(jobKey);
    }
  });
});
