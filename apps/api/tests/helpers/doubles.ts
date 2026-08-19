import type { AccountLookupPort, AccountRecord, Role, TokenVerifierPort } from '@sengoku/auth';
import type {
  Artwork,
  ArtworkRepository,
  AuditEntry,
  AuditLogPort,
  ClockPort,
  IdGeneratorPort,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyState,
  IdempotencyStore,
  Listing,
  ListingRepository,
  ConnectionCheckRecord,
  IntegrationEnvironment,
  IntegrationRepository,
  IntegrationSecret,
  IntegrationService,
  IntegrationSettings,
  SealedSecret,
  SecretCipherPort,
  SecretPurpose,
  SecretScope,
  Page,
  PageQuery,
  StaffInvitation,
  StaffInvitationRepository,
  StaffMember,
  StaffMemberRepository,
  AuditLogEntryRecord,
  AuditLogPage,
  AuditLogQuery,
  AuditLogReadPort,
  WalletDeliveryAdminPage,
  WalletDeliveryAdminPort,
  WalletDeliveryAdminQuery,
  WalletDeliveryAdminRecord,
  WalletDeliveryStatusCounts,
  ProbeOutcome,
  EnvIntegrationSummary,
  CommonUserLink,
  CommonUserLinkRepository,
  ConfirmPaymentCommand,
  PaymentAttemptView,
  PaymentRepository,
  RecordCheckoutSessionCommand,
  RecordWebhookCommand,
  WebhookClaim,
  WebhookReceiptRecord,
  CreateOrderCommand,
  CreateOrderOutcome,
  DomainError,
  OrderListPage,
  OrderListQuery,
  OrderRepository,
  OrderView,
  RandomPort,
  ReleasedReservation,
  Result,
  LegalDocumentRepository,
  LegalDocumentKind,
  LegalDocumentVersion,
  CreateLegalDraftCommand,
  SaveLegalDraftCommand,
  PublishLegalVersionCommand,
} from '@sengoku/domain';
import { canManuallyResend, err, ok, reserveSupply, PAYMENT_API_ENDPOINT } from '@sengoku/domain';
import { contentHash, FakePaymentGateway, InMemoryStorage } from '@sengoku/integrations';
import type { Logger } from '@sengoku/observability';

/**
 * 何も出さない記録係。
 *
 * ⚠️ **本物の logger を使わない。** 試験のたびに出力が混ざり、
 * 本当に見たい失敗の行が埋もれる。
 */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;
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

  /** 非公開化のときに出品も書き換えるため、出品側の保管庫を借りる。 */
  constructor(private readonly listings: InMemoryListingRepository) {}

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

  listByCreator(creatorAccountId: string, query: PageQuery): Promise<Page<Artwork>> {
    return Promise.resolve(
      this.paginate(query, (item) => item.creatorAccountId === creatorAccountId),
    );
  }

  create(artwork: Artwork): Promise<Artwork> {
    return Promise.resolve(this.seed(artwork));
  }

  update(artwork: Artwork): Promise<Artwork> {
    this.items.set(artwork.id, artwork);
    return Promise.resolve(artwork);
  }

  /**
   * 実装は 1 トランザクションで書く。ここでは順に書くだけだが、
   * **出品側も必ず書く**ことが重要で、書かないと
   * 「作品だけ非公開になった」状態をテストが素通りさせてしまう。
   */
  async archiveWithListings(artwork: Artwork, endedListings: readonly Listing[]): Promise<Artwork> {
    for (const listing of endedListings) {
      await this.listings.update(listing);
    }
    this.items.set(artwork.id, artwork);
    return artwork;
  }

  /** 実装は 1 トランザクションで消す。ここでは順に消すだけ。 */
  async deleteWithListings(artworkId: string, listingIds: readonly string[]): Promise<void> {
    for (const listingId of listingIds) {
      await this.listings.remove(listingId, artworkId);
    }
    this.items.delete(artworkId);
    const index = this.order.indexOf(artworkId);
    if (index >= 0) {
      this.order.splice(index, 1);
    }
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

  /** 作品の削除に伴う後始末。作品IDが一致しないものは消さない。 */
  remove(id: string, artworkId: string): Promise<void> {
    const found = this.items.get(id);
    if (found !== undefined && found.artworkId === artworkId) {
      this.items.delete(id);
    }
    return Promise.resolve();
  }
}

export class InMemoryAccountRepository implements AccountLookupPort {
  private readonly items = new Map<string, AccountRecord>();

  seed(
    subject: string,
    role: Role,
    options: { status?: AccountRecord['status']; isOwner?: boolean } = {},
  ): AccountRecord {
    const record: AccountRecord = {
      id: `account-${subject}`,
      authProvider: 'dev',
      authSubject: subject,
      role,
      status: options.status ?? 'active',
      isOwner: options.isOwner ?? false,
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
      isOwner: false,
    };
    this.items.set(`${provider}:${subject}`, record);
    return Promise.resolve(record);
  }

  /** アカウントIDで引く。スタッフ側の代替実装が同じ保管庫を共有するため。 */
  byId(accountId: string): AccountRecord | undefined {
    return [...this.items.values()].find((item) => item.id === accountId);
  }

  replace(record: AccountRecord): void {
    this.items.set(`${record.authProvider}:${record.authSubject}`, record);
  }

  all(): readonly AccountRecord[] {
    return [...this.items.values()];
  }
}

/**
 * スタッフの代替実装。
 *
 * ⚠️ **アカウントの保管庫を共有する。** 別々に持つと、
 * 「権限を上げたのにガードが古いロールを見る」というテストだけの世界ができ、
 * 本物では起きない結果になる。
 */
export class InMemoryStaffMemberRepository implements StaffMemberRepository {
  constructor(private readonly accounts: InMemoryAccountRepository) {}

  private toMember(record: AccountRecord): StaffMember {
    return {
      accountId: record.id,
      role: record.role === 'anonymous' ? 'buyer' : record.role,
      status: record.status,
      isOwner: record.isOwner,
      staffEmail: this.emails.get(record.id) ?? null,
    };
  }

  /** 連絡先は `AccountRecord` に無いので、ここで持つ。 */
  private readonly emails = new Map<string, string>();

  listStaff(): Promise<readonly StaffMember[]> {
    return Promise.resolve(
      this.accounts
        .all()
        .filter((item) => item.role === 'operator' || item.role === 'auditor')
        .map((item) => this.toMember(item)),
    );
  }

  findById(accountId: string): Promise<StaffMember | null> {
    const record = this.accounts.byId(accountId);
    return Promise.resolve(record === undefined ? null : this.toMember(record));
  }

  findByStaffEmail(email: string): Promise<StaffMember | null> {
    const found = [...this.emails.entries()].find(
      ([, value]) => value.toLowerCase() === email.toLowerCase(),
    );
    if (found === undefined) {
      return Promise.resolve(null);
    }
    const record = this.accounts.byId(found[0]);
    return Promise.resolve(record === undefined ? null : this.toMember(record));
  }

  async updateWithOwnerCount(
    accountId: string,
    decide: (
      member: StaffMember,
      activeOwnerCount: number,
    ) => StaffMember | null | Promise<StaffMember | null>,
  ): Promise<StaffMember> {
    const record = this.accounts.byId(accountId);
    if (record === undefined) {
      throw new Error('staff member not found');
    }
    const activeOwnerCount = this.accounts
      .all()
      .filter((item) => item.isOwner && item.status === 'active').length;

    const next = await decide(this.toMember(record), activeOwnerCount);
    if (next === null) {
      return this.toMember(record);
    }
    this.accounts.replace({
      ...record,
      role: next.role,
      status: next.status,
      isOwner: next.isOwner,
    });
    if (next.staffEmail === null) {
      this.emails.delete(accountId);
    } else {
      this.emails.set(accountId, next.staffEmail);
    }
    return next;
  }
}

export class InMemoryStaffInvitationRepository implements StaffInvitationRepository {
  private readonly items = new Map<string, StaffInvitation>();

  seed(invitation: StaffInvitation): StaffInvitation {
    this.items.set(invitation.id, invitation);
    return invitation;
  }

  list(): Promise<readonly StaffInvitation[]> {
    return Promise.resolve([...this.items.values()]);
  }

  findById(id: string): Promise<StaffInvitation | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }

  findOpenByEmail(email: string, now: Date): Promise<StaffInvitation | null> {
    const found = [...this.items.values()].find(
      (item) =>
        item.status === 'pending' &&
        item.email.toLowerCase() === email.toLowerCase() &&
        item.expiresAt.getTime() > now.getTime(),
    );
    return Promise.resolve(found ?? null);
  }

  create(invitation: StaffInvitation, now: Date): Promise<StaffInvitation | null> {
    for (const [id, item] of this.items) {
      if (
        item.status !== 'pending' ||
        item.email.toLowerCase() !== invitation.email.toLowerCase()
      ) {
        continue;
      }
      if (item.expiresAt.getTime() <= now.getTime()) {
        // 期限切れは閉じてから作り直す（実装は部分UNIQUEに阻まれるため）。
        this.items.set(id, { ...item, status: 'expired', closedAt: now });
        continue;
      }
      return Promise.resolve(null);
    }
    this.items.set(invitation.id, invitation);
    return Promise.resolve(invitation);
  }

  update(invitation: StaffInvitation): Promise<StaffInvitation> {
    this.items.set(invitation.id, invitation);
    return Promise.resolve(invitation);
  }

  async acceptWithMember(
    invitation: StaffInvitation,
    member: StaffMember,
  ): Promise<{ invitation: StaffInvitation; member: StaffMember }> {
    const current = this.items.get(invitation.id);
    if (current === undefined || current.status !== 'pending') {
      throw new Error('invitation was already closed');
    }
    this.items.set(invitation.id, invitation);
    const saved = await this.staff.updateWithOwnerCount(member.accountId, () => member);
    return { invitation, member: saved };
  }

  constructor(private readonly staff: InMemoryStaffMemberRepository) {}
}

/**
 * 試験用の暗号。
 *
 * ⚠️ **平文をそのまま返さない形にしてある。** 「暗号化しているつもりで
 * 素通し」だと、`応答に秘密が含まれない` の試験が通ってしまい、
 * 本物で漏れていても気付けない。
 */
export class ReversibleTestCipher implements SecretCipherPort {
  seal(plaintext: string, scope: SecretScope): SealedSecret {
    return {
      ciphertext: Buffer.from(`${scope.service}|${plaintext}`, 'utf8').toString('base64'),
      nonce: 'test-nonce',
      authTag: 'test-tag',
      keyVersion: 'v1',
      lastFour: plaintext.length >= 8 ? plaintext.slice(-4) : '',
    };
  }

  open(sealed: SealedSecret, scope: SecretScope): string | null {
    const decoded = Buffer.from(sealed.ciphertext, 'base64').toString('utf8');
    const prefix = `${scope.service}|`;
    return decoded.startsWith(prefix) ? decoded.slice(prefix.length) : null;
  }
}

/**
 * 外部連携の代替実装。
 *
 * ⚠️ **平文を返すのは `revealForAdapter` だけ。** 本物と同じ形にして
 * おかないと、試験だけ通って本番で漏れる。
 */
export class InMemoryIntegrationRepository implements IntegrationRepository {
  private readonly settings = new Map<string, IntegrationSettings>();
  private readonly secrets = new Map<string, IntegrationSecret & { sealed: SealedSecret }>();
  private readonly checks: ConnectionCheckRecord[] = [];
  private readonly cipher = new ReversibleTestCipher();

  private key(service: string, environment: string): string {
    return `${service}:${environment}`;
  }

  ensureSettings(
    id: string,
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationSettings> {
    const key = this.key(service, environment);
    const existing = this.settings.get(key);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const created: IntegrationSettings = {
      id,
      service,
      environment,
      // ⚠️ 本物と同じく、決済だけ既定の接続先を入れる。
      endpointUrl: service === 'payment' ? PAYMENT_API_ENDPOINT : null,
      keyId: null,
      apiVersion: null,
      timeoutMs: 10_000,
      maxAttempts: 5,
      enabled: false,
      payment: {
        apiVersion: null,
        checkoutSuccessUrl: null,
        checkoutCancelUrl: null,
        platformFeeRateBps: 0,
      },
      rowVersion: 1,
    };
    this.settings.set(key, created);
    return Promise.resolve(created);
  }

  findSettings(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationSettings | null> {
    return Promise.resolve(this.settings.get(this.key(service, environment)) ?? null);
  }

  listSettings(): Promise<readonly IntegrationSettings[]> {
    return Promise.resolve([...this.settings.values()]);
  }

  saveSettings(
    settings: IntegrationSettings,
    expectedRowVersion: number,
  ): Promise<IntegrationSettings | null> {
    const key = this.key(settings.service, settings.environment);
    const current = this.settings.get(key);
    if (current === undefined || current.rowVersion !== expectedRowVersion) {
      return Promise.resolve(null);
    }
    const saved = { ...settings, rowVersion: current.rowVersion + 1 };
    this.settings.set(key, saved);
    return Promise.resolve(saved);
  }

  listSecrets(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<readonly IntegrationSecret[]> {
    return Promise.resolve(
      [...this.secrets.values()]
        .filter((item) => item.service === service && item.environment === environment)
        .map(stripSealed),
    );
  }

  findSecretById(id: string): Promise<IntegrationSecret | null> {
    const found = this.secrets.get(id);
    return Promise.resolve(found === undefined ? null : stripSealed(found));
  }

  findSecretByStatus(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    purpose: SecretPurpose,
    status: 'pending' | 'active',
  ): Promise<IntegrationSecret | null> {
    const found = [...this.secrets.values()].find(
      (item) =>
        item.service === service &&
        item.environment === environment &&
        item.purpose === purpose &&
        item.status === status,
    );
    return Promise.resolve(found === undefined ? null : stripSealed(found));
  }

  createSecret(input: {
    readonly id: string;
    readonly service: IntegrationService;
    readonly environment: IntegrationEnvironment;
    readonly purpose: SecretPurpose;
    readonly plaintext: string;
    readonly createdByAccountId: string;
  }): Promise<IntegrationSecret | null> {
    const duplicate = [...this.secrets.values()].some(
      (item) =>
        item.service === input.service &&
        item.environment === input.environment &&
        item.purpose === input.purpose &&
        item.status === 'pending',
    );
    if (duplicate) {
      return Promise.resolve(null);
    }

    const sealed = this.cipher.seal(input.plaintext, {
      service: input.service,
      environment: input.environment,
    });
    const record = {
      id: input.id,
      service: input.service,
      environment: input.environment,
      purpose: input.purpose,
      keyVersion: sealed.keyVersion,
      lastFour: sealed.lastFour,
      status: 'pending' as const,
      activatedAt: null,
      retiredAt: null,
      createdAt: new Date(TEST_NOW),
      sealed,
    };
    this.secrets.set(record.id, record);
    return Promise.resolve(stripSealed(record));
  }

  activateSecret(activated: IntegrationSecret, retired: IntegrationSecret | null): Promise<void> {
    if (retired !== null) {
      const current = this.secrets.get(retired.id);
      if (current !== undefined) {
        this.secrets.set(retired.id, { ...current, ...retired });
      }
    }
    const target = this.secrets.get(activated.id);
    if (target !== undefined) {
      this.secrets.set(activated.id, { ...target, ...activated });
    }
    return Promise.resolve();
  }

  updateSecret(secret: IntegrationSecret): Promise<IntegrationSecret> {
    const current = this.secrets.get(secret.id);
    if (current !== undefined) {
      this.secrets.set(secret.id, { ...current, ...secret });
    }
    return Promise.resolve(secret);
  }

  revealForAdapter(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    purpose: SecretPurpose,
  ): Promise<string | null> {
    const found = [...this.secrets.values()].find(
      (item) =>
        item.service === service &&
        item.environment === environment &&
        item.purpose === purpose &&
        item.status === 'active',
    );
    if (found === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.cipher.open(found.sealed, { service, environment }));
  }

  recordConnectionCheck(record: ConnectionCheckRecord): Promise<void> {
    this.checks.push(record);
    return Promise.resolve();
  }

  findLatestConnectionCheck(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<ConnectionCheckRecord | null> {
    const matching = this.checks
      .filter((item) => item.service === service && item.environment === environment)
      .sort(byLatestThenFailureFirst);
    return Promise.resolve(matching[0] ?? null);
  }

  listConnectionChecks(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    limit: number,
  ): Promise<readonly ConnectionCheckRecord[]> {
    return Promise.resolve(
      this.checks
        .filter((item) => item.service === service && item.environment === environment)
        // 一覧の並びも「直近」の判定と揃える。画面と判定が食い違わないように。
        .sort(byLatestThenFailureFirst)
        .slice(0, limit),
    );
  }

  invalidateConnectionChecks(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<void> {
    for (let index = 0; index < this.checks.length; index += 1) {
      const check = this.checks[index];
      if (check !== undefined && check.service === service && check.environment === environment) {
        this.checks[index] = { ...check, succeeded: false, failureCode: 'SETTINGS_CHANGED' };
      }
    }
    return Promise.resolve();
  }
}

function stripSealed(record: IntegrationSecret & { sealed?: SealedSecret }): IntegrationSecret {
  // ⚠️ 暗号文を外へ出さない。本物のリポジトリと同じ形にそろえる。
  const { sealed: _sealed, ...rest } = record;
  return rest;
}

export class FixedClock implements ClockPort {
  constructor(private value: Date) {}
  now(): Date {
    return new Date(this.value);
  }

  /** 時刻を進める。期限切れの試験で使う。 */
  advanceMs(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }

  /** 時刻を差し替える。施行日をまたぐ試験で使う。 */
  set(value: Date): void {
    this.value = new Date(value);
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

/**
 * 配送待ち行列（テスト用）。
 *
 * ⚠️ **本文をこの二重体にも持たせない。** 実装は `payload` 列を
 * SELECT しない。テスト側だけが本文を持てる形にすると、
 * 「本文を返していないこと」の試験が二重体の都合で通ってしまう。
 */
export class InMemoryWalletDeliveries implements WalletDeliveryAdminPort {
  private readonly rows = new Map<string, WalletDeliveryAdminRecord>();

  seed(overrides: Partial<WalletDeliveryAdminRecord> & { id: string }): WalletDeliveryAdminRecord {
    const row: WalletDeliveryAdminRecord = {
      eventId: `evt_${overrides.id}`,
      eventType: 'entitlement.granted',
      entitlementId: 'entitlement-1',
      targetSiteKey: 'ovew-wallet',
      payloadHash: `sha256:${'0'.repeat(64)}`,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 5,
      nextRetryAt: TEST_NOW,
      lastErrorCode: null,
      lastErrorMessage: null,
      correlationId: 'corr_test',
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      deliveredAt: null,
      ...overrides,
    };
    this.rows.set(row.id, row);
    return row;
  }

  list(query: WalletDeliveryAdminQuery): Promise<WalletDeliveryAdminPage> {
    let items = [...this.rows.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    if (query.statuses.length > 0) {
      items = items.filter((row) => query.statuses.includes(row.status));
    }
    if (query.eventId !== null) {
      items = items.filter((row) => row.eventId === query.eventId);
    }
    if (query.entitlementId !== null) {
      items = items.filter((row) => row.entitlementId === query.entitlementId);
    }
    return Promise.resolve({ items: items.slice(0, query.limit), nextCursor: null });
  }

  countByStatus(): Promise<WalletDeliveryStatusCounts> {
    const counts = { PENDING: 0, PROCESSING: 0, DELIVERED: 0, FAILED: 0, DEAD: 0 };
    for (const row of this.rows.values()) {
      counts[row.status] += 1;
    }
    return Promise.resolve(counts);
  }

  findById(id: string): Promise<WalletDeliveryAdminRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  /**
   * 手で送り直す。
   *
   * ⚠️ **状態の条件を実装と揃える。** 実装は `WHERE status IN ('FAILED','DEAD')`
   * の条件付き UPDATE で戻す。ここを無条件にすると、
   * 「送信中の行を戻さない」試験が二重体の都合で通ってしまう。
   */
  requeue(input: { readonly id: string; readonly now: Date }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (row === undefined || !canManuallyResend(row.status)) {
      return Promise.resolve(false);
    }
    this.rows.set(input.id, {
      ...row,
      status: 'PENDING',
      attemptCount: 0,
      nextRetryAt: input.now,
      updatedAt: input.now,
    });
    return Promise.resolve(true);
  }
}

/**
 * 監査ログの閲覧（テスト用）。
 *
 * 記録側（`InMemoryAuditLog`）が貯めたものをそのまま読む。
 * 「操作したら監査に残り、その画面から見える」までを 1 本で確かめられる。
 */
/**
 * 法務文書の保管庫（試験用）。
 *
 * ⚠️ **本物と同じく、公開済みを書き換えない。** 二重書きは
 * `saveDraft` / `publish` が `null` を返すことで表す。ここを緩めると、
 * 本物の `updateMany` の `where` を外しても試験が通ってしまう。
 */
export class InMemoryLegalDocuments implements LegalDocumentRepository {
  private readonly rows: LegalDocumentVersion[] = [];
  private counter = 1;

  seed(version: LegalDocumentVersion): void {
    this.rows.push(version);
  }

  listVersions(kind: LegalDocumentKind): Promise<readonly LegalDocumentVersion[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.kind === kind).sort((a, b) => b.version - a.version),
    );
  }

  findById(id: string): Promise<LegalDocumentVersion | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  findDraft(kind: LegalDocumentKind): Promise<LegalDocumentVersion | null> {
    return Promise.resolve(
      this.rows.find((row) => row.kind === kind && row.status === 'draft') ?? null,
    );
  }

  findEffective(kind: LegalDocumentKind, now: Date): Promise<LegalDocumentVersion | null> {
    const candidates = this.rows
      .filter(
        (row) =>
          row.kind === kind &&
          row.status === 'published' &&
          row.effectiveFrom !== null &&
          row.effectiveFrom.getTime() <= now.getTime(),
      )
      .sort((a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0));
    return Promise.resolve(candidates[0] ?? null);
  }

  create(command: CreateLegalDraftCommand): Promise<LegalDocumentVersion> {
    const latest = this.rows
      .filter((row) => row.kind === command.kind)
      .reduce((max, row) => Math.max(max, row.version), 0);
    const row: LegalDocumentVersion = {
      id: `legal-${String(this.counter++)}`,
      kind: command.kind,
      version: latest + 1,
      status: 'draft',
      title: command.title,
      bodyText: command.bodyText,
      tokushoho: command.tokushoho,
      effectiveFrom: null,
      publishedAt: null,
      createdByAccountId: command.createdByAccountId,
      publishedByAccountId: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  saveDraft(command: SaveLegalDraftCommand): Promise<LegalDocumentVersion | null> {
    const index = this.rows.findIndex((row) => row.id === command.id && row.status === 'draft');
    if (index === -1) {
      return Promise.resolve(null);
    }
    const current = this.rows[index] as LegalDocumentVersion;
    const next: LegalDocumentVersion = {
      ...current,
      title: command.title,
      bodyText: command.bodyText,
      tokushoho: command.tokushoho,
    };
    this.rows[index] = next;
    return Promise.resolve(next);
  }

  publish(command: PublishLegalVersionCommand): Promise<LegalDocumentVersion | null> {
    const index = this.rows.findIndex((row) => row.id === command.id && row.status === 'draft');
    if (index === -1) {
      return Promise.resolve(null);
    }
    const current = this.rows[index] as LegalDocumentVersion;
    const next: LegalDocumentVersion = {
      ...current,
      status: 'published',
      effectiveFrom: command.effectiveFrom,
      publishedAt: command.publishedAt,
      publishedByAccountId: command.publishedByAccountId,
    };
    this.rows[index] = next;
    return Promise.resolve(next);
  }
}

export class InMemoryAuditLogReader implements AuditLogReadPort {
  constructor(
    private readonly source: InMemoryAuditLog,
    /** アカウントIDから連絡先を引く。実装の JOIN にあたる。 */
    private readonly emails: Map<string, string> = new Map(),
  ) {}

  setEmail(accountId: string, email: string): void {
    this.emails.set(accountId, email);
  }

  list(query: AuditLogQuery): Promise<AuditLogPage> {
    let items: AuditLogEntryRecord[] = this.source.entries.map((entry, index) => ({
      id: `audit-${String(index)}`,
      actorAccountId: entry.actorAccountId,
      actorEmail:
        query.includeActorContact && entry.actorAccountId !== null
          ? (this.emails.get(entry.actorAccountId) ?? null)
          : null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary: entry.summary,
      occurredAt: TEST_NOW,
    }));
    items = items.reverse();

    if (query.actionPrefix !== null) {
      const prefix = query.actionPrefix;
      items = items.filter((item) => item.action.startsWith(prefix));
    }
    if (query.targetType !== null) {
      items = items.filter((item) => item.targetType === query.targetType);
    }
    return Promise.resolve({ items: items.slice(0, query.limit), nextCursor: null });
  }
}

/**
 * 接続確認の並び順。
 *
 * ⚠️ **同じ時刻で並んだときは失敗を先に採る。** 本番を有効にしてよいかの
 * 判定に使う値なので、どちらを「直近」とするかが実行ごとに変わってはいけない。
 * 迷ったら閉じるほうへ倒す。**実装（Prisma）と同じ規則にしてある。**
 */
function byLatestThenFailureFirst(a: ConnectionCheckRecord, b: ConnectionCheckRecord): number {
  const byTime = b.executedAt.getTime() - a.executedAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  if (a.succeeded !== b.succeeded) {
    return a.succeeded ? 1 : -1;
  }
  return b.id.localeCompare(a.id);
}

/**
 * 注文の保管庫（テスト用）。
 *
 * ⚠️ **在庫のカウンタを本当に動かす。** 予約を作るだけで作品側を
 * 触らない Fake にすると、「予約したのに在庫が減らない」という
 * 最も起きてほしくない不具合を、テストが素通りさせる。
 *
 * ⚠️ 排他は再現できない（単一スレッドなので割り込みが起きない）。
 * 同時実行の検証は実 PostgreSQL の結合テストが受け持つ。
 */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, OrderView>();
  /** 冪等キーの索引。`accountId + key`。実装は DB の UNIQUE 制約。 */
  private readonly byIdempotency = new Map<string, string>();
  private readonly sequence: string[] = [];

  constructor(private readonly artworks: InMemoryArtworkRepository) {}

  async createWithReservation(
    command: CreateOrderCommand,
  ): Promise<Result<CreateOrderOutcome, DomainError>> {
    const existingId = this.byIdempotency.get(`${command.accountId} ${command.idempotencyKey}`);
    if (existingId !== undefined) {
      const existing = this.orders.get(existingId);
      if (existing === undefined || existing.item?.listingId !== command.item.listingId) {
        return ok<CreateOrderOutcome>({ kind: 'conflict' });
      }
      return ok<CreateOrderOutcome>({ kind: 'reused', order: existing });
    }

    const artwork = await this.artworks.findById(command.item.artworkId);
    if (artwork === null) {
      return err({ code: 'ARTWORK_NOT_AVAILABLE', message: 'artwork not found' });
    }
    const reserved = reserveSupply(artwork, command.quantity);
    if (!reserved.ok) {
      return reserved;
    }
    await this.artworks.update({ ...artwork, reservedCount: reserved.value.reservedCount });

    const view: OrderView = {
      id: command.orderId,
      orderNumber: command.orderNumber,
      accountId: command.accountId,
      creatorAccountId: command.creatorAccountId,
      status: command.orderStatus,
      paymentStatus: command.paymentStatus,
      fulfillmentStatus: command.fulfillmentStatus,
      refundStatus: command.refundStatus,
      currency: command.currency,
      subtotalAmount: command.amounts.subtotalAmount,
      discountAmount: command.amounts.discountAmount,
      totalAmount: command.amounts.totalAmount,
      platformFeeRateBps: command.amounts.platformFeeRateBps,
      platformFeeAmount: command.amounts.platformFeeAmount,
      creatorAmount: command.amounts.creatorAmount,
      reservationExpiresAt: command.reservationExpiresAt,
      paidAt: null,
      idempotencyKeyPrefix: command.idempotencyKey.slice(0, 8),
      createdAt: command.now,
      item: {
        id: command.item.id,
        listingId: command.item.listingId,
        artworkId: command.item.artworkId,
        creatorAccountId: command.item.creatorAccountId,
        titleSnapshot: command.item.titleSnapshot,
        unitPriceAmount: command.item.unitPriceAmount,
        unitPriceCurrency: command.item.unitPriceCurrency,
        quantity: command.item.quantity,
        totalAmount: command.item.totalAmount,
      },
      reservation: {
        id: command.reservationId,
        status: 'reserved',
        quantity: command.quantity,
        expiresAt: command.reservationExpiresAt,
        consumedAt: null,
        releasedAt: null,
      },
      hasPayment: false,
      entitlementCount: 0,
    };
    this.orders.set(view.id, view);
    this.byIdempotency.set(`${command.accountId} ${command.idempotencyKey}`, view.id);
    this.sequence.unshift(view.id);
    return ok<CreateOrderOutcome>({ kind: 'created', order: view });
  }

  findById(orderId: string): Promise<OrderView | null> {
    return Promise.resolve(this.orders.get(orderId) ?? null);
  }

  // --- 決済からの書き込み（決済 Phase P2）--------------------------------
  //
  // ⚠️ **在庫のカウンタを動かさない**（決定 A）。決済が成功しても
  //    `reservedCount` は減らさず、`issuedCount` も増やさない。

  markCheckoutCreated(orderId: string, now: Date): Promise<void> {
    const order = this.orders.get(orderId);
    if (
      order !== undefined &&
      (order.status === 'pending' || order.status === 'checkout_created')
    ) {
      this.orders.set(orderId, {
        ...order,
        status: 'checkout_created',
        paymentStatus: 'pending',
      });
    }
    void now;
    return Promise.resolve();
  }

  markPaid(orderId: string, paidAt: Date): Promise<void> {
    const order = this.orders.get(orderId);
    if (
      order !== undefined &&
      (order.status === 'pending' || order.status === 'checkout_created')
    ) {
      this.orders.set(orderId, {
        ...order,
        status: 'paid',
        paymentStatus: 'succeeded',
        paidAt,
        // ⚠️ 予約は consumed になるが、枠は reservedCount 側で押さえ続ける。
        reservation:
          order.reservation === null
            ? null
            : { ...order.reservation, status: 'consumed', consumedAt: paidAt },
      });
    }
    return Promise.resolve();
  }

  markPaymentFailed(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    // ⚠️ 注文の状態は動かさない（決定 B）。期限内なら再試行できる。
    if (order !== undefined && order.paymentStatus === 'pending') {
      this.orders.set(orderId, { ...order, paymentStatus: 'failed' });
    }
    return Promise.resolve();
  }

  async expireByCheckout(orderId: string, now: Date): Promise<boolean> {
    const order = this.orders.get(orderId);
    const reservation = order?.reservation;
    if (order === undefined || reservation == null || reservation.status !== 'reserved') {
      // 解放ジョブが先に処理していた。在庫を二重に戻さない。
      return false;
    }
    const artwork = await this.artworks.findById(order.item?.artworkId ?? '');
    if (artwork !== null) {
      await this.artworks.update({
        ...artwork,
        reservedCount: artwork.reservedCount - reservation.quantity,
      });
    }
    this.orders.set(orderId, {
      ...order,
      status: 'expired',
      paymentStatus: 'cancelled',
      reservation: { ...reservation, status: 'released', releasedAt: now },
    });
    return true;
  }

  list(query: OrderListQuery): Promise<OrderListPage> {
    const all = this.sequence
      .map((id) => this.orders.get(id))
      .filter((item): item is OrderView => item !== undefined)
      .filter((item) => query.status === undefined || item.status === query.status)
      .filter((item) => query.accountId === undefined || item.accountId === query.accountId);
    const start = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const page = all.slice(start, start + query.limit);
    const nextIndex = start + query.limit;
    return Promise.resolve({
      items: page,
      nextCursor: nextIndex < all.length ? String(nextIndex) : null,
    });
  }

  async releaseExpiredReservations(
    now: Date,
    limit: number,
  ): Promise<readonly ReleasedReservation[]> {
    const released: ReleasedReservation[] = [];
    for (const id of this.sequence) {
      if (released.length >= limit) break;
      const order = this.orders.get(id);
      const reservation = order?.reservation;
      if (order === undefined || reservation == null) continue;
      // ⚠️ `reserved` かつ期限到来のものだけ。ここを緩めると再実行で二重に戻る。
      if (reservation.status !== 'reserved' || reservation.expiresAt.getTime() > now.getTime()) {
        continue;
      }
      const artworkId = order.item?.artworkId ?? '';
      const artwork = await this.artworks.findById(artworkId);
      if (artwork !== null) {
        await this.artworks.update({
          ...artwork,
          reservedCount: artwork.reservedCount - reservation.quantity,
        });
      }
      this.orders.set(id, {
        ...order,
        status:
          order.status === 'pending' || order.status === 'checkout_created'
            ? 'expired'
            : order.status,
        reservation: { ...reservation, status: 'released', releasedAt: now },
      });
      released.push({
        reservationId: reservation.id,
        orderId: order.id,
        artworkId,
        quantity: reservation.quantity,
      });
    }
    return released;
  }
}

/** 共通顧客IDの紐付け（テスト用）。既定は未解決。 */
export class InMemoryCommonUserLinks implements CommonUserLinkRepository {
  private readonly links = new Map<string, CommonUserLink>();

  seed(link: CommonUserLink): void {
    this.links.set(link.accountId, link);
  }

  findByAccountId(accountId: string): Promise<CommonUserLink | null> {
    return Promise.resolve(this.links.get(accountId) ?? null);
  }

  listDue(): Promise<readonly CommonUserLink[]> {
    return Promise.resolve([]);
  }

  save(link: CommonUserLink): Promise<boolean> {
    this.links.set(link.accountId, link);
    return Promise.resolve(true);
  }
}

/**
 * 乱数（テスト用）。
 *
 * ⚠️ **決定論にしてあるのはテストのため。** 実装は CSPRNG を使う。
 * ここを本番へ流用すると、注文番号が予測できるようになる。
 */
export class SequentialRandom implements RandomPort {
  private counter = 0;

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      this.counter = (this.counter + 7) % 251;
      out[index] = this.counter;
    }
    return out;
  }
}

/**
 * 決済の保管庫（テスト用）。
 *
 * ⚠️ **在庫のカウンタを動かさない**（決定 A）。決済が成功しても
 * `reservedCount` は減らさず、`issuedCount` も増やさない。
 * ここを動かす Fake にすると、本番の設計と食い違ったまま試験が通る。
 */
export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly attempts = new Map<string, PaymentAttemptView[]>();
  private readonly events = new Map<string, { status: string; attemptCount: number }>();
  /** 作られた出来事。⚠️ 1 注文につき 1 件だけであることを試験が見る。 */
  readonly outbox: { orderId: string; eventId: string }[] = [];

  constructor(private readonly orders: InMemoryOrderRepository) {}

  claimWebhookEvent(command: RecordWebhookCommand): Promise<WebhookClaim> {
    const key = `${command.provider} ${command.eventId}`;
    const existing = this.events.get(key);
    if (existing !== undefined) {
      existing.attemptCount += 1;
      return Promise.resolve({ kind: 'duplicate' });
    }
    this.events.set(key, { status: 'received', attemptCount: 1 });
    return Promise.resolve({ kind: 'claimed' });
  }

  markWebhookProcessed(input: {
    readonly provider: string;
    readonly eventId: string;
    readonly status: 'processed' | 'ignored' | 'failed';
  }): Promise<void> {
    const row = this.events.get(`${input.provider} ${input.eventId}`);
    if (row !== undefined) {
      row.status = input.status;
    }
    return Promise.resolve();
  }

  listAttempts(orderId: string): Promise<readonly PaymentAttemptView[]> {
    return Promise.resolve([...(this.attempts.get(orderId) ?? [])].reverse());
  }

  /* ⚠️ 本文も署名も持たない。持つのは時刻だけ。 */
  findLastWebhookReceivedAt(): Promise<Date | null> {
    // 本物と同じく「届いたことがあるか」だけを表す。
    return Promise.resolve(this.events.size === 0 ? null : new Date(0));
  }

  listWebhookReceipts(): Promise<readonly WebhookReceiptRecord[]> {
    // ⚠️ 本文は保存していないので、そもそも返せるものが無い。
    return Promise.resolve(
      [...this.events.entries()].map(([key, value]) => ({
        eventType: key,
        status: value.status as WebhookReceiptRecord['status'],
        livemode: false,
        apiVersion: null,
        attemptCount: value.attemptCount,
        receivedAt: new Date(0),
        processedAt: null,
        lastErrorCode: null,
      })),
    );
  }

  recordCheckoutSession(command: RecordCheckoutSessionCommand): Promise<PaymentAttemptView> {
    const rows = this.attempts.get(command.orderId) ?? [];
    const existing = rows.find((row) => row.id === command.paymentId);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const attempt: PaymentAttemptView = {
      id: command.paymentId,
      provider: command.provider,
      status: 'pending',
      sessionRef: command.sessionRef,
      paymentRef: command.paymentRef,
      chargeRef: null,
      url: command.url,
      amount: command.amount,
      currency: command.currency,
      expiresAt: command.expiresAt,
      paidAt: null,
      failureCode: null,
      createdAt: command.now,
    };
    rows.push(attempt);
    this.attempts.set(command.orderId, rows);
    void this.orders.markCheckoutCreated(command.orderId, command.now);
    return Promise.resolve(attempt);
  }

  confirmPayment(command: ConfirmPaymentCommand): Promise<boolean> {
    const rows = this.attempts.get(command.orderId) ?? [];
    const target = [...rows]
      .reverse()
      .find(
        (row) =>
          row.status === 'pending' &&
          (command.sessionRef === null || row.sessionRef === command.sessionRef),
      );
    if (target === undefined) {
      // すでに確定済み。⚠️ 二重に進めない。
      return Promise.resolve(false);
    }
    const index = rows.indexOf(target);
    rows[index] = { ...target, status: 'succeeded', paidAt: command.paidAt };
    void this.orders.markPaid(command.orderId, command.paidAt);
    // ⚠️ 1 件だけ。再送で 2 件になっていないことを試験が見る。
    this.outbox.push({ orderId: command.orderId, eventId: command.outboxEventId });
    return Promise.resolve(true);
  }

  recordFailure(input: {
    readonly orderId: string;
    readonly sessionRef: string | null;
    readonly failureCode: string;
  }): Promise<void> {
    const rows = this.attempts.get(input.orderId) ?? [];
    const target = [...rows]
      .reverse()
      .find(
        (row) =>
          row.status === 'pending' &&
          (input.sessionRef === null || row.sessionRef === input.sessionRef),
      );
    if (target !== undefined) {
      rows[rows.indexOf(target)] = { ...target, status: 'failed', failureCode: input.failureCode };
    }
    // ⚠️ 注文は checkout_created のまま（決定 B）。決済の状態だけ戻す。
    void this.orders.markPaymentFailed(input.orderId);
    return Promise.resolve();
  }

  expireCheckout(input: { readonly orderId: string; readonly now: Date }): Promise<boolean> {
    const rows = this.attempts.get(input.orderId) ?? [];
    for (const [index, row] of rows.entries()) {
      if (row.status === 'pending') {
        rows[index] = { ...row, status: 'cancelled' };
      }
    }
    return this.orders.expireByCheckout(input.orderId, input.now);
  }
}

export interface TestHarness extends AppDependencies {
  readonly artworks: InMemoryArtworkRepository;
  readonly listings: InMemoryListingRepository;
  readonly accounts: InMemoryAccountRepository;
  readonly storage: InMemoryStorage;
  readonly audit: InMemoryAuditLog;
  readonly staffMembers: InMemoryStaffMemberRepository;
  readonly staffInvitations: InMemoryStaffInvitationRepository;
  readonly integrationRepository: InMemoryIntegrationRepository;
  readonly deliveries: InMemoryWalletDeliveries;
  /** 接続確認の結果を差し替える。 */
  readonly setProbe: (outcome: ProbeOutcome, durationMs?: number) => void;
  /** 配備環境から読める姿を差し替える。 */
  readonly setEnvironmentSummary: (
    service: IntegrationService,
    summary: EnvIntegrationSummary,
  ) => void;
  readonly auditLogReader: InMemoryAuditLogReader;
  readonly clock: FixedClock;
  readonly orderRepository: InMemoryOrderRepository;
  readonly commonUserLinks: InMemoryCommonUserLinks;
  readonly paymentRepository: InMemoryPaymentRepository;
  readonly legalRepository: InMemoryLegalDocuments;
}

export const TEST_TOKEN_SECRET = 'test-token-secret';
export const TEST_ISSUER = 'https://auth.test';
export const TEST_AUDIENCE = 'sennokunnft-test';
export const TEST_NOW = new Date('2026-06-01T00:00:00.000Z');
/** 内部ジョブの合言葉（テスト用）。⚠️ 実環境の値をここへ書かない。 */
export const TEST_INTERNAL_JOB_TOKEN = 'test-internal-job-token-0123456789abcdef';
/** 承認済みのプラットフォーム手数料率（20%）。 */
export const APPROVED_FEE_RATE_BPS = 2000;
/** 擬似決済の署名に使う秘密（テスト用）。⚠️ 実環境の値を書かない。 */
export const TEST_WEBHOOK_SECRET = 'test-payment-webhook-secret';

/**
 * 冪等キーの保管庫（テスト用）。
 *
 * 実装は DB の一意制約で占有を決める。ここでは Map だが、
 * **「占有できたのは 1 本だけ」という性質は同じにしてある。**
 * ここを「探して無ければ書く」にすると、テストだけが通って
 * 本番の競合を見逃す。
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<
    string,
    {
      requestDigest: string;
      state: IdempotencyState;
      statusCode: number | null;
      responseBody: unknown;
      expiresAt: Date;
    }
  >();

  private compositeKey(actorAccountId: string, key: string): string {
    return `${actorAccountId} ${key}`;
  }

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const id = this.compositeKey(input.actorAccountId, input.key);
    const existing = this.rows.get(id);

    // 期限切れは未使用として扱う。
    if (existing !== undefined && existing.expiresAt.getTime() <= input.now.getTime()) {
      this.rows.delete(id);
    }

    if (this.rows.has(id)) {
      const row = this.rows.get(id);
      return Promise.resolve({
        claimed: false,
        existing:
          row === undefined
            ? null
            : {
                requestDigest: row.requestDigest,
                state: row.state,
                statusCode: row.statusCode,
                responseBody: row.responseBody,
              },
      });
    }

    this.rows.set(id, {
      requestDigest: input.requestDigest,
      state: 'in_progress',
      statusCode: null,
      responseBody: null,
      expiresAt: input.expiresAt,
    });
    return Promise.resolve({ claimed: true, existing: null });
  }

  complete(input: {
    actorAccountId: string;
    key: string;
    statusCode: number;
    responseBody: unknown;
  }): Promise<void> {
    const id = this.compositeKey(input.actorAccountId, input.key);
    const row = this.rows.get(id);
    if (row !== undefined) {
      row.state = 'completed';
      row.statusCode = input.statusCode;
      row.responseBody = input.responseBody;
    }
    return Promise.resolve();
  }

  release(actorAccountId: string, key: string): Promise<void> {
    const id = this.compositeKey(actorAccountId, key);
    const row = this.rows.get(id);
    // 完了済みは消さない。正しい応答として残すべきもの。
    if (row !== undefined && row.state === 'in_progress') {
      this.rows.delete(id);
    }
    return Promise.resolve();
  }
}

export function buildHarness(tokenVerifier: TokenVerifierPort): TestHarness {
  const listings = new InMemoryListingRepository();
  const accounts = new InMemoryAccountRepository();
  const staffMembers = new InMemoryStaffMemberRepository(accounts);
  const integrationRepository = new InMemoryIntegrationRepository();
  const audit = new InMemoryAuditLog();
  /*
    接続確認の結果。⚠️ **本物の通信をしない。**
    外へ出る試験は、走らせる場所によって結果が変わる。
  */
  let probeResult: { outcome: ProbeOutcome; durationMs: number } = {
    outcome: { kind: 'response', statusCode: 405 },
    durationMs: 12,
  };
  /*
    配備環境から読める姿。⚠️ **値を持たない。**
    既定は「そろっている」。欠けを試す試験だけ `setEnvironmentSummary` で差し替える。
  */
  /*
    決済の配備側の状態。⚠️ 鍵そのものは入らない。
    既定は「テスト鍵が設定済み」。欠けを試す試験だけ差し替える。
  */
  const paymentDeployment = {
    secretKeyConfigured: true,
    webhookSecretConfigured: true,
    mode: 'test' as 'test' | 'live' | 'unknown',
    lastWebhookReceivedAt: null as Date | null,
  };

  const environmentSummaries: Record<IntegrationService, EnvIntegrationSummary> = {
    ovew_wallet: { provider: 'database', complete: false, missing: [], publicUrl: null },
    payment: { provider: 'database', complete: false, missing: [], publicUrl: null },
    storage: {
      provider: 'r2',
      complete: true,
      missing: [],
      publicUrl: 'https://images.example.com',
    },
    auth: {
      provider: 'supabase',
      complete: true,
      missing: [],
      publicUrl: 'https://auth.example.com/.well-known/jwks.json',
    },
  };
  const deliveries = new InMemoryWalletDeliveries();
  const auditLogReader = new InMemoryAuditLogReader(audit);
  const artworks = new InMemoryArtworkRepository(listings);
  const orderRepository = new InMemoryOrderRepository(artworks);
  const commonUserLinks = new InMemoryCommonUserLinks();
  const paymentRepository = new InMemoryPaymentRepository(orderRepository);
  const paymentGateway = new FakePaymentGateway(
    TEST_WEBHOOK_SECRET,
    'http://localhost:3000/fake-checkout',
    () => clock.now(),
  );
  const clock = new FixedClock(TEST_NOW);
  const legalRepository = new InMemoryLegalDocuments();
  return {
    version: '0.1.0',
    probes: [],
    artworks,
    listings,
    idempotency: new InMemoryIdempotencyStore(),
    accounts,
    staffMembers,
    staffInvitations: new InMemoryStaffInvitationRepository(staffMembers),
    integrations: {
      repository: integrationRepository,
      appEnvironment: 'production',
      // 既定は「届いた（405）」。試験ごとに `harness.probeOutcome` で差し替える。
      probe: () => Promise.resolve(probeResult),
      describeEnvironment: (service) => environmentSummaries[service],
      /*
        決済の配備側の状態。
        ⚠️ 本物と同じく、鍵そのものは持たない。持つのは有無とモードだけ。
      */
      describePaymentDeployment: async () => paymentDeployment,
    },
    setEnvironmentSummary: (service, summary) => {
      environmentSummaries[service] = summary;
    },
    setProbe: (outcome: ProbeOutcome, durationMs = 12) => {
      probeResult = { outcome, durationMs };
    },
    integrationRepository,
    tokenVerifier,
    clock,
    ids: new SequentialIds(),
    storage: new InMemoryStorage(),
    audit,
    walletDeliveries: { admin: deliveries, outbox: deliveries },
    deliveries,
    auditLogs: auditLogReader,
    auditLogReader,
    legalDocuments: legalRepository,
    legalRepository,
    orderRepository,
    commonUserLinks,
    paymentRepository,
    payments: {
      gateway: paymentGateway,
      repository: paymentRepository,
      provider: 'fake',
      // ⚠️ 試験は本番モードではない。livemode の食い違いを見る試験は
      //    この値を反転させて確かめる。
      expectLivemode: false,
      logger: silentLogger,
    },
    orders: {
      repository: orderRepository,
      commonUserLinks,
      random: new SequentialRandom(),
      // ✅ 承認済み 2026-08-19（UD-109）: 20% = 2000。
      // ⚠️ 0 は「無料」ではなく「販売設定未完了」。0 の挙動を見る試験は
      //    `buildHarness` の戻りを書き換えて確かめる。
      resolvePlatformFeeRateBps: async () => APPROVED_FEE_RATE_BPS,
      reservationMinutes: 30,
      internalJobToken: TEST_INTERNAL_JOB_TOKEN,
    },
    // テストでは決定論的なキーにする。実装は CSPRNG を使う。
    generateStorageKey: (prefix, extension) =>
      `${prefix}/test/${String(keyCounter++)}.${extension}`,
    hashContent: contentHash,
  };
}

let keyCounter = 1;

export function sampleArtwork(overrides: Partial<Artwork> = {}): Artwork {
  return {
    id: 'artwork-1',
    creatorAccountId: 'account-operator',
    slug: 'sample-artwork',
    title: 'サンプル作品',
    description: '説明文',
    imageKey: 'images/sample.png',
    imageContentType: 'image/png',
    imageByteSize: 2048,
    imageHash: `sha256:${'a'.repeat(64)}`,
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
