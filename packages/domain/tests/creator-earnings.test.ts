import { describe, expect, it } from 'vitest';
import {
  EARNINGS_CSV_COLUMNS,
  buildEarningsCsv,
  estimateFromDraft,
  summarizeByArtwork,
  toEarningsCsvRows,
} from '../src/creator/earnings';
import { buildPayoutDraft } from '../src/settlement/payout';
import { payoutPeriodOf } from '../src/settlement/period';
import type { PayoutLineDraft } from '../src/settlement/payout';

/**
 * 作家さまが見る売上（実運営 指示書 P1-2）。
 *
 * ⚠️ **この組の主題は 3 つ。**
 *  1. **見込みと実額が同じ計算であること。** 別の式で出すと、締めたときに
 *     額が変わり、そのたびに「話が違う」という問い合わせになる
 *  2. **差し戻しを「売れた数」から黙って引かないこと**
 *  3. **CSV に買った方の情報が入らないこと**
 */

const PERIOD = payoutPeriodOf(2026, 8);
const NOW = new Date('2026-09-20T00:00:00.000Z');
const DUE = new Date('2026-09-30T14:59:59.000Z');

function line(overrides: Partial<PayoutLineDraft> = {}): PayoutLineDraft {
  return {
    orderId: 'order-1',
    orderNumber: 'SNK-20260801-0001',
    artworkTitleSnapshot: '桜図',
    grossAmount: 12_000,
    feeRateBps: 2000,
    feeAmount: 2_400,
    netAmount: 9_600,
    isClawback: false,
    ...overrides,
  };
}

describe('見込みは、締めた精算と同じ計算で出す', () => {
  /*
    ⚠️ **この試験がこの画面の存在理由。** 見込みを別の式で出した瞬間、
       締めたときに額が変わる。作家さまは「話が違う」と感じる。
  */
  it('`buildPayoutDraft` の結果をそのまま写す', () => {
    const draft = buildPayoutDraft({
      period: PERIOD,
      creatorAccountId: 'creator-1',
      candidates: [
        {
          orderId: 'order-1',
          orderNumber: 'SNK-20260801-0001',
          creatorAccountId: 'creator-1',
          artworkTitleSnapshot: '桜図',
          paidAt: new Date('2026-08-01T00:00:00.000Z'),
          grossAmount: 12_000,
          feeRateBps: 2000,
          feeAmount: 2_400,
          netAmount: 9_600,
          refundableUntil: new Date('2026-08-15T00:00:00.000Z'),
          isUnderDispute: false,
        },
      ],
      clawbacks: [],
      carriedInAmount: 0,
      minimumPayoutAmount: 1_000,
      transferFeeBearer: 'creator',
      now: NOW,
    });

    const estimate = estimateFromDraft({ draft, dueAt: DUE });

    expect(estimate.grossAmount).toBe(draft.grossAmount);
    expect(estimate.feeAmount).toBe(draft.feeAmount);
    expect(estimate.netAmount).toBe(draft.netAmount);
    expect(estimate.carriedOutAmount).toBe(draft.carriedOutAmount);
    expect(estimate.minimumPayoutAmount).toBe(draft.minimumPayoutAmount);
  });

  /*
    ⚠️ **確定した額と同じ顔をさせない。** 型の段階で区別する。
  */
  it('締めていないことが状態で分かる', () => {
    const draft = buildPayoutDraft({
      period: PERIOD,
      creatorAccountId: 'creator-1',
      candidates: [],
      clawbacks: [],
      carriedInAmount: 0,
      minimumPayoutAmount: 1_000,
      transferFeeBearer: 'creator',
      now: NOW,
    });
    expect(estimateFromDraft({ draft, dueAt: DUE }).state).toBe('estimate');
  });

  /*
    ⚠️ **「なぜまだ確定しないのか」の答えを作家さまにも見せる。**
  */
  it('返金を受け付けている注文の数を持ち回る', () => {
    const draft = buildPayoutDraft({
      period: PERIOD,
      creatorAccountId: 'creator-1',
      candidates: [
        {
          orderId: 'order-1',
          orderNumber: 'SNK-20260801-0001',
          creatorAccountId: 'creator-1',
          artworkTitleSnapshot: '桜図',
          paidAt: new Date('2026-08-20T00:00:00.000Z'),
          grossAmount: 12_000,
          feeRateBps: 2000,
          feeAmount: 2_400,
          netAmount: 9_600,
          // まだ閉じていない。
          refundableUntil: new Date('2026-10-01T00:00:00.000Z'),
          isUnderDispute: false,
        },
      ],
      clawbacks: [],
      carriedInAmount: 0,
      minimumPayoutAmount: 1_000,
      transferFeeBearer: 'creator',
      now: NOW,
    });
    expect(estimateFromDraft({ draft, dueAt: DUE }).openRefundWindows).toBe(1);
  });
});

describe('作品ごとのまとめ', () => {
  it('同じ作品名をまとめる', () => {
    const rows = summarizeByArtwork([line(), line({ orderId: 'order-2' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.soldCount).toBe(2);
    expect(rows[0]?.netAmount).toBe(19_200);
  });

  /*
    ⚠️ **売れたことと、返ってきたことは別の事実。** 引くと「売れていない」
       ように見え、何が起きたのか読み取れない。
  */
  it('差し戻しを「売れた数」から引かない', () => {
    const rows = summarizeByArtwork([
      line(),
      line({
        orderId: 'order-2',
        isClawback: true,
        netAmount: -9_600,
        grossAmount: -12_000,
        feeAmount: -2_400,
      }),
    ]);
    expect(rows[0]?.soldCount).toBe(1);
    expect(rows[0]?.clawbackCount).toBe(1);
    // ⚠️ 金額は符号込みで足す。
    expect(rows[0]?.netAmount).toBe(0);
  });

  /*
    ⚠️ **改名した作品は、改名の前後で別の行になる。** 過去の明細に
       新しい名前をかぶせると、当時の書類と突き合わせられなくなる。
  */
  it('注文時点の名前で束ねる', () => {
    const rows = summarizeByArtwork([
      line({ artworkTitleSnapshot: '桜図' }),
      line({ orderId: 'order-2', artworkTitleSnapshot: '桜図（改訂）' }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('手取りの多い順に並ぶ', () => {
    const rows = summarizeByArtwork([
      line({ artworkTitleSnapshot: '少ない方', netAmount: 1_000 }),
      line({ orderId: 'order-2', artworkTitleSnapshot: '多い方', netAmount: 5_000 }),
    ]);
    expect(rows.map((row) => row.artworkTitleSnapshot)).toEqual(['多い方', '少ない方']);
  });

  it('同額なら名前順で安定する', () => {
    const rows = summarizeByArtwork([
      line({ artworkTitleSnapshot: 'いろは', netAmount: 1_000 }),
      line({ orderId: 'order-2', artworkTitleSnapshot: 'あいう', netAmount: 1_000 }),
    ]);
    expect(rows.map((row) => row.artworkTitleSnapshot)).toEqual(['あいう', 'いろは']);
  });

  it('明細が無ければ空', () => {
    expect(summarizeByArtwork([])).toEqual([]);
  });
});

describe('CSV', () => {
  /*
    ⚠️ **買った方の情報を 1 つも入れない。** 明細は作家さまの手元へ落ちて、
       表計算やメールに渡っていく。落ちた先まではこちらの管理が及ばない。
  */
  it('列に買った方の情報が無い', () => {
    const joined = EARNINGS_CSV_COLUMNS.join(',');
    for (const forbidden of ['氏名', 'メール', '住所', '電話', 'お客']) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it('注文番号は載せる（問い合わせの照合に要る）', () => {
    expect([...EARNINGS_CSV_COLUMNS]).toContain('注文番号');
  });

  /*
    ⚠️ **表計算ソフトの事故を避ける。** 作品名は作家さまが自由に付けられる。
       先頭が `=` の値は、開いた人の手元で数式として動く。
  */
  it('数式として解釈される作品名を無害化する', () => {
    const rows = toEarningsCsvRows({
      periodKey: '2026-08',
      lines: [line({ artworkTitleSnapshot: '=SUM(A1:A9)' })],
    });
    expect(rows[0]?.[2]).toBe("'=SUM(A1:A9)");
  });

  it('消さずに前へ付ける（作品名が変わってしまわないように）', () => {
    const rows = toEarningsCsvRows({
      periodKey: '2026-08',
      lines: [line({ artworkTitleSnapshot: '-桜図' })],
    });
    expect(rows[0]?.[2]).toContain('-桜図');
  });

  it('区分で販売と差し戻しを分ける', () => {
    const rows = toEarningsCsvRows({
      periodKey: '2026-08',
      lines: [line(), line({ orderId: 'order-2', isClawback: true })],
    });
    expect(rows[0]?.[7]).toBe('販売');
    expect(rows[1]?.[7]).toBe('差し戻し');
  });

  it('手数料率は % で出す', () => {
    const rows = toEarningsCsvRows({ periodKey: '2026-08', lines: [line({ feeRateBps: 2000 })] });
    expect(rows[0]?.[4]).toBe('20.00');
  });

  it('見出しの行が付き、引用符が二重になる', () => {
    const csv = buildEarningsCsv(
      toEarningsCsvRows({
        periodKey: '2026-08',
        lines: [line({ artworkTitleSnapshot: '"桜"図' })],
      }),
    );
    const [header, first] = csv.split('\r\n');
    expect(header).toContain('"注文番号"');
    expect(first).toContain('"""桜""図"');
  });

  it('明細が無くても見出しだけは出る', () => {
    expect(buildEarningsCsv([])).toBe(
      EARNINGS_CSV_COLUMNS.map((column) => `"${column}"`).join(','),
    );
  });
});
