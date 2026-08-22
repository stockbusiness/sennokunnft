import type { PayoutDraft, PayoutLineDraft } from '../settlement/payout';
import type { PayoutPeriod } from '../settlement/period';

/**
 * 作家さまが見る売上（実運営 指示書 P1-2）。
 *
 * **作家さまは「今月いくら入るのか」を知りたい。** それが分からないと、
 * 制作を続けるかどうかの判断ができない。締めるまで何も見えない作りは、
 * こちらの都合でしかない。
 *
 * ⚠️ **見込みも実額も、同じ関数で計算する**（`buildPayoutDraft`）。
 * 別の式で「見込み」を出すと、締めたときに額が変わり、そのたびに
 * 「話が違う」という問い合わせになる。**見込みと実額がずれないことが、
 * この画面の唯一の存在理由**である。
 *
 * ⚠️ **繰越は「預かり金」ではない。** 最低支払額に満たないときに翌月へ送る
 * だけで、こちらのものになるわけではない。文言でもそう扱わない。
 */

/** 期間 1 つぶんの売上。⚠️ 締めた月も、締めていない月も同じ形。 */
export interface CreatorPeriodEarnings {
  readonly periodKey: string;
  readonly period: PayoutPeriod;
  /**
   * この期間の精算がどうなっているか。
   *
   * ⚠️ **`estimate` は「まだ締めていない」。** 確定した額ではないことを、
   * 型の段階で区別する。画面の文言も、ここから作る。
   */
  readonly state: 'estimate' | 'draft' | 'confirmed' | 'paid';
  /** 販売額（税込）の合計。 */
  readonly grossAmount: number;
  readonly feeAmount: number;
  /** 差し戻した額。⚠️ 正の数で持つ。 */
  readonly refundedAmount: number;
  readonly carriedInAmount: number;
  /** 今回のお支払額。⚠️ 最低支払額に満たなければ 0。 */
  readonly netAmount: number;
  readonly carriedOutAmount: number;
  readonly minimumPayoutAmount: number;
  /** お支払いの期日。⚠️ 締めた期間は焼き付けた値、見込みは計算値。 */
  readonly dueAt: Date;
  /**
   * まだ返金を受け付けている注文の数。
   *
   * ⚠️ **0 でなければ確定しない。** 作家さまにも見せる——「なぜまだ
   * 確定しないのか」の答えがこれだから。
   */
  readonly openRefundWindows: number;
  /**
   * 決着待ちのため今回は載せなかったご注文の数（決定 B・2026-08-22）。
   *
   * ⚠️ **作家さまにも見せる。** 合計だけ減ると「なぜ今月は少ないのか」が
   * 読めない。差し戻しを明細に載せているのと同じ理由である。
   */
  readonly deferredDisputeCount: number;
  /**
   * 決着待ちで載せなかったぶんの、作家さまの取り分の合計。
   *
   * ⚠️ **「来月これだけ入る」と読ませない。** 負ければ返金となり払われない。
   * 画面の文言でそう伝える。
   */
  readonly deferredDisputeAmount: number;
}

/** 見込みを、締めた精算と同じ形に整える。⚠️ 計算はしない。写すだけ。 */
export function estimateFromDraft(input: {
  readonly draft: PayoutDraft;
  readonly dueAt: Date;
}): CreatorPeriodEarnings {
  const { draft } = input;
  return {
    periodKey: draft.period.key,
    period: draft.period,
    // ⚠️ **まだ締めていない。** 確定した額と同じ顔をさせない。
    state: 'estimate',
    grossAmount: draft.grossAmount,
    feeAmount: draft.feeAmount,
    refundedAmount: draft.refundedAmount,
    carriedInAmount: draft.carriedInAmount,
    netAmount: draft.netAmount,
    carriedOutAmount: draft.carriedOutAmount,
    minimumPayoutAmount: draft.minimumPayoutAmount,
    dueAt: input.dueAt,
    openRefundWindows: draft.openRefundWindows,
    deferredDisputeCount: draft.deferredDisputeCount,
    deferredDisputeAmount: draft.deferredDisputeAmount,
  };
}

/** 作品ごとの売れ行き。⚠️ 作品名は注文時点のもの（改名しても明細は変わらない）。 */
export interface ArtworkSales {
  /** ⚠️ 注文時点の作品名で束ねる。マスタを引き直さない。 */
  readonly artworkTitleSnapshot: string;
  /** 売れた数。⚠️ 差し戻しは引く。 */
  readonly soldCount: number;
  readonly grossAmount: number;
  readonly feeAmount: number;
  readonly netAmount: number;
  /** 差し戻された数。⚠️ 別に出す。売れた数から黙って引かない。 */
  readonly clawbackCount: number;
}

/**
 * 明細を作品ごとにまとめる。
 *
 * ⚠️ **差し戻しを「売れた数」から黙って引かない。** 引くと、作家さまには
 * 「売れていない」ように見える。**売れたことと、返ってきたことは別の事実**で、
 * 両方を出さないと何が起きたのか読み取れない。
 *
 * ⚠️ **作品IDではなく注文時点の名前で束ねる。** 改名した作品は、改名の
 * 前後で別の行になる——それが明細として正しい。過去の明細に新しい名前を
 * かぶせると、当時の書類と突き合わせられなくなる。
 */
export function summarizeByArtwork(lines: readonly PayoutLineDraft[]): readonly ArtworkSales[] {
  const byTitle = new Map<string, ArtworkSales>();

  for (const line of lines) {
    const current = byTitle.get(line.artworkTitleSnapshot) ?? {
      artworkTitleSnapshot: line.artworkTitleSnapshot,
      soldCount: 0,
      grossAmount: 0,
      feeAmount: 0,
      netAmount: 0,
      clawbackCount: 0,
    };

    byTitle.set(line.artworkTitleSnapshot, {
      artworkTitleSnapshot: line.artworkTitleSnapshot,
      soldCount: current.soldCount + (line.isClawback ? 0 : 1),
      // ⚠️ 金額は符号込みで足す。差し戻しはマイナスで入っている。
      grossAmount: current.grossAmount + line.grossAmount,
      feeAmount: current.feeAmount + line.feeAmount,
      netAmount: current.netAmount + line.netAmount,
      clawbackCount: current.clawbackCount + (line.isClawback ? 1 : 0),
    });
  }

  /*
    ⚠️ **手取りの多い順。** 作家さまが最初に見たいのは「どれが効いたか」。
       同額なら名前順にして、実行のたびに並びが変わらないようにする。
  */
  return [...byTitle.values()].sort((a, b) => {
    const byNet = b.netAmount - a.netAmount;
    return byNet !== 0 ? byNet : a.artworkTitleSnapshot.localeCompare(b.artworkTitleSnapshot, 'ja');
  });
}

/**
 * CSV の列。
 *
 * ⚠️ **買った方の情報を 1 つも入れない。** 明細は作家さまの手元へ落ちて、
 * 表計算やメールに渡っていく。落ちた先まではこちらの管理が及ばない。
 * 注文番号は載せる（問い合わせの照合に要る）が、**誰が買ったかは載せない**。
 */
export const EARNINGS_CSV_COLUMNS = [
  '締め月',
  '注文番号',
  '作品名',
  '販売額',
  '手数料率(%)',
  '手数料',
  'お支払額',
  '区分',
] as const;

/**
 * 明細を CSV の行にする。
 *
 * ⚠️ **Excel の事故を避ける。** 先頭が `=` `+` `-` `@` で始まる値は、
 * 表計算ソフトが数式として解釈する。作品名は作家さまが自由に付けられる
 * ので、ここで無害化する（`SUM(...)` を仕込まれた作品名が、開いた人の
 * 手元で動いてしまう）。
 */
export function toEarningsCsvRows(input: {
  readonly periodKey: string;
  readonly lines: readonly PayoutLineDraft[];
}): readonly (readonly string[])[] {
  return input.lines.map((line) => [
    input.periodKey,
    line.orderNumber,
    escapeForSpreadsheet(line.artworkTitleSnapshot),
    String(line.grossAmount),
    (line.feeRateBps / 100).toFixed(2),
    String(line.feeAmount),
    String(line.netAmount),
    line.isClawback ? '差し戻し' : '販売',
  ]);
}

/**
 * 表計算ソフトが数式として解釈する先頭文字を無害化する。
 *
 * ⚠️ **消さずに前へ `'` を足す。** 消すと作品名が変わってしまい、
 * 作家さまが自分の作品を見分けられなくなる。
 */
function escapeForSpreadsheet(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** CSV 1 枚を組み立てる。⚠️ 区切りと囲みの規則を 1 か所に閉じ込める。 */
export function buildEarningsCsv(rows: readonly (readonly string[])[]): string {
  const all = [[...EARNINGS_CSV_COLUMNS], ...rows.map((row) => [...row])];
  return all.map((row) => row.map(quote).join(',')).join('\r\n');
}

/** ⚠️ 常に囲む。囲む・囲まないを値で分けると、規則が読みにくくなる。 */
function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
