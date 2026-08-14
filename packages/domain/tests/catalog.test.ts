import { describe, expect, it } from 'vitest';
import {
  ARTWORK_STATUSES,
  LISTING_STATUSES,
  ARTWORK_MAX_SUPPLY_LIMIT,
  ARTWORK_TITLE_MAX,
  activateListing,
  archiveArtwork,
  archiveArtworkAndEndListings,
  artworkStateMachine,
  endListing,
  createArtworkDraft,
  createListing,
  evaluatePurchasability,
  listingStateMachine,
  resolveDisplayState,
  suspendListing,
  publishArtwork,
  unavailableReasonToError,
  updateArtwork,
  updateListing,
  type Artwork,
  type Listing,
  type StateMachine,
} from '../src/index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function artwork(overrides: Partial<Artwork> = {}): Artwork {
  return {
    id: 'artwork-1',
    slug: 'sample-artwork',
    title: '作品名',
    description: '説明',
    imageKey: 'images/sample.png',
    imageHash: null,
    imageContentType: 'image/png',
    imageByteSize: 1024,
    maxSupply: 10,
    reservedCount: 0,
    issuedCount: 0,
    status: 'published',
    ...overrides,
  };
}

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    artworkId: 'artwork-1',
    price: { amountMinor: 12000, currency: 'JPY' },
    maxQuantityPerOrder: 1,
    status: 'active',
    startsAt: null,
    endsAt: null,
    displayOrder: 0,
    ...overrides,
  };
}

/** 遷移表どおりに全組み合わせが判定されることを確認する（TEST_STRATEGY §3.5）。 */
function assertExhaustiveTransitions<S extends string>(
  machine: StateMachine<S>,
  allStates: readonly S[],
): void {
  for (const from of allStates) {
    for (const to of allStates) {
      expect(machine.transition(from, to).ok, `${from} -> ${to}`).toBe(
        machine.table[from].includes(to),
      );
    }
  }
}

describe('作品の状態遷移', () => {
  it('全組み合わせが遷移表どおりに判定される', () => {
    assertExhaustiveTransitions(artworkStateMachine, ARTWORK_STATUSES);
  });

  it('公開済みから下書きへは戻せない', () => {
    // 戻せると、参照している出品や注文の前提が崩れる。
    expect(artworkStateMachine.canTransition('published', 'draft')).toBe(false);
  });

  it('非公開から再公開できる', () => {
    expect(artworkStateMachine.canTransition('archived', 'published')).toBe(true);
  });
});

describe('createArtworkDraft', () => {
  it('下書きとして作られる（いきなり公開されない）', () => {
    const result = createArtworkDraft({
      id: 'a-1',
      slug: 'slug',
      title: '作品',
      maxSupply: 10,
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('draft');
    expect(result.value.reservedCount).toBe(0);
    expect(result.value.issuedCount).toBe(0);
  });

  it('タイトルの前後の空白を落とす', () => {
    const result = createArtworkDraft({ id: 'a', slug: 's', title: '  作品  ', maxSupply: 1 });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.title).toBe('作品');
  });

  it('空のタイトルを拒否する', () => {
    expect(createArtworkDraft({ id: 'a', slug: 's', title: '   ', maxSupply: 1 }).ok).toBe(false);
  });

  it('長すぎるタイトルを拒否する', () => {
    const title = 'あ'.repeat(ARTWORK_TITLE_MAX + 1);
    expect(createArtworkDraft({ id: 'a', slug: 's', title, maxSupply: 1 }).ok).toBe(false);
  });

  it.each([0, -1, 1.5])('発行上限 %s を拒否する', (maxSupply) => {
    expect(createArtworkDraft({ id: 'a', slug: 's', title: '作品', maxSupply }).ok).toBe(false);
  });

  it('発行上限の上限を超える値を拒否する', () => {
    // 受取権は 1 枚 1 レコードなので、発行上限がそのまま書き込み量の上限になる。
    const result = createArtworkDraft({
      id: 'a',
      slug: 's',
      title: '作品',
      maxSupply: ARTWORK_MAX_SUPPLY_LIMIT + 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe('updateArtwork', () => {
  it('下書きなら発行上限を変更できる', () => {
    const result = updateArtwork(artwork({ status: 'draft' }), { maxSupply: 20 });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.maxSupply).toBe(20);
  });

  it('公開後は発行上限を変更できない（UD-205）', () => {
    // 増やせば購入者が前提にした希少性が変わり、減らせば発行済みを下回りうる。
    const result = updateArtwork(artwork({ status: 'published' }), { maxSupply: 20 });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ARTWORK_SUPPLY_IMMUTABLE');
  });

  it('公開後でも同じ値なら通す（無変更の更新を弾かない）', () => {
    const target = artwork({ status: 'published', maxSupply: 10 });
    expect(updateArtwork(target, { maxSupply: 10, title: '新しい名前' }).ok).toBe(true);
  });

  it('下書きでも引当済みを下回る発行上限は拒否する', () => {
    const target = artwork({ status: 'draft', reservedCount: 3, issuedCount: 2 });
    const result = updateArtwork(target, { maxSupply: 4 });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('INSUFFICIENT_SUPPLY');
  });

  it('公開後でもタイトルと説明は変更できる', () => {
    const result = updateArtwork(artwork({ status: 'published' }), { title: '改題' });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.title).toBe('改題');
  });
});

describe('publishArtwork', () => {
  it('下書きから公開できる', () => {
    const result = publishArtwork(artwork({ status: 'draft' }));
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('published');
  });

  it('画像がなければ公開できない', () => {
    // 揃っていない作品を公開できると、購入者に不完全な画面を見せることになる。
    const result = publishArtwork(artwork({ status: 'draft', imageKey: null }));
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ARTWORK_NOT_AVAILABLE');
  });

  it('既に公開済みなら遷移エラー', () => {
    const result = publishArtwork(artwork({ status: 'published' }));
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('非公開から再公開できる', () => {
    expect(publishArtwork(artwork({ status: 'archived' })).ok).toBe(true);
  });
});

describe('archiveArtwork', () => {
  it('公開中の作品を非公開にできる', () => {
    const result = archiveArtwork(artwork({ status: 'published' }));
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('archived');
  });
});

describe('出品の状態遷移', () => {
  it('全組み合わせが遷移表どおりに判定される', () => {
    assertExhaustiveTransitions(listingStateMachine, LISTING_STATUSES);
  });

  it('ended は終端（終了した出品は復活させない）', () => {
    // 「終了しました」と表示したものが復活すると購入者の信頼を損ねる。
    expect(listingStateMachine.isTerminal('ended')).toBe(true);
  });

  it('suspended から再開できる', () => {
    expect(listingStateMachine.canTransition('suspended', 'active')).toBe(true);
    expect(listingStateMachine.canTransition('suspended', 'scheduled')).toBe(true);
  });

  it('draft から直接 suspended にはできない', () => {
    // 開始していないものを「一時停止」と呼ぶと状態の意味が壊れる。
    expect(listingStateMachine.canTransition('draft', 'suspended')).toBe(false);
  });
});

describe('createListing', () => {
  it('下書きとして作られる', () => {
    const result = createListing({
      id: 'l-1',
      artworkId: 'a-1',
      priceAmount: 12000,
      priceCurrency: 'JPY',
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('draft');
    expect(result.value.maxQuantityPerOrder).toBe(1);
  });

  it('小数の価格を拒否する', () => {
    const result = createListing({
      id: 'l',
      artworkId: 'a',
      priceAmount: 120.5,
      priceCurrency: 'JPY',
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('INVALID_MONEY');
  });

  it('0 円の出品は作れない', () => {
    // 無償配布は「販売」とは別の導線として扱う。価格 0 を決済へ流すと
    // 最小金額や返金の扱いで例外だらけになる。
    const result = createListing({
      id: 'l',
      artworkId: 'a',
      priceAmount: 0,
      priceCurrency: 'JPY',
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('INVALID_MONEY');
  });

  it('販売期間が逆転していれば拒否する', () => {
    const result = createListing({
      id: 'l',
      artworkId: 'a',
      priceAmount: 100,
      priceCurrency: 'JPY',
      startsAt: new Date('2026-07-01T00:00:00Z'),
      endsAt: new Date('2026-06-01T00:00:00Z'),
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('LISTING_PERIOD_INVALID');
  });
});

describe('updateListing', () => {
  it('下書きなら価格を変更できる', () => {
    const result = updateListing(listing({ status: 'draft' }), { priceAmount: 9800 });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.price.amountMinor).toBe(9800);
  });

  it('販売中は編集できない', () => {
    // 価格を見てから決済を終えるまでの間に表示が変わる状況を作らない。
    const result = updateListing(listing({ status: 'active' }), { priceAmount: 9800 });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('LISTING_NOT_EDITABLE');
  });

  it('一時停止中なら編集できる', () => {
    expect(updateListing(listing({ status: 'suspended' }), { priceAmount: 9800 }).ok).toBe(true);
  });

  it('販売予定なら編集できる', () => {
    expect(updateListing(listing({ status: 'scheduled' }), { priceAmount: 9800 }).ok).toBe(true);
  });

  it('終了後は編集できない', () => {
    expect(updateListing(listing({ status: 'ended' }), { priceAmount: 1 }).ok).toBe(false);
  });

  it('0 円への変更を拒否する', () => {
    const result = updateListing(listing({ status: 'draft' }), { priceAmount: 0 });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('INVALID_MONEY');
  });

  it('表示順を変更できる', () => {
    const result = updateListing(listing({ status: 'draft' }), { displayOrder: 5 });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.displayOrder).toBe(5);
  });
});

describe('activateListing', () => {
  it('公開済みの作品なら販売開始できる', () => {
    const result = activateListing(listing({ status: 'draft' }), artwork(), NOW);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('active');
  });

  it('開始日時が未来なら scheduled になる', () => {
    // 開始時刻に列を書き換えるバッチを前提にしない。
    const result = activateListing(
      listing({ status: 'draft', startsAt: new Date(NOW.getTime() + 86_400_000) }),
      artwork(),
      NOW,
    );
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('scheduled');
  });

  it('作品が下書きなら販売開始できない', () => {
    // カタログに出ていないものが購入できる経路を作らない。
    const result = activateListing(listing({ status: 'draft' }), artwork({ status: 'draft' }), NOW);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('ARTWORK_NOT_PUBLISHED');
  });

  it('作品が非公開なら販売開始できない', () => {
    expect(
      activateListing(listing({ status: 'draft' }), artwork({ status: 'archived' }), NOW).ok,
    ).toBe(false);
  });

  it('販売終了日時を過ぎた出品は開始できない', () => {
    const result = activateListing(
      listing({ status: 'draft', endsAt: new Date(NOW.getTime() - 1000) }),
      artwork(),
      NOW,
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('LISTING_PERIOD_INVALID');
  });

  it('一時停止から再開できる', () => {
    expect(activateListing(listing({ status: 'suspended' }), artwork(), NOW).ok).toBe(true);
  });

  it('終了した出品は再開できない', () => {
    expect(activateListing(listing({ status: 'ended' }), artwork(), NOW).ok).toBe(false);
  });
});

describe('suspendListing / endListing', () => {
  it('販売中を一時停止できる', () => {
    const result = suspendListing(listing({ status: 'active' }));
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('suspended');
  });

  it('販売予定も一時停止できる', () => {
    expect(suspendListing(listing({ status: 'scheduled' })).ok).toBe(true);
  });

  it('下書きは一時停止できない', () => {
    expect(suspendListing(listing({ status: 'draft' })).ok).toBe(false);
  });

  it('ended 以外のどの状態からでも終了できる', () => {
    for (const status of ['draft', 'scheduled', 'active', 'suspended'] as const) {
      expect(endListing(listing({ status })).ok, status).toBe(true);
    }
    expect(endListing(listing({ status: 'ended' })).ok).toBe(false);
  });
});

describe('evaluatePurchasability', () => {
  it('公開・販売中・在庫あり・期間内なら購入できる', () => {
    expect(evaluatePurchasability({ listing: listing(), artwork: artwork(), now: NOW }).ok).toBe(
      true,
    );
  });

  it('作品が非公開なら購入できない', () => {
    const result = evaluatePurchasability({
      listing: listing(),
      artwork: artwork({ status: 'archived' }),
      now: NOW,
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('artwork_not_published');
  });

  it.each(['draft', 'suspended', 'ended'] as const)('出品が %s なら購入できない', (status) => {
    const result = evaluatePurchasability({
      listing: listing({ status }),
      artwork: artwork(),
      now: NOW,
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('listing_not_active');
  });

  it('販売開始前は購入できない', () => {
    const result = evaluatePurchasability({
      listing: listing({ startsAt: new Date(NOW.getTime() + 1000) }),
      artwork: artwork(),
      now: NOW,
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('not_started');
  });

  it('販売開始ちょうどは購入できる（境界）', () => {
    expect(
      evaluatePurchasability({ listing: listing({ startsAt: NOW }), artwork: artwork(), now: NOW })
        .ok,
    ).toBe(true);
  });

  it('終了時刻ちょうどは購入できない（境界）', () => {
    const result = evaluatePurchasability({
      listing: listing({ endsAt: NOW }),
      artwork: artwork(),
      now: NOW,
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('ended');
  });

  it('在庫が尽きていれば購入できない', () => {
    const result = evaluatePurchasability({
      listing: listing(),
      artwork: artwork({ maxSupply: 5, reservedCount: 2, issuedCount: 3 }),
      now: NOW,
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('sold_out');
  });

  it('仮引当だけで埋まっていても売り切れ扱いになる', () => {
    // 決済待ちの注文が押さえている分は売ってはいけない。
    const result = evaluatePurchasability({
      listing: listing(),
      artwork: artwork({ maxSupply: 1, reservedCount: 1, issuedCount: 0 }),
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe('unavailableReasonToError', () => {
  it('非公開作品は「見つからない」として扱う（存在を漏らさない）', () => {
    expect(unavailableReasonToError('artwork_not_published').code).toBe('ARTWORK_NOT_AVAILABLE');
  });

  it('売り切れは在庫不足として扱う', () => {
    expect(unavailableReasonToError('sold_out').code).toBe('INSUFFICIENT_SUPPLY');
  });

  it('すべての理由に対応がある', () => {
    for (const reason of [
      'artwork_not_published',
      'listing_not_active',
      'not_started',
      'ended',
      'sold_out',
    ] as const) {
      expect(unavailableReasonToError(reason).code).toBeTruthy();
    }
  });
});

describe('resolveDisplayState（表示状態は現在時刻から導く）', () => {
  it('販売中なら on_sale', () => {
    expect(resolveDisplayState({ listing: listing(), artwork: artwork(), now: NOW })).toBe(
      'on_sale',
    );
  });

  it('開始前なら scheduled', () => {
    expect(
      resolveDisplayState({
        listing: listing({ status: 'scheduled', startsAt: new Date(NOW.getTime() + 1000) }),
        artwork: artwork(),
        now: NOW,
      }),
    ).toBe('scheduled');
  });

  it('開始日時を過ぎた scheduled は on_sale として表示する', () => {
    // 状態列を書き換えるバッチが遅れても売れなくならないようにするため。
    expect(
      resolveDisplayState({
        listing: listing({ status: 'scheduled', startsAt: new Date(NOW.getTime() - 1000) }),
        artwork: artwork(),
        now: NOW,
      }),
    ).toBe('on_sale');
  });

  it('終了日時を過ぎていれば ended', () => {
    expect(
      resolveDisplayState({
        listing: listing({ endsAt: new Date(NOW.getTime() - 1000) }),
        artwork: artwork(),
        now: NOW,
      }),
    ).toBe('ended');
  });

  it('在庫が尽きていれば sold_out', () => {
    expect(
      resolveDisplayState({
        listing: listing(),
        artwork: artwork({ maxSupply: 1, issuedCount: 1 }),
        now: NOW,
      }),
    ).toBe('sold_out');
  });

  it('一時停止中は not_available', () => {
    expect(
      resolveDisplayState({
        listing: listing({ status: 'suspended' }),
        artwork: artwork(),
        now: NOW,
      }),
    ).toBe('not_available');
  });
});

describe('販売終了の表示（利用者に「終わった」と伝える）', () => {
  it('状態が ended なら期間に関わらず ended と表示する', () => {
    // 「ただいま販売しておりません」だと再開を待たせてしまう。
    expect(
      resolveDisplayState({
        listing: listing({ status: 'ended', endsAt: null }),
        artwork: artwork(),
        now: NOW,
      }),
    ).toBe('ended');
  });

  it('終了した出品が売り切れ扱いにならない', () => {
    expect(
      resolveDisplayState({
        listing: listing({ status: 'ended' }),
        artwork: artwork({ maxSupply: 1, issuedCount: 1 }),
        now: NOW,
      }),
    ).toBe('ended');
  });

  it('下書きは not_available（終了とは区別する）', () => {
    expect(
      resolveDisplayState({ listing: listing({ status: 'draft' }), artwork: artwork(), now: NOW }),
    ).toBe('not_available');
  });
});

describe('非公開化と出品の終了（非公開なのに販売中、を作らない）', () => {
  it('有効な出品（active / scheduled）をすべて終了させる', () => {
    const result = archiveArtworkAndEndListings(artwork(), [
      listing({ id: 'l-active', status: 'active' }),
      listing({ id: 'l-scheduled', status: 'scheduled', startsAt: NOW }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.artwork.status).toBe('archived');
    expect(result.value.endedListings.map((item) => item.id)).toEqual(['l-active', 'l-scheduled']);
    expect(result.value.endedListings.every((item) => item.status === 'ended')).toBe(true);
  });

  it('下書き・停止中・終了済みの出品は書き換えない', () => {
    // 有効でない出品まで ended にすると、下書きに戻せなくなる。
    const result = archiveArtworkAndEndListings(artwork(), [
      listing({ id: 'l-draft', status: 'draft' }),
      listing({ id: 'l-suspended', status: 'suspended' }),
      listing({ id: 'l-ended', status: 'ended' }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endedListings).toEqual([]);
  });

  it('別の作品の出品が混ざっていたら拒否する', () => {
    // 巻き込みで他作品の販売を止めるのは取り返しがつきにくい。
    const result = archiveArtworkAndEndListings(artwork({ id: 'artwork-1' }), [
      listing({ id: 'l-other', artworkId: 'artwork-2', status: 'active' }),
    ]);

    expect(result.ok).toBe(false);
  });

  it('非公開にできない状態なら、出品も書き換えない', () => {
    // 作品の遷移が失敗したのに出品だけ終了していたら、それこそ不整合になる。
    // すでに archived の作品は archived へ遷移できない（遷移表どおり）。
    const result = archiveArtworkAndEndListings(artwork({ status: 'archived' }), [
      listing({ status: 'active' }),
    ]);

    expect(result.ok).toBe(false);
  });

  it('下書きの作品も非公開にできる（遷移表どおり）', () => {
    // draft -> archived は許されている。公開しないまま取り下げる経路。
    const result = archiveArtworkAndEndListings(artwork({ status: 'draft' }), []);
    expect(result.ok).toBe(true);
  });
});
