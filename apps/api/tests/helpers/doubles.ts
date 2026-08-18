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
} from '@sengoku/domain';
import { canManuallyResend } from '@sengoku/domain';
import { contentHash, InMemoryStorage } from '@sengoku/integrations';
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
      endpointUrl: null,
      keyId: null,
      apiVersion: null,
      timeoutMs: 10_000,
      maxAttempts: 5,
      enabled: false,
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
}

export const TEST_TOKEN_SECRET = 'test-token-secret';
export const TEST_ISSUER = 'https://auth.test';
export const TEST_AUDIENCE = 'sennokunnft-test';
export const TEST_NOW = new Date('2026-06-01T00:00:00.000Z');

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
  const environmentSummaries: Record<IntegrationService, EnvIntegrationSummary> = {
    ovew_wallet: { provider: 'database', complete: false, missing: [], publicUrl: null },
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
  return {
    version: '0.1.0',
    probes: [],
    artworks: new InMemoryArtworkRepository(listings),
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
    },
    setEnvironmentSummary: (service, summary) => {
      environmentSummaries[service] = summary;
    },
    setProbe: (outcome: ProbeOutcome, durationMs = 12) => {
      probeResult = { outcome, durationMs };
    },
    integrationRepository,
    tokenVerifier,
    clock: new FixedClock(TEST_NOW),
    ids: new SequentialIds(),
    storage: new InMemoryStorage(),
    audit,
    walletDeliveries: { admin: deliveries, outbox: deliveries },
    deliveries,
    auditLogs: auditLogReader,
    auditLogReader,
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
