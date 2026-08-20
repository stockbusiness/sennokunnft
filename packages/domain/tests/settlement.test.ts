import { describe, expect, it } from 'vitest';
import {
  refundableUntil,
  validateSettlementSettings,
  type SettlementSettings,
} from '../src/settlement/settings';

/**
 * 返金と精算の取り決め（`UD-104` / `UD-119`。決定 2026-08-20）。
 *
 * ⚠️ ここで守りたいのは 3 つ。
 *   1. **`0` を「未設定」と混同しないこと。** 返金日数の `0` は
 *      「お申し出による返金を受け付けない」という正しい設定である。
 *   2. **返金の窓が精算より後に閉じる設定を通さないこと。** 通すと、
 *      支払い済みの注文が返金されるのが常態になり、作家さまから
 *      返してもらう作業が毎月発生する。
 *   3. **期限は「焼き付けるため」にだけ計算されること。** 設定を変えても
 *      過去の注文の期限が動かない、という性質はここが起点になる。
 */

const BASE: SettlementSettings = {
  refundWindowDays: 14,
  payoutOffsetMonths: 1,
  minimumPayoutAmount: 1_000,
  transferFeeBearer: 'creator',
};

function validate(overrides: Partial<SettlementSettings>) {
  return validateSettlementSettings({ ...BASE, ...overrides });
}

describe('validateSettlementSettings', () => {
  it('決めた既定（14 日・翌月末・1,000 円・作家さま負担）を通す', () => {
    const result = validateSettlementSettings(BASE);
    expect(result.ok).toBe(true);
  });

  it('返金日数 0 を通す（「受け付けない」は正しい設定）', () => {
    // ⚠️ 金額と違い、ここでの 0 は「未設定」ではない。
    const result = validate({ refundWindowDays: 0 });
    expect(result.ok).toBe(true);
  });

  it('最低支払額 0 を通す（繰り越しをしない運用）', () => {
    expect(validate({ minimumPayoutAmount: 0 }).ok).toBe(true);
  });

  it('返金日数が精算の猶予を超える設定を断る', () => {
    /*
      猶予 1 か月（最短 28 日と見る）に対して 30 日の返金期間。
      通すと「支払い済みの注文が返金される」が常態になる。
    */
    const result = validate({ refundWindowDays: 30, payoutOffsetMonths: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SETTLEMENT_SETTINGS_INVALID');
    }
  });

  it('猶予 0 か月では、返金日数 0 しか通らない', () => {
    // ⚠️ 「締めたその場で払う」なら、返金の窓が開いていてはいけない。
    expect(validate({ refundWindowDays: 0, payoutOffsetMonths: 0 }).ok).toBe(true);
    expect(validate({ refundWindowDays: 1, payoutOffsetMonths: 0 }).ok).toBe(false);
  });

  it('猶予を伸ばせば長い返金期間も通る', () => {
    expect(validate({ refundWindowDays: 30, payoutOffsetMonths: 2 }).ok).toBe(true);
  });

  it('打ち間違いの桁を止める（上限を超える値）', () => {
    // ⚠️ 3650 日（10 年）が通ると、その間ずっと精算できない注文が積み上がる。
    expect(validate({ refundWindowDays: 3_650, payoutOffsetMonths: 6 }).ok).toBe(false);
    expect(validate({ payoutOffsetMonths: 24 }).ok).toBe(false);
    expect(validate({ minimumPayoutAmount: 1_000_000 }).ok).toBe(false);
  });

  it('負の値を断る', () => {
    expect(validate({ refundWindowDays: -1 }).ok).toBe(false);
    expect(validate({ payoutOffsetMonths: -1 }).ok).toBe(false);
    expect(validate({ minimumPayoutAmount: -1 }).ok).toBe(false);
  });

  it('小数を断る（金額は円の整数、日数は日の整数）', () => {
    expect(validate({ refundWindowDays: 1.5 }).ok).toBe(false);
    expect(validate({ minimumPayoutAmount: 999.5 }).ok).toBe(false);
  });

  it('数でない値を断る', () => {
    expect(validate({ refundWindowDays: Number.NaN }).ok).toBe(false);
    expect(validate({ minimumPayoutAmount: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });
});

describe('refundableUntil', () => {
  it('決済確定から日数を足した時刻になる', () => {
    const paidAt = new Date('2026-08-20T05:00:00.000Z');
    expect(refundableUntil(paidAt, 14).toISOString()).toBe('2026-09-03T05:00:00.000Z');
  });

  it('0 日なら決済確定と同じ時刻（窓が開かない）', () => {
    const paidAt = new Date('2026-08-20T05:00:00.000Z');
    expect(refundableUntil(paidAt, 0).getTime()).toBe(paidAt.getTime());
  });

  it('渡した日時を書き換えない', () => {
    // ⚠️ Date は可変。呼び出し側の値を壊すと、同じ取引の別の処理が狂う。
    const paidAt = new Date('2026-08-20T05:00:00.000Z');
    refundableUntil(paidAt, 14);
    expect(paidAt.toISOString()).toBe('2026-08-20T05:00:00.000Z');
  });
});
