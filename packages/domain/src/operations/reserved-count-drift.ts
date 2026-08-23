/**
 * 押さえている数がずれた作品の一覧（`ADMIN_OPERATIONS_GAP.md` §I）。
 *
 * ⚠️ **直さない。読むだけ。** 整合性チェックと同じ方針である
 * （`consistency.ts`）。ここは「どこが、どれだけ、どの注文でずれたか」を
 * 人へ渡すところまで。
 *
 * ⚠️ **これが要る理由。** 食い違いの画面は作品の識別子しか出さず、
 * 「突き合わせて特定してください」としか言えなかった。**道具を渡さずに
 * 調べろと言う画面は、赤いまま放置される。**
 */

/** ずれに関わっている注文 1 件。 */
export interface ReservedCountDriftOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderStatus: string;
  /** `reserved` / `consumed` の仮引当の数量の合計。 */
  readonly heldQuantity: number;
  /** その注文・その作品で発行済みの受取権の数。⚠️ 取り消したぶんも含む。 */
  readonly issuedCount: number;
}

export interface ReservedCountDriftRecord {
  readonly artworkId: string;
  readonly artworkTitle: string;
  readonly reservedCount: number;
  readonly orders: readonly ReservedCountDriftOrder[];
}

/** ずれの向き。⚠️ どちらへずれたかで、起きることが違う。 */
export const RESERVED_COUNT_DRIFT_DIRECTIONS = ['over', 'under'] as const;
export type ReservedCountDriftDirection = (typeof RESERVED_COUNT_DRIFT_DIRECTIONS)[number];

export interface ReservedCountDriftOrderView extends ReservedCountDriftOrder {
  /** この注文がまだ押さえているはずの数。 */
  readonly stillHeld: number;
}

export interface ReservedCountDriftView {
  readonly artworkId: string;
  readonly artworkTitle: string;
  /** いま作品に立っている押さえ。 */
  readonly reservedCount: number;
  /** 仮引当と受取権から数え直した、あるべき押さえ。 */
  readonly expectedReservedCount: number;
  /** `reservedCount − expectedReservedCount`。⚠️ 符号を保つ。 */
  readonly difference: number;
  readonly direction: ReservedCountDriftDirection;
  /** 何が起きるか。⚠️ 画面の文言をここで決める（向きで意味が変わるため）。 */
  readonly consequence: string;
  readonly orders: readonly ReservedCountDriftOrderView[];
}

/**
 * その注文がまだ押さえている数。
 *
 * ⚠️ **決定 A。** 決済が済んでも枠は押さえたままで、**受取権を発行した
 * 時点で**だけ `issuedCount` へ移る。だから「数量 − 発行済み」になる。
 *
 * ⚠️ **負にしない。** 二重発行などで数が壊れていても、あるべき値を
 * 押し下げてはいけない。押し下げると、ずれていない作品がずれて見える。
 */
export function stillHeldQuantity(order: ReservedCountDriftOrder): number {
  return Math.max(0, order.heldQuantity - order.issuedCount);
}

const CONSEQUENCES: Readonly<Record<ReservedCountDriftDirection, string>> = {
  /*
    ⚠️ **多い側は売り越しにならない。** 売れるはずの枠が売れないだけで、
       お客さまに二重に売ることはない。急ぎ方が違う。
  */
  over: '押さえが多く、売れるはずの枠が売れません。売り越しにはなりません。',
  /*
    ⚠️ **少ない側が危ない。** 上限を超えて売れてしまう。
  */
  under: '押さえが足りず、**売り越しになりえます。**',
};

/**
 * 記録から画面に出す形を作る。
 *
 * ⚠️ **差が 0 の行は返さない。** 呼ぶ側が「ずれた作品」を渡す前提だが、
 * 数え直した結果ずれていなければ出さない——調べているあいだに直った
 * （解放ジョブが走った等）ということで、赤を出す理由がない。
 */
export function buildReservedCountDriftViews(
  records: readonly ReservedCountDriftRecord[],
): readonly ReservedCountDriftView[] {
  return records.flatMap((record) => {
    const orders = record.orders.map((order) => ({
      ...order,
      stillHeld: stillHeldQuantity(order),
    }));
    const expectedReservedCount = orders.reduce((total, order) => total + order.stillHeld, 0);
    const difference = record.reservedCount - expectedReservedCount;
    if (difference === 0) {
      return [];
    }
    const direction: ReservedCountDriftDirection = difference > 0 ? 'over' : 'under';
    return [
      {
        artworkId: record.artworkId,
        artworkTitle: record.artworkTitle,
        reservedCount: record.reservedCount,
        expectedReservedCount,
        difference,
        direction,
        consequence: CONSEQUENCES[direction],
        orders,
      },
    ];
  });
}
