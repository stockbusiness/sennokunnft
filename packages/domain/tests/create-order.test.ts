import { describe, expect, it } from 'vitest';
import {
  createOrder,
  DEFAULT_RESERVATION_MINUTES,
  type Artwork,
  type CreateOrderInput,
  type Listing,
  type SupplyCounters,
} from '../src';

const NOW = new Date('2026-08-14T00:00:00Z');

function artwork(overrides: Partial<Artwork> = {}): Artwork {
  return {
    id: 'art-1',
    slug: 'tenka-fubu',
    title: '天下布武の陣羽織',
    description: '',
    imageKey: null,
    imageContentType: null,
    imageByteSize: null,
    maxSupply: 10,
    reservedCount: 0,
    issuedCount: 0,
    status: 'published',
    ...overrides,
  } as Artwork;
}

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'lst-1',
    artworkId: 'art-1',
    price: { amountMinor: 1000, currency: 'JPY' },
    maxQuantityPerOrder: 3,
    status: 'active',
    startsAt: null,
    endsAt: null,
    displayOrder: 0,
    ...overrides,
  };
}

function counters(overrides: Partial<SupplyCounters> = {}): SupplyCounters {
  return { maxSupply: 10, reservedCount: 0, issuedCount: 0, ...overrides };
}

function attempt(overrides: Partial<CreateOrderInput> = {}) {
  return createOrder({
    accountId: 'acc-1',
    listing: listing(),
    artwork: artwork(),
    counters: counters(),
    quantity: 1,
    now: NOW,
    ...overrides,
  });
}

describe('注文の作成', () => {
  it('買える出品なら注文を組み立てる', () => {
    const result = attempt();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toEqual({ amountMinor: 1000, currency: 'JPY' });
    expect(result.value.lines).toHaveLength(1);
  });

  it('金額は単価 × 数量（整数計算）', () => {
    const result = attempt({ quantity: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.total.amountMinor).toBe(3000);
  });

  describe('スナップショット', () => {
    it('作品名を注文時点の値で持つ', () => {
      // ⚠️ マスタを参照して表示すると、あとで改名したとき
      //    「買ったときと違う名前」が履歴に出る。
      const result = attempt({ artwork: artwork({ title: '当時の名前' }) });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.lines[0]?.artworkTitleSnapshot).toBe('当時の名前');
    });

    it('単価を注文時点の値で持つ', () => {
      const result = attempt({
        listing: listing({ price: { amountMinor: 777, currency: 'JPY' } }),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.lines[0]?.unitPrice.amountMinor).toBe(777);
    });
  });

  describe('在庫の仮引当', () => {
    it('引当後のカウンタを返す', () => {
      const result = attempt({ quantity: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.reservedCounters.reservedCount).toBe(2);
    });

    it('残数ちょうどまでは通る（境界）', () => {
      const result = attempt({
        counters: counters({ maxSupply: 5, reservedCount: 2, issuedCount: 2 }),
        quantity: 1,
        listing: listing({ maxQuantityPerOrder: 5 }),
      });
      expect(result.ok).toBe(true);
    });

    it('残数を超えると INSUFFICIENT_SUPPLY', () => {
      const result = attempt({
        counters: counters({ maxSupply: 5, reservedCount: 3, issuedCount: 2 }),
        quantity: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_SUPPLY');
    });

    it('仮引当ぶんも残数から差し引く', () => {
      // ⚠️ 決済待ちの注文が押さえている数を無視すると、売り越す。
      const result = attempt({
        counters: counters({ maxSupply: 3, reservedCount: 3, issuedCount: 0 }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_SUPPLY');
    });
  });

  describe('数量の上限', () => {
    it('出品ごとの上限を超えると拒否する', () => {
      const result = attempt({ listing: listing({ maxQuantityPerOrder: 2 }), quantity: 3 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_QUANTITY');
    });

    it('0 以下を拒否する', () => {
      expect(attempt({ quantity: 0 }).ok).toBe(false);
      expect(attempt({ quantity: -1 }).ok).toBe(false);
    });

    it('整数でない数量を拒否する', () => {
      expect(attempt({ quantity: 1.5 }).ok).toBe(false);
    });
  });

  describe('買えない出品', () => {
    it('未公開の作品は「見つからない」として扱う', () => {
      // ⚠️ 状態を返すと、未公開作品の存在を外から探れる。
      const result = attempt({ artwork: artwork({ status: 'draft' }) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ARTWORK_NOT_AVAILABLE');
    });

    it('販売していない出品を拒否する', () => {
      const result = attempt({ listing: listing({ status: 'ended' }) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('LISTING_NOT_ACTIVE');
    });

    it('販売開始前を拒否する', () => {
      const result = attempt({
        listing: listing({ status: 'scheduled', startsAt: new Date('2026-09-01T00:00:00Z') }),
      });
      expect(result.ok).toBe(false);
    });

    it('買えるかどうかを在庫より先に判定する', () => {
      // ⚠️ 順序が逆だと、販売していない作品について残数を答えることになる。
      const result = attempt({
        artwork: artwork({ status: 'draft' }),
        counters: counters({ maxSupply: 1, reservedCount: 1 }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ARTWORK_NOT_AVAILABLE');
    });
  });

  it('出品と作品の組み合わせが食い違えば拒否する', () => {
    // ⚠️ 突き合わせないと、安い出品のIDと別の作品を組み合わせられる。
    const result = attempt({ listing: listing({ artworkId: 'art-other' }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ARTWORK_NOT_AVAILABLE');
  });

  describe('仮引当の期限', () => {
    it('既定は 30 分後', () => {
      const result = attempt();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.reservedUntil.getTime()).toBe(
          NOW.getTime() + DEFAULT_RESERVATION_MINUTES * 60_000,
        );
      }
    });

    it('呼び出し側で変えられる', () => {
      const result = attempt({ reservationMinutes: 5 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.reservedUntil.getTime()).toBe(NOW.getTime() + 5 * 60_000);
      }
    });
  });
});
