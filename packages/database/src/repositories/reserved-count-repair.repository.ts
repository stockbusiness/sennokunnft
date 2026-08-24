import type {
  ReservedCountDriftOrder,
  ReservedCountRepairCommand,
  ReservedCountRepairOutcome,
  ReservedCountRepairPort,
  ReservedCountRepairRecord,
  ReservedCountRepairResolveOutcome,
} from '@sengoku/domain';
import { planReservedCountRepair, planReservedCountRepairResolution } from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';

/**
 * 押さえのずれを直す（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）。
 *
 * ⚠️ **絶対値で書く、この機能だけの危うさ。** 在庫カウンタを触る他の処理は
 * ほとんどが**相対**（`decrement: 数量`）で、並んで走っても足し引きが
 * 狂わない。ここだけは「数え直した値をそのまま入れる」ので、**読んでから
 * 書くまでに誰かが動かすと壊す。**
 *
 * だから作品行を `FOR UPDATE` で掴んだまま数え直す。掴む理由は 2 つ。
 *
 * 1. 同じく絶対値で書く注文作成（`order.repository.ts`）と発行
 *    （`issuance.repository.ts`）も同じ鍵を取る。取っておけば直列化される。
 * 2. 相対で引く解放・返金は鍵を取らないが、`artworks` への `UPDATE` 自体が
 *    行の鍵を要るのでこちらの commit まで待つ。待ったあとに**相対で**引く
 *    ので、こちらが入れた値から正しく引かれる。
 *
 * ⚠️ **仮引当の行には一切触らない。** ここは「カウンタを仮引当に合わせる」
 * であって「予約を作る」ではない。決済 P0/P1 §9.3 が禁じているのは後者。
 */
export class PrismaReservedCountRepairRepository implements ReservedCountRepairPort {
  constructor(private readonly prisma: PrismaClient) {}

  async repair(input: {
    readonly command: ReservedCountRepairCommand;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<ReservedCountRepairOutcome> {
    return this.prisma.$transaction(async (tx) => {
      /*
        ⚠️ **掴んでから読む。** `findUnique` で読んでから掴み直すと、
           そのあいだに動く。1 文で掴んで読む。
      */
      const locked = await tx.$queryRaw<
        readonly {
          id: string;
          title: string;
          reserved_count: number;
          issued_count: number;
          max_supply: number;
        }[]
      >(Prisma.sql`
        SELECT "id", "title", "reserved_count", "issued_count", "max_supply"
          FROM "artworks"
         WHERE "id" = ${input.command.artworkId}::uuid
           FOR UPDATE
      `);
      const artwork = locked[0];
      if (artwork === undefined) {
        return { ok: false, refusal: 'artwork_not_found' } as const;
      }

      const orders = await readOrders(tx, artwork.id);

      /*
        ⚠️ **直してよいかを決めるのはドメイン。** ここで条件を書き足すと、
           判定が二箇所に散る。落ちる歯止めが増えても、片方しか直らない。
      */
      const decision = planReservedCountRepair(input.command, {
        reservedCount: artwork.reserved_count,
        issuedCount: artwork.issued_count,
        maxSupply: artwork.max_supply,
        orders,
      });
      if (!decision.ok) {
        return decision;
      }

      await tx.artwork.update({
        where: { id: artwork.id },
        data: { reservedCount: decision.plan.after, updatedAt: input.now },
      });

      const row = await tx.reservedCountRepair.create({
        data: {
          artworkId: artwork.id,
          // ⚠️ スナップショット原則。あとで改題されても記録は動かない。
          artworkTitleSnapshot: artwork.title,
          beforeCount: decision.plan.before,
          afterCount: decision.plan.after,
          difference: decision.plan.difference,
          direction: decision.plan.direction,
          reason: decision.plan.reason,
          causeState: decision.plan.causeState,
          /*
            ⚠️ **ここが本体。** 「12 → 9」だけでは後から何ひとつ辿れない。
               どの注文が・いくつ押さえ・いくつ発行済みだったかを丸ごと
               焼き付けて初めて原因を追える。
          */
          snapshot: decision.plan.snapshot as unknown as Prisma.InputJsonValue,
          repairedByAccountId: input.actorAccountId,
          repairedAt: input.now,
        },
      });

      return { ok: true, record: toRecord(row) } as const;
    });
  }

  async list(query: { readonly state: 'pending' | 'all'; readonly limit: number }): Promise<{
    readonly items: readonly ReservedCountRepairRecord[];
    readonly hasMore: boolean;
  }> {
    const limit = Math.min(Math.max(query.limit, 1), MAX_LIST_LIMIT);
    const rows = await this.prisma.reservedCountRepair.findMany({
      where:
        query.state === 'pending'
          ? // ⚠️ 部分索引 `reserved_count_repairs_pending_idx` と同じ条件にする。
            { causeState: 'unknown', resolvedAt: null }
          : {},
      orderBy: { repairedAt: 'desc' },
      // ⚠️ 1 件多く引いて、切ったかどうかを知る。
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    return { items: (hasMore ? rows.slice(0, limit) : rows).map(toRecord), hasMore };
  }

  async resolve(input: {
    readonly repairId: string;
    readonly note: string;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<ReservedCountRepairResolveOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.reservedCountRepair.findUnique({
        where: { id: input.repairId },
      });
      if (existing === null) {
        return { ok: false, refusal: 'not_found' } as const;
      }

      const decision = planReservedCountRepairResolution(
        { causeState: toCauseState(existing.causeState), resolvedAt: existing.resolvedAt },
        input.note,
      );
      if (!decision.ok) {
        return decision;
      }

      /*
        ⚠️ **`resolvedAt: null` を条件に付ける。** 同じ積み残しを 2 人が
           同時に閉じにきたとき、後の 1 件を弾く。上の `findUnique` は
           鍵を取らないので、ここで条件付きの更新にして初めて 1 回になる。
      */
      const updated = await tx.reservedCountRepair.updateMany({
        where: { id: input.repairId, resolvedAt: null },
        data: {
          resolvedAt: input.now,
          resolvedByAccountId: input.actorAccountId,
          resolutionNote: decision.note,
        },
      });
      if (updated.count !== 1) {
        return { ok: false, refusal: 'already_resolved' } as const;
      }

      const row = await tx.reservedCountRepair.findUniqueOrThrow({
        where: { id: input.repairId },
      });
      return { ok: true, record: toRecord(row) } as const;
    });
  }

  async pendingCount(): Promise<number> {
    return this.prisma.reservedCountRepair.count({
      where: { causeState: 'unknown', resolvedAt: null },
    });
  }
}

/** 一度に返す記録の上限。⚠️ 画面が固まらない数にする。 */
const MAX_LIST_LIMIT = 100;

/**
 * その作品に関わっている注文の内訳。
 *
 * ⚠️ **一覧（`operations.repository.ts`）と同じ形で引く。** 形が違うと、
 * 画面が見せた内訳と焼き付けた内訳が食い違い、後から突き合わせられない。
 */
async function readOrders(
  tx: Prisma.TransactionClient,
  artworkId: string,
): Promise<readonly ReservedCountDriftOrder[]> {
  const rows = await tx.$queryRaw<
    readonly {
      order_id: string;
      order_number: string;
      order_status: string;
      held: bigint;
      issued: bigint;
    }[]
  >(Prisma.sql`
    SELECT r."order_id",
           o."order_number",
           o."status" AS "order_status",
           sum(r."quantity") AS "held",
           (SELECT count(*)
              FROM "entitlements" e
             WHERE e."order_id" = r."order_id"
               -- 1 作品に絞ってあるので、束ねていない r の列ではなく
               -- 引数を使う。r.artwork_id は GROUP BY に無い。
               AND e."artwork_id" = ${artworkId}::uuid) AS "issued"
      FROM "inventory_reservations" r
      JOIN "orders" o ON o."id" = r."order_id"
     WHERE r."artwork_id" = ${artworkId}::uuid
       AND r."status" IN ('reserved', 'consumed')
     GROUP BY r."order_id", o."order_number", o."status"
     ORDER BY o."order_number"
  `);
  return rows.map((row) => ({
    orderId: row.order_id,
    orderNumber: row.order_number,
    orderStatus: row.order_status,
    // ⚠️ `sum` と `count` は bigint で返る。そのまま渡すと JSON にできない。
    heldQuantity: Number(row.held),
    issuedCount: Number(row.issued),
  }));
}

/**
 * 保存されている符号を語彙へ戻す。
 *
 * ⚠️ **知らない値を `identified` に倒さない。** 倒すと、積み残しに出ない
 * 行が静かに生まれる。CHECK 制約が通さないはずの値だが、ここで握りつぶす
 * と制約を外したときに気づけない。
 */
function toCauseState(value: string): 'identified' | 'unknown' {
  return value === 'identified' ? 'identified' : 'unknown';
}

function toDirection(value: string): 'over' | 'under' {
  return value === 'under' ? 'under' : 'over';
}

interface ReservedCountRepairRow {
  readonly id: string;
  readonly artworkId: string;
  readonly artworkTitleSnapshot: string;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly difference: number;
  readonly direction: string;
  readonly reason: string;
  readonly causeState: string;
  readonly snapshot: Prisma.JsonValue;
  readonly repairedByAccountId: string;
  readonly repairedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedByAccountId: string | null;
  readonly resolutionNote: string | null;
}

function toRecord(row: ReservedCountRepairRow): ReservedCountRepairRecord {
  return {
    id: row.id,
    artworkId: row.artworkId,
    artworkTitle: row.artworkTitleSnapshot,
    before: row.beforeCount,
    after: row.afterCount,
    difference: row.difference,
    direction: toDirection(row.direction),
    reason: row.reason,
    causeState: toCauseState(row.causeState),
    /*
      ⚠️ **配列でなければ空にする。** JSONB は何でも入る型なので、
         壊れた行が画面で例外にならないようにする。
    */
    snapshot: Array.isArray(row.snapshot)
      ? (row.snapshot as unknown as readonly ReservedCountDriftOrder[])
      : [],
    repairedByAccountId: row.repairedByAccountId,
    repairedAt: row.repairedAt,
    resolvedAt: row.resolvedAt,
    resolvedByAccountId: row.resolvedByAccountId,
    resolutionNote: row.resolutionNote,
  };
}
