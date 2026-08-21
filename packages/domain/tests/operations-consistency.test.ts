import { describe, expect, it } from 'vitest';
import {
  CONSISTENCY_CHECK_KEYS,
  CONSISTENCY_SAMPLE_LIMIT,
  buildConsistencyFindings,
  type ConsistencyCounts,
} from '../src/operations/consistency';

/** 記録の食い違い（実運営 指示書 P0-6「システム整合性チェック」）。 */

const EMPTY: ConsistencyCounts = {
  paidWithoutEntitlements: [],
  supplyDrift: [],
  revokedWithoutWalletNotice: [],
  claimedWithoutDelivery: [],
  unmaskedRecipient: [],
};

describe('食い違いの一覧', () => {
  /*
    ⚠️ **0 件のものも返す。** 消すと「調べたのか、調べていないのか」が
       区別できない。調べて 0 件だったことを示すのがこの画面の値打ち。
  */
  it('食い違いが無くても、調べた項目をすべて返す', () => {
    const findings = buildConsistencyFindings(EMPTY);
    expect(findings.map((row) => row.key)).toEqual([...CONSISTENCY_CHECK_KEYS]);
    expect(findings.every((row) => row.count === 0)).toBe(true);
    expect(findings.every((row) => row.severity === 'normal')).toBe(true);
  });

  it('0 件でも次の一手は用意しておく（見つかったときにすぐ動けるように）', () => {
    expect(buildConsistencyFindings(EMPTY).every((row) => row.action !== '')).toBe(true);
  });

  it('1 件でもあれば色が付く', () => {
    const findings = buildConsistencyFindings({ ...EMPTY, paidWithoutEntitlements: ['order-1'] });
    const row = findings.find((item) => item.key === 'paid_without_entitlements');
    expect(row?.count).toBe(1);
    expect(row?.severity).toBe('critical');
  });

  /*
    ⚠️ **繋ぐ前なら正常な姿。** Wallet 連携より前のお受け取りは
       配送の行を持たない。赤にすると、過去のぶんで毎回赤くなる。
  */
  it('お受け取り済みで配送の記録が無いものは黄色に留まる', () => {
    const findings = buildConsistencyFindings({ ...EMPTY, claimedWithoutDelivery: ['e-1'] });
    expect(findings.find((row) => row.key === 'claimed_without_delivery')?.severity).toBe(
      'warning',
    );
  });

  /*
    ⚠️ **DB の CHECK があるので本来 0 件。** 1 件でもあれば制約を
       迂回した経路がある（`UD-503`）。
  */
  it('伏せていない宛先は 1 件でも赤', () => {
    const findings = buildConsistencyFindings({ ...EMPTY, unmaskedRecipient: ['n-1'] });
    expect(findings.find((row) => row.key === 'unmasked_recipient')?.severity).toBe('critical');
  });

  it('手がかりは上限までしか返さない（数千件で画面が固まらないように）', () => {
    const ids = Array.from(
      { length: CONSISTENCY_SAMPLE_LIMIT + 25 },
      (_, i) => `order-${String(i)}`,
    );
    const row = buildConsistencyFindings({ ...EMPTY, paidWithoutEntitlements: ids }).find(
      (item) => item.key === 'paid_without_entitlements',
    );
    // ⚠️ 件数は全件のまま。切り詰めるのは手がかりだけ。
    expect(row?.count).toBe(ids.length);
    expect(row?.sampleIds).toHaveLength(CONSISTENCY_SAMPLE_LIMIT);
  });
});
