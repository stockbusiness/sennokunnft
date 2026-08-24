import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/client';
import { PrismaOperationsRepository } from '../../src/repositories/operations.repository';
import { PrismaReservedCountRepairRepository } from '../../src/repositories/reserved-count-repair.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  orderLineSeedFields,
  orderSeedFields,
  resetDatabase,
} from '../helpers/database';

/**
 * 押さえのずれを直す（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）。
 *
 * ⚠️ **ここは実データでしか確かめられない。** 要の歯止めは作品行の
 * `FOR UPDATE` で、同時に走った 2 本が直列化されることそのものを試す。
 * 作り物の PrismaClient では、この歯止めは**必ず通ってしまう。**
 *
 * ⚠️ **「直せること」より「直しすぎないこと」を試す。** 数を絶対値で書く
 * のはこの機能だけで、読んでから書くまでに誰かが動かせば壊せる。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-24T00:00:00.000Z');
const PRICE = 3000;
const ACTOR_REASON = '返金の二重解放が原因と分かったので、押さえを数え直す';

let prisma: PrismaClient;
let repo: PrismaReservedCountRepairRepository;
let operations: PrismaOperationsRepository;
let actorAccountId: string;

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaReservedCountRepairRepository(prisma);
  operations = new PrismaOperationsRepository(prisma);
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
  actorAccountId = randomUUID();
  await prisma.account.create({
    data: { id: actorAccountId, authProvider: 'fake', authSubject: actorAccountId },
  });
});

interface Seeded {
  readonly artworkId: string;
  readonly orderId: string;
  readonly reservationId: string;
}

/**
 * 注文 1 件と、その仮引当 1 件。
 *
 * @param reservedCount 作品に立てる押さえ。⚠️ ずれを作るため、実態と違う
 *   値も渡せるようにしてある。
 */
async function seed(options: {
  quantity: number;
  reservationStatus: 'reserved' | 'consumed' | 'released';
  issuedEntitlements: number;
  reservedCount: number;
  issuedCount?: number;
  maxSupply?: number;
}): Promise<Seeded> {
  const buyerAccountId = randomUUID();
  const creatorAccountId = randomUUID();
  await prisma.account.createMany({
    data: [
      { id: buyerAccountId, authProvider: 'fake', authSubject: buyerAccountId },
      { id: creatorAccountId, authProvider: 'fake', authSubject: creatorAccountId },
    ],
  });
  const artwork = await prisma.artwork.create({
    data: {
      creatorAccountId,
      slug: `artwork-${randomUUID()}`,
      title: '押さえの修復の試験の作品',
      maxSupply: options.maxSupply ?? 20,
      reservedCount: options.reservedCount,
      issuedCount: options.issuedCount ?? options.issuedEntitlements,
      status: 'published',
    },
  });
  const listing = await prisma.listing.create({
    data: { artworkId: artwork.id, priceAmount: PRICE, priceCurrency: 'JPY' },
  });
  const total = PRICE * options.quantity;
  const order = await prisma.order.create({
    data: {
      accountId: buyerAccountId,
      totalAmount: total,
      totalCurrency: 'JPY',
      idempotencyKey: randomUUID(),
      status: 'paid',
      paymentStatus: 'succeeded',
      paidAt: NOW,
      ...orderSeedFields({ creatorAccountId, totalAmount: total }),
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      artworkTitleSnapshot: '押さえの修復の試験の作品',
      unitPriceAmount: PRICE,
      unitPriceCurrency: 'JPY',
      quantity: options.quantity,
      ...orderLineSeedFields({
        creatorAccountId,
        unitPriceAmount: PRICE,
        quantity: options.quantity,
      }),
    },
  });
  const reservation = await prisma.inventoryReservation.create({
    data: {
      orderId: order.id,
      listingId: listing.id,
      artworkId: artwork.id,
      quantity: options.quantity,
      status: options.reservationStatus,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      ...(options.reservationStatus === 'consumed' ? { consumedAt: NOW } : {}),
      ...(options.reservationStatus === 'released' ? { releasedAt: NOW } : {}),
    },
  });
  for (let index = 0; index < options.issuedEntitlements; index += 1) {
    await prisma.entitlement.create({
      data: {
        orderId: order.id,
        orderLineId: line.id,
        artworkId: artwork.id,
        accountId: buyerAccountId,
        serialNo: index + 1,
        unitIndex: index,
        claimTokenHash: `sha256:${randomUUID()}`,
        status: 'issued',
      },
    });
  }
  return { artworkId: artwork.id, orderId: order.id, reservationId: reservation.id };
}

async function reservedCountOf(artworkId: string): Promise<number> {
  const row = await prisma.artwork.findUniqueOrThrow({ where: { id: artworkId } });
  return row.reservedCount;
}

suite('押さえのずれを直す', () => {
  it('多すぎる押さえを、仮引当から数え直した値へ直す', async () => {
    const { artworkId } = await seed({
      quantity: 1,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 3,
    });

    const outcome = await repo.repair({
      command: {
        artworkId,
        observedReservedCount: 3,
        reason: ACTOR_REASON,
        causeState: 'identified',
      },
      actorAccountId,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    expect(await reservedCountOf(artworkId)).toBe(1);
  });

  /*
    ⚠️ **これが端から端までの証。** 直したあと、検知そのものが鳴らなく
       なること。数字だけ合わせて検知に残るなら、直したことにならない。
  */
  it('直したあと、食い違いの検知から消える', async () => {
    const { artworkId } = await seed({
      quantity: 2,
      reservationStatus: 'consumed',
      issuedEntitlements: 0,
      reservedCount: 5,
    });
    expect((await operations.consistency()).reservedCountDrift).toEqual([artworkId]);

    await repo.repair({
      command: {
        artworkId,
        observedReservedCount: 5,
        reason: ACTOR_REASON,
        causeState: 'identified',
      },
      actorAccountId,
      now: NOW,
    });

    expect((await operations.consistency()).reservedCountDrift).toEqual([]);
  });

  it('足りない押さえは増やす向きに直る', async () => {
    const { artworkId } = await seed({
      quantity: 4,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 1,
    });

    const outcome = await repo.repair({
      command: {
        artworkId,
        observedReservedCount: 1,
        reason: ACTOR_REASON,
        causeState: 'identified',
      },
      actorAccountId,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect({
      after: await reservedCountOf(artworkId),
      direction: outcome.record.direction,
    }).toEqual({ after: 4, direction: 'under' });
  });

  /*
    ⚠️ **記録の本体は内訳である。** 「5 → 2」だけ残しても後から原因を
       追えない。どの注文が・いくつ押さえ・いくつ発行済みだったか。
  */
  it('直す前の内訳を、注文ごと焼き付ける', async () => {
    const { artworkId, orderId } = await seed({
      quantity: 3,
      reservationStatus: 'consumed',
      issuedEntitlements: 1,
      reservedCount: 5,
    });

    const outcome = await repo.repair({
      command: {
        artworkId,
        observedReservedCount: 5,
        reason: ACTOR_REASON,
        causeState: 'identified',
      },
      actorAccountId,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.snapshot).toEqual([
      expect.objectContaining({ orderId, heldQuantity: 3, issuedCount: 1 }),
    ]);
    // 押さえ 3 − 発行済み 1 = 2（決定 A）。
    expect(outcome.record.after).toBe(2);
  });

  /*
    ⚠️ **決済 P0/P1 §9.3 の「在庫数と無関係な予約作成」を犯していない証。**
       ここは「カウンタを仮引当に合わせる」であって「予約を作る／消す」
       ではない。仮引当の行が 1 文字も動かないこと。
  */
  it('仮引当の行には触らない', async () => {
    const { artworkId, reservationId } = await seed({
      quantity: 1,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 4,
    });
    const before = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });

    await repo.repair({
      command: {
        artworkId,
        observedReservedCount: 4,
        reason: ACTOR_REASON,
        causeState: 'identified',
      },
      actorAccountId,
      now: NOW,
    });

    const after = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    expect(after).toEqual(before);
    // 仮引当は 1 件のまま。増やしても減らしてもいない。
    expect(await prisma.inventoryReservation.count()).toBe(1);
  });

  describe('直さない場合', () => {
    /*
      ⚠️ **要の歯止め。** 画面を開いてから押すまでに正常なご注文が入ると、
         古い数字で上書きして**逆にずれを作る。**
    */
    it('画面が見た押さえと今の押さえが違えば、数も記録も動かさない', async () => {
      const { artworkId } = await seed({
        quantity: 1,
        reservationStatus: 'reserved',
        issuedEntitlements: 0,
        reservedCount: 4,
      });

      const outcome = await repo.repair({
        command: {
          artworkId,
          // 画面は 3 と見ていた。いまは 4。
          observedReservedCount: 3,
          reason: ACTOR_REASON,
          causeState: 'identified',
        },
        actorAccountId,
        now: NOW,
      });

      expect(outcome).toEqual({ ok: false, refusal: 'stale_view' });
      expect(await reservedCountOf(artworkId)).toBe(4);
      expect(await prisma.reservedCountRepair.count()).toBe(0);
    });

    it('ずれていない作品は直さず、記録も作らない', async () => {
      const { artworkId } = await seed({
        quantity: 2,
        reservationStatus: 'reserved',
        issuedEntitlements: 0,
        reservedCount: 2,
      });

      const outcome = await repo.repair({
        command: {
          artworkId,
          observedReservedCount: 2,
          reason: ACTOR_REASON,
          causeState: 'identified',
        },
        actorAccountId,
        now: NOW,
      });

      expect(outcome).toEqual({ ok: false, refusal: 'no_drift' });
      expect(await prisma.reservedCountRepair.count()).toBe(0);
    });

    /*
      ⚠️ **これはずれではなく、すでに売り越している。** 直せば真実だが
         `artworks_supply_within_max` が拒む。**制約違反として落とさず**、
         名前を付けて止める——ご注文を取り消すか上限を上げるかの判断が要る
         事態であって、この口で決めてよい話ではない。
    */
    it('直すと在庫の上限を超えるなら、制約違反にせず断る', async () => {
      const { artworkId } = await seed({
        quantity: 5,
        reservationStatus: 'reserved',
        issuedEntitlements: 0,
        reservedCount: 1,
        issuedCount: 8,
        maxSupply: 10,
      });

      const outcome = await repo.repair({
        command: {
          artworkId,
          observedReservedCount: 1,
          reason: ACTOR_REASON,
          causeState: 'identified',
        },
        actorAccountId,
        now: NOW,
      });

      expect(outcome).toEqual({ ok: false, refusal: 'exceeds_max_supply' });
      expect(await reservedCountOf(artworkId)).toBe(1);
    });

    it('理由が書かれていなければ直さない', async () => {
      const { artworkId } = await seed({
        quantity: 1,
        reservationStatus: 'reserved',
        issuedEntitlements: 0,
        reservedCount: 3,
      });

      const outcome = await repo.repair({
        command: { artworkId, observedReservedCount: 3, reason: '   ', causeState: 'identified' },
        actorAccountId,
        now: NOW,
      });

      expect(outcome).toEqual({ ok: false, refusal: 'reason_required' });
      expect(await reservedCountOf(artworkId)).toBe(3);
    });

    it('作品が無ければ断る', async () => {
      const outcome = await repo.repair({
        command: {
          artworkId: randomUUID(),
          observedReservedCount: 3,
          reason: ACTOR_REASON,
          causeState: 'identified',
        },
        actorAccountId,
        now: NOW,
      });

      expect(outcome).toEqual({ ok: false, refusal: 'artwork_not_found' });
    });
  });

  /*
    ⚠️ **作品行の `FOR UPDATE` が効いていることの証。** 掴まずに読むと、
       2 本が同じ値を読んで**どちらも成功し、記録が 2 件できる。**
       後の 1 本は、前の 1 本が入れた値を読んで「画面が古い」と断るはず。
  */
  it('同じ作品を 2 人が同時に直そうとしても、1 回しか成立しない', async () => {
    const { artworkId } = await seed({
      quantity: 1,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 6,
    });
    const command = {
      artworkId,
      observedReservedCount: 6,
      reason: ACTOR_REASON,
      causeState: 'identified' as const,
    };

    const [first, second] = await Promise.all([
      repo.repair({ command, actorAccountId, now: NOW }),
      repo.repair({ command, actorAccountId, now: NOW }),
    ]);

    expect([first?.ok, second?.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((row) => row?.ok === false)).toEqual({
      ok: false,
      refusal: 'stale_view',
    });
    expect(await reservedCountOf(artworkId)).toBe(1);
    expect(await prisma.reservedCountRepair.count()).toBe(1);
  });
});

suite('原因未特定の積み残し', () => {
  async function repairWithUnknownCause(): Promise<string> {
    const { artworkId } = await seed({
      quantity: 1,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 3,
    });
    const outcome = await repo.repair({
      command: {
        artworkId,
        observedReservedCount: 3,
        reason: '原因はまだ分からないが、売り越しを止めるため先に直す',
        causeState: 'unknown',
      },
      actorAccountId,
      now: NOW,
    });
    if (!outcome.ok) throw new Error(`直せなかった: ${outcome.refusal}`);
    return outcome.record.id;
  }

  /*
    ⚠️ **この機能の心臓部。** 直せば整合性チェックは 0 件へ戻る。だが
       原因未特定の数は残る——**直したことで赤が消えるのを許さない。**
       2026-08-23 の返金の二重解放は、修復の口が先にあったら押して
       終わりにしていた可能性が高い。
  */
  it('直しても、原因未特定として残り続ける', async () => {
    await repairWithUnknownCause();

    expect((await operations.consistency()).reservedCountDrift).toEqual([]);
    expect(await repo.pendingCount()).toBe(1);
  });

  it('原因が分かったうえで直したものは、積み残しにならない', async () => {
    const { artworkId } = await seed({
      quantity: 1,
      reservationStatus: 'reserved',
      issuedEntitlements: 0,
      reservedCount: 3,
    });
    await repo.repair({
      command: {
        artworkId,
        observedReservedCount: 3,
        reason: ACTOR_REASON,
        causeState: 'identified',
      },
      actorAccountId,
      now: NOW,
    });

    expect(await repo.pendingCount()).toBe(0);
    expect((await repo.list({ state: 'pending', limit: 50 })).items).toEqual([]);
    // ⚠️ 記録そのものは残る。積み残しに出ないだけ。
    expect((await repo.list({ state: 'all', limit: 50 })).items).toHaveLength(1);
  });

  it('原因が分かったら、何が分かったかを書いて閉じられる', async () => {
    const repairId = await repairWithUnknownCause();
    const resolverAccountId = randomUUID();
    await prisma.account.create({
      data: { id: resolverAccountId, authProvider: 'fake', authSubject: resolverAccountId },
    });

    const outcome = await repo.resolve({
      repairId,
      note: '返金の二重解放が原因だった。PR #86 で修正済み',
      actorAccountId: resolverAccountId,
      now: new Date('2026-08-25T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect({
      resolvedBy: outcome.record.resolvedByAccountId,
      note: outcome.record.resolutionNote,
    }).toEqual({
      resolvedBy: resolverAccountId,
      note: '返金の二重解放が原因だった。PR #86 で修正済み',
    });
    expect(await repo.pendingCount()).toBe(0);
  });

  /*
    ⚠️ **閉じても、直した記録そのものは消えない。** 消せると、この表を
       持つ意味が無くなる。
  */
  it('閉じても、直す前の値と内訳は残る', async () => {
    const repairId = await repairWithUnknownCause();
    const before = await prisma.reservedCountRepair.findUniqueOrThrow({ where: { id: repairId } });

    await repo.resolve({
      repairId,
      note: '返金の二重解放が原因だった。PR #86 で修正済み',
      actorAccountId,
      now: new Date('2026-08-25T00:00:00.000Z'),
    });

    const after = await prisma.reservedCountRepair.findUniqueOrThrow({ where: { id: repairId } });
    expect({
      beforeCount: after.beforeCount,
      afterCount: after.afterCount,
      snapshot: after.snapshot,
      reason: after.reason,
    }).toEqual({
      beforeCount: before.beforeCount,
      afterCount: before.afterCount,
      snapshot: before.snapshot,
      reason: before.reason,
    });
  });

  it('何が分かったのかを書かなければ閉じられない', async () => {
    const repairId = await repairWithUnknownCause();

    expect(await repo.resolve({ repairId, note: '解決', actorAccountId, now: NOW })).toEqual({
      ok: false,
      refusal: 'note_required',
    });
    expect(await repo.pendingCount()).toBe(1);
  });

  it('無い記録は閉じられない', async () => {
    expect(
      await repo.resolve({
        repairId: randomUUID(),
        note: '返金の二重解放が原因だった。PR #86 で修正済み',
        actorAccountId,
        now: NOW,
      }),
    ).toEqual({ ok: false, refusal: 'not_found' });
  });

  /*
    ⚠️ **条件付きの更新が効いていることの証。** `findUnique` は鍵を
       取らないので、2 人が同時に閉じにくると**どちらも通ってしまう。**
       後の 1 人の書いたメモが、前の 1 人のメモを黙って上書きする。
  */
  it('同じ積み残しを 2 人が同時に閉じても、1 回しか成立しない', async () => {
    const repairId = await repairWithUnknownCause();
    const note = '返金の二重解放が原因だった。PR #86 で修正済み';

    const [first, second] = await Promise.all([
      repo.resolve({ repairId, note, actorAccountId, now: NOW }),
      repo.resolve({ repairId, note, actorAccountId, now: NOW }),
    ]);

    expect([first?.ok, second?.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((row) => row?.ok === false)).toEqual({
      ok: false,
      refusal: 'already_resolved',
    });
  });

  it('上限で切ったことを隠さない', async () => {
    await repairWithUnknownCause();
    await repairWithUnknownCause();

    const page = await repo.list({ state: 'pending', limit: 1 });

    expect({ count: page.items.length, hasMore: page.hasMore }).toEqual({
      count: 1,
      hasMore: true,
    });
  });
});
