import type { AccountLookupPort, AccountRecord, Role, TokenVerifierPort } from '@sengoku/auth';
import type {
  Artwork,
  ArtworkRepository,
  AuditEntry,
  AuditLogPort,
  ClockPort,
  IdGeneratorPort,
  Listing,
  ListingRepository,
  Page,
  PageQuery,
} from '@sengoku/domain';
import { InMemoryStorage } from '@sengoku/integrations';
import type { AppDependencies } from '../../src/app.module';

/**
 * API のテスト用の代替実装。
 *
 * HTTP モックではなく**ポートの Fake** を使うのは、
 * 自分が定義した契約を検証したいから。
 * HTTP モックは相手の仕様をテストに焼き付けてしまい、
 * 仕様が変わるとテストだけ通って本番が壊れる。
 */

export class InMemoryArtworkRepository implements ArtworkRepository {
  private readonly items = new Map<string, Artwork>();
  /** 挿入順を保持する（キーセットページングの代わり）。 */
  private readonly order: string[] = [];

  seed(artwork: Artwork): Artwork {
    this.items.set(artwork.id, artwork);
    if (!this.order.includes(artwork.id)) {
      this.order.unshift(artwork.id);
    }
    return artwork;
  }

  findById(id: string): Promise<Artwork | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }

  findBySlug(slug: string): Promise<Artwork | null> {
    const found = [...this.items.values()].find((item) => item.slug === slug);
    return Promise.resolve(found ?? null);
  }

  listPublished(query: PageQuery): Promise<Page<Artwork>> {
    return Promise.resolve(this.paginate(query, (item) => item.status === 'published'));
  }

  listAll(query: PageQuery): Promise<Page<Artwork>> {
    return Promise.resolve(this.paginate(query, () => true));
  }

  create(artwork: Artwork): Promise<Artwork> {
    return Promise.resolve(this.seed(artwork));
  }

  update(artwork: Artwork): Promise<Artwork> {
    this.items.set(artwork.id, artwork);
    return Promise.resolve(artwork);
  }

  private paginate(query: PageQuery, predicate: (item: Artwork) => boolean): Page<Artwork> {
    const all = this.order
      .map((id) => this.items.get(id))
      .filter((item): item is Artwork => item !== undefined)
      .filter(predicate);

    const start = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const page = all.slice(start, start + query.limit);
    const nextIndex = start + query.limit;
    return {
      items: page,
      nextCursor: nextIndex < all.length ? String(nextIndex) : null,
    };
  }
}

export class InMemoryListingRepository implements ListingRepository {
  private readonly items = new Map<string, Listing>();

  seed(listing: Listing): Listing {
    this.items.set(listing.id, listing);
    return listing;
  }

  findById(id: string): Promise<Listing | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }

  listAll(query: PageQuery): Promise<Page<Listing>> {
    const all = [...this.items.values()];
    const start = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const page = all.slice(start, start + query.limit);
    const nextIndex = start + query.limit;
    return Promise.resolve({
      items: page,
      nextCursor: nextIndex < all.length ? String(nextIndex) : null,
    });
  }

  listByArtwork(artworkId: string): Promise<readonly Listing[]> {
    return Promise.resolve([...this.items.values()].filter((item) => item.artworkId === artworkId));
  }

  findActiveByArtwork(artworkId: string): Promise<Listing | null> {
    const found = [...this.items.values()].find(
      (item) =>
        item.artworkId === artworkId && (item.status === 'active' || item.status === 'scheduled'),
    );
    return Promise.resolve(found ?? null);
  }

  create(listing: Listing): Promise<Listing> {
    return Promise.resolve(this.seed(listing));
  }

  update(listing: Listing): Promise<Listing> {
    this.items.set(listing.id, listing);
    return Promise.resolve(listing);
  }
}

export class InMemoryAccountRepository implements AccountLookupPort {
  private readonly items = new Map<string, AccountRecord>();

  seed(subject: string, role: Role, status: AccountRecord['status'] = 'active'): AccountRecord {
    const record: AccountRecord = {
      id: `account-${subject}`,
      authProvider: 'dev',
      authSubject: subject,
      role,
      status,
    };
    this.items.set(`dev:${subject}`, record);
    return record;
  }

  findByAuthSubject(provider: string, subject: string): Promise<AccountRecord | null> {
    return Promise.resolve(this.items.get(`${provider}:${subject}`) ?? null);
  }

  /** 初回アクセスで作られるロールは常に buyer。 */
  provision(provider: string, subject: string): Promise<AccountRecord> {
    const record: AccountRecord = {
      id: `account-${subject}`,
      authProvider: provider,
      authSubject: subject,
      role: 'buyer',
      status: 'active',
    };
    this.items.set(`${provider}:${subject}`, record);
    return Promise.resolve(record);
  }
}

export class FixedClock implements ClockPort {
  constructor(private readonly value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
}

export class SequentialIds implements IdGeneratorPort {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    // UUID 形式にしておく（契約側で uuid を要求している箇所があるため）。
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }
}

/** 監査記録をメモリに貯める。記録されたかをテストで確認するために使う。 */
export class InMemoryAuditLog implements AuditLogPort {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }
}

export interface TestHarness extends AppDependencies {
  readonly artworks: InMemoryArtworkRepository;
  readonly listings: InMemoryListingRepository;
  readonly accounts: InMemoryAccountRepository;
  readonly storage: InMemoryStorage;
  readonly audit: InMemoryAuditLog;
}

export const TEST_TOKEN_SECRET = 'test-token-secret';
export const TEST_ISSUER = 'https://auth.test';
export const TEST_AUDIENCE = 'sennokunnft-test';
export const TEST_NOW = new Date('2026-06-01T00:00:00.000Z');

export function buildHarness(tokenVerifier: TokenVerifierPort): TestHarness {
  return {
    version: '0.1.0',
    probes: [],
    artworks: new InMemoryArtworkRepository(),
    listings: new InMemoryListingRepository(),
    accounts: new InMemoryAccountRepository(),
    tokenVerifier,
    clock: new FixedClock(TEST_NOW),
    ids: new SequentialIds(),
    storage: new InMemoryStorage(),
    audit: new InMemoryAuditLog(),
    // テストでは決定論的なキーにする。実装は CSPRNG を使う。
    generateStorageKey: (prefix, extension) =>
      `${prefix}/test/${String(keyCounter++)}.${extension}`,
  };
}

let keyCounter = 1;

export function sampleArtwork(overrides: Partial<Artwork> = {}): Artwork {
  return {
    id: 'artwork-1',
    slug: 'sample-artwork',
    title: 'サンプル作品',
    description: '説明文',
    imageKey: 'images/sample.png',
    imageContentType: 'image/png',
    imageByteSize: 2048,
    maxSupply: 10,
    reservedCount: 0,
    issuedCount: 0,
    status: 'published',
    ...overrides,
  };
}

export function sampleListing(overrides: Partial<Listing> = {}): Listing {
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
