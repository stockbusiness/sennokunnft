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
  OrderNoteEntry,
  OrderNoteRepository,
  OrderSearchCriteria,
  SettlementSettings,
  SettlementSettingsRepository,
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
  LegalConsentRepository,
  LegalConsentRecord,
  RecordConsentCommand,
  ConsentRequiredKind,
  TokushohoFields,
  PaymentCredentialRepository,
  PaymentCredentialGeneration,
  RegisterCredentialCommand,
  RecordCredentialCheckCommand,
  ActivateCredentialCommand,
  OpenedPaymentCredential,
  NotificationEnqueueInput,
  NotificationEnqueueOutcome,
  NotificationEventType,
  NotificationFailureInput,
  NotificationHistoryPage,
  NotificationHistoryPort,
  NotificationHistoryQuery,
  NotificationHistoryRecord,
  NotificationOutboxPort,
  NotificationRecord,
  NotificationTemplateRecord,
  NotificationTemplateRepository,
  NotificationTemplateStatus,
  ConsistencyCounts,
  EntitlementAdminDetailRecord,
  EntitlementAdminPort,
  EntitlementAdminRecord,
  JobHeartbeat,
  OperationsCounts,
  OperationsMetricsPort,
  // 顧客サポート（P1-1）。
  AccountNotePort,
  AccountNoteRecord,
  CustomerDirectoryPort,
  CustomerEntitlement,
  CustomerOrderRow,
  CustomerRefundRow,
  CustomerSummary,
  DuplicateCandidate,
  EmailChangeRequestPort,
  EmailChangeRequestRecord,
  IdentityVerificationMethod,
  // 作家さま運営（P1-2）。
  CreatorEarningsPort,
  CreatorLink,
  CreatorProfilePort,
  CreatorProfileRecord,
  PayoutLineDraft,
} from '@sengoku/domain';
import { DEFAULT_OPERATIONS_THRESHOLDS, NOTIFICATION_EVENT_TYPES } from '@sengoku/domain';
import {
  canManuallyResend,
  domainError,
  err,
  isIssuanceDue,
  ok,
  planIssuance,
  reconcileSupply,
  decideRevocation,
  refundStatusAfter,
  type MissingRevocation,
  type RevocationReconcileRepository,
  type WalletDeliveryEnqueueInput,
  type WalletDeliveryEnqueueOutcome,
  type WalletDeliveryEventType,
  type WalletDeliveryOutboxPort,
  type WalletDeliveryRecord,
  type OpenOperationsReviewCommand,
  type OperationsReviewOpenCounts,
  type OperationsReviewPage,
  type OperationsReviewQuery,
  type OperationsReviewRecord,
  type OperationsReviewRepository,
  revocableEntitlementStatuses,
  reserveSupply,
  scheduleIssuanceRetry,
  PAYMENT_API_ENDPOINT,
  TOKUSHOHO_FIELD_KEYS,
  // 本番販売ガード（P0-7）。
  DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
  type AttestationFact,
  type AttestationKind,
  type AttestationPort,
  type AttestationRecord,
  type MailAttemptOutcome,
  type ProductionReadinessFacts,
  type ProductionReadinessPort,
  type RecordAttestationCommand,
} from '@sengoku/domain';
import type {
  CollectibleListPage,
  CollectibleRepository,
  CollectibleView,
  EntitlementIssuanceRepository,
  IssuanceCandidate,
  IssuanceOutcome,
  IssuanceRetry,
  SupplyCounters,
  SupplyReconciliation,
} from '@sengoku/domain';
import type {
  CreatorProfile,
  CreatorProfileRepository,
  EntitlementStatus,
  MintJobStatus,
  PayoutCandidate,
  PayoutClawback,
  PayoutLineView,
  PayoutRepository,
  PayoutStatus,
  PayoutView,
  SavePayoutDraftCommand,
  RefundContext,
  RefundRecordView,
  RefundRepository,
  RefundSettlement,
  SettleRefundCommand,
  StartRefundCommand,
  ValidatedDisplayName,
} from '@sengoku/domain';
import {
  contentHash,
  FakePaymentGateway,
  HmacEmailHasher,
  InMemoryStorage,
} from '@sengoku/integrations';

/**
 * 試験で使う照合用の鍵。
 *
 * ⚠️ **本物の鍵をここへ書かない。** これは試験のためだけの値で、
 * 配備で使う鍵は Secret から来る（`EMAIL_LOOKUP_PEPPER`）。
 */
export const TEST_EMAIL_PEPPER = 'test-email-lookup-pepper-0123456789abcdef';
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
import { createRefundWindowResolver } from '../../src/settlement/refund-window';

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
    options: {
      status?: AccountRecord['status'];
      isOwner?: boolean;
      emailHash?: string | null;
      lastAal2At?: Date | null;
    } = {},
  ): AccountRecord {
    const record: AccountRecord = {
      id: `account-${subject}`,
      authProvider: 'dev',
      authSubject: subject,
      role,
      status: options.status ?? 'active',
      isOwner: options.isOwner ?? false,
      emailHash: options.emailHash ?? null,
      // ⚠️ 既定は「記録が無い」。既定で満たされる状態を作らない（P0-7）。
      lastAal2At: options.lastAal2At ?? null,
    };
    this.items.set(`dev:${subject}`, record);
    return record;
  }

  findByAuthSubject(provider: string, subject: string): Promise<AccountRecord | null> {
    return Promise.resolve(this.items.get(`${provider}:${subject}`) ?? null);
  }

  /** 初回アクセスで作られるロールは常に buyer。 */
  provision(provider: string, subject: string, emailHash: string | null): Promise<AccountRecord> {
    const record: AccountRecord = {
      id: `account-${subject}`,
      authProvider: provider,
      authSubject: subject,
      role: 'buyer',
      status: 'active',
      isOwner: false,
      emailHash,
      lastAal2At: null,
    };
    this.items.set(`${provider}:${subject}`, record);
    return Promise.resolve(record);
  }

  /** ⚠️ `null` では消さない（本番実装と同じ向き）。 */
  rememberEmailHash(accountId: string, emailHash: string | null): Promise<void> {
    if (emailHash === null) {
      return Promise.resolve();
    }
    for (const [key, record] of this.items) {
      if (record.id === accountId) {
        this.items.set(key, { ...record, emailHash });
      }
    }
    return Promise.resolve();
  }

  /**
   * 二要素で入ったことを覚える（P0-7）。
   *
   * ⚠️ **時刻を巻き戻さない**（本番実装と同じ向き）。
   */
  rememberMfa(accountId: string, at: Date): Promise<void> {
    for (const [key, record] of this.items) {
      const current = record.lastAal2At ?? null;
      if (record.id === accountId && (current === null || current < at)) {
        this.items.set(key, { ...record, lastAal2At: at });
      }
    }
    return Promise.resolve();
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

  /** 試験から業務用アドレスを置く（P0-7 の試し送りで使う）。 */
  setStaffEmail(accountId: string, email: string): void {
    this.emails.set(accountId, email);
  }

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
    const counts = {
      PENDING: 0,
      PROCESSING: 0,
      DELIVERED: 0,
      FAILED: 0,
      DEAD: 0,
      SUPERSEDED: 0,
    };
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
 * 配送待ち行列（試験用・全部の口）。
 *
 * ⚠️ **本物と同じところで冪等にする。** `enqueueIdempotent` を素通しに
 * すると、重複した Webhook で取消が 2 通送られる不具合を試験が見逃す。
 */
export class InMemoryWalletDeliveryOutbox implements WalletDeliveryOutboxPort {
  readonly rows = new Map<string, WalletDeliveryRecord & { grantedStatus?: string }>();

  /** 付与イベントを積んだことにする（＝相手が知っている状態）。 */
  seedGranted(entitlementId: string, commonUserId: string | null, correlationId: string): void {
    const payload = JSON.stringify({
      event_type: 'entitlement.granted',
      ...(commonUserId === null ? {} : { common_user_id: commonUserId }),
    });
    const eventId = `evt_granted_${entitlementId}`;
    this.rows.set(eventId, {
      id: eventId,
      eventId,
      eventType: 'entitlement.granted',
      entitlementId,
      targetSiteKey: 'ovew-wallet',
      payload,
      payloadHash: `sha256:${'0'.repeat(64)}`,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 5,
      correlationId,
    });
  }

  enqueue(input: WalletDeliveryEnqueueInput): Promise<WalletDeliveryRecord> {
    const record: WalletDeliveryRecord = {
      id: input.eventId,
      eventId: input.eventId,
      eventType: input.eventType,
      entitlementId: input.entitlementId,
      targetSiteKey: input.targetSiteKey,
      payload: input.payload,
      payloadHash: input.payloadHash,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 5,
      correlationId: input.correlationId,
    };
    this.rows.set(input.eventId, record);
    return Promise.resolve(record);
  }

  enqueueIdempotent(input: WalletDeliveryEnqueueInput): Promise<WalletDeliveryEnqueueOutcome> {
    const existing = this.rows.get(input.eventId);
    if (existing === undefined) {
      return this.enqueue(input).then((record) => ({ kind: 'created' as const, record }));
    }
    if (existing.payloadHash === input.payloadHash) {
      return Promise.resolve({ kind: 'duplicate', record: existing });
    }
    return Promise.resolve({
      kind: 'payload_conflict',
      eventId: input.eventId,
      expectedPayloadHash: input.payloadHash,
      actualPayloadHash: existing.payloadHash,
    });
  }

  supersedePendingGranted(input: { entitlementId: string; now: Date }): Promise<number> {
    let count = 0;
    for (const [key, row] of this.rows) {
      if (row.entitlementId !== input.entitlementId) continue;
      if (row.eventType !== 'entitlement.granted') continue;
      // ⚠️ PROCESSING と DELIVERED は触らない（届いたか分からない／もう届いた）。
      if (row.status !== 'PENDING' && row.status !== 'FAILED' && row.status !== 'DEAD') continue;
      this.rows.set(key, { ...row, status: 'SUPERSEDED' });
      count += 1;
    }
    return Promise.resolve(count);
  }

  claimBatch(input: {
    limit: number;
    now: Date;
    eventTypes: readonly WalletDeliveryEventType[];
  }): Promise<WalletDeliveryRecord[]> {
    const claimed: WalletDeliveryRecord[] = [];
    for (const row of this.rows.values()) {
      if (claimed.length >= input.limit) break;
      if (row.status !== 'PENDING') continue;
      if (!input.eventTypes.includes(row.eventType)) continue;
      claimed.push(row);
    }
    return Promise.resolve(claimed);
  }

  markDelivered(): Promise<boolean> {
    return Promise.resolve(true);
  }

  recordFailure(): Promise<boolean> {
    return Promise.resolve(true);
  }

  requeue(): Promise<boolean> {
    return Promise.resolve(false);
  }

  reclaimStale(): Promise<number> {
    return Promise.resolve(0);
  }

  findByEventId(eventId: string): Promise<WalletDeliveryRecord | null> {
    return Promise.resolve(this.rows.get(eventId) ?? null);
  }
}

/**
 * 取消の取りこぼしの読み取り（試験用）。
 *
 * ⚠️ **試験から並べたものをそのまま返す。** 本物の SQL は結合テストの側で
 * 確かめる。ここで確かめたいのは「補完がフラグに従うか」「冪等か」。
 */
export class InMemoryRevocationReconcile implements RevocationReconcileRepository {
  public missing: MissingRevocation[] = [];

  listMissing(limit: number): Promise<readonly MissingRevocation[]> {
    return Promise.resolve(this.missing.slice(0, limit));
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

  /**
   * その種類の版をすべて取り除く。
   *
   * ⚠️ **本物には無い操作。** 法務文書は消さない。ここにあるのは、
   * 「まだ公開していない状態」を試験で作るためだけ。
   */
  removeAll(kind: LegalDocumentKind): void {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]?.kind === kind) {
        this.rows.splice(i, 1);
      }
    }
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
      requiresReconsent: false,
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
      requiresReconsent: command.requiresReconsent,
    };
    this.rows[index] = next;
    return Promise.resolve(next);
  }
}

/**
 * 規約への同意（試験用）。
 *
 * ⚠️ **本物と同じく、二度押しで増やさない。** `(accountId, versionId)` の
 * 一意制約に相当する振る舞いをここでも守る。緩めると、本物の upsert を
 * 素の create に変えても試験が通ってしまう。
 */
export class InMemoryLegalConsents implements LegalConsentRepository {
  private readonly rows: LegalConsentRecord[] = [];

  constructor(private readonly documents: InMemoryLegalDocuments) {}

  findLatestConsent(
    accountId: string,
    kind: ConsentRequiredKind,
  ): Promise<LegalConsentRecord | null> {
    const mine = this.rows
      .filter((row) => row.accountId === accountId && row.kind === kind)
      .sort((a, b) => b.version - a.version);
    return Promise.resolve(mine[0] ?? null);
  }

  async hasPendingReconsent(
    kind: ConsentRequiredKind,
    consentedVersion: number,
    now: Date,
  ): Promise<boolean> {
    const versions = await this.documents.listVersions(kind);
    return versions.some(
      (version) =>
        version.status === 'published' &&
        version.requiresReconsent &&
        version.version > consentedVersion &&
        version.effectiveFrom !== null &&
        version.effectiveFrom.getTime() <= now.getTime(),
    );
  }

  recordConsent(command: RecordConsentCommand): Promise<LegalConsentRecord> {
    const existing = this.rows.find(
      (row) => row.accountId === command.accountId && row.versionId === command.versionId,
    );
    if (existing !== undefined) {
      // ⚠️ 日時は最初の 1 回を残す。上書きすると「いつ同意したか」が動く。
      return Promise.resolve(existing);
    }
    const row: LegalConsentRecord = {
      accountId: command.accountId,
      kind: command.kind,
      versionId: command.versionId,
      version: command.version,
      consentedAt: command.consentedAt,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
}

/**
 * 決済資格情報の世代（試験用）。
 *
 * ⚠️ **本物と同じく「受付は 1 世代」を守る。** 緩めると、本物の
 * 部分UNIQUE を外しても試験が通ってしまう。
 */
export class InMemoryPaymentCredentials implements PaymentCredentialRepository {
  private readonly rows: PaymentCredentialGeneration[] = [];
  private readonly secrets = new Map<string, { secretKey: string; webhookSecret: string }>();
  private counter = 1;

  list(
    provider: string,
    environment: IntegrationEnvironment,
  ): Promise<readonly PaymentCredentialGeneration[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.provider === provider && row.environment === environment)
        .sort((a, b) => b.generation - a.generation),
    );
  }

  findById(id: string): Promise<PaymentCredentialGeneration | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  register(command: RegisterCredentialCommand): Promise<PaymentCredentialGeneration> {
    const latest = this.rows
      .filter((row) => row.provider === command.provider && row.environment === command.environment)
      .reduce((max, row) => Math.max(max, row.generation), 0);
    const row: PaymentCredentialGeneration = {
      id: `cred-${String(this.counter++)}`,
      provider: command.provider,
      environment: command.environment,
      generation: latest + 1,
      status: 'pending',
      accountRef: null,
      label: command.label,
      apiVersion: command.apiVersion,
      lastCheckSucceeded: null,
      lastCheckAt: null,
      lastWebhookReceivedAt: null,
      acceptsNewPayments: false,
      activatedAt: null,
      retiredAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    this.rows.push(row);
    // ⚠️ 封の中身は試験でも持ち回らない。開ける口だけが知っている。
    this.secrets.set(row.id, {
      secretKey: `plain:${command.secretKey.ciphertext}`,
      webhookSecret: `plain:${command.webhookSecret.ciphertext}`,
    });
    return Promise.resolve(row);
  }

  recordCheck(command: RecordCredentialCheckCommand): Promise<PaymentCredentialGeneration | null> {
    const index = this.rows.findIndex((row) => row.id === command.id);
    if (index === -1) {
      return Promise.resolve(null);
    }
    const current = this.rows[index] as PaymentCredentialGeneration;
    const next: PaymentCredentialGeneration = {
      ...current,
      lastCheckSucceeded: command.succeeded,
      lastCheckAt: command.checkedAt,
      accountRef: command.accountRef ?? current.accountRef,
    };
    this.rows[index] = next;
    return Promise.resolve(next);
  }

  activate(command: ActivateCredentialCommand): Promise<PaymentCredentialGeneration | null> {
    const index = this.rows.findIndex((row) => row.id === command.id);
    if (index === -1) {
      return Promise.resolve(null);
    }
    const target = this.rows[index] as PaymentCredentialGeneration;
    // ⚠️ 接続確認を通っていなければ、本物と同じく書かない。
    if (target.lastCheckSucceeded !== true) {
      return Promise.resolve(null);
    }
    if (command.steppedDownId !== null) {
      const oldIndex = this.rows.findIndex((row) => row.id === command.steppedDownId);
      if (oldIndex === -1) {
        return Promise.resolve(null);
      }
      const old = this.rows[oldIndex] as PaymentCredentialGeneration;
      this.rows[oldIndex] = { ...old, acceptsNewPayments: false };
    }
    const next: PaymentCredentialGeneration = {
      ...target,
      status: 'active',
      acceptsNewPayments: true,
      activatedAt: command.activatedAt,
    };
    this.rows[index] = next;
    return Promise.resolve(next);
  }

  setAcceptsNewPayments(id: string, accepts: boolean): Promise<PaymentCredentialGeneration | null> {
    const index = this.rows.findIndex((row) => row.id === id && row.status === 'active');
    if (index === -1) {
      return Promise.resolve(null);
    }
    const current = this.rows[index] as PaymentCredentialGeneration;
    if (accepts && this.rows.some((row) => row.acceptsNewPayments && row.id !== id)) {
      // ⚠️ 受付は 1 世代。本物は部分UNIQUE が弾く。
      return Promise.resolve(null);
    }
    const next = { ...current, acceptsNewPayments: accepts };
    this.rows[index] = next;
    return Promise.resolve(next);
  }

  retire(id: string, retiredAt: Date): Promise<PaymentCredentialGeneration | null> {
    const index = this.rows.findIndex((row) => row.id === id && !row.acceptsNewPayments);
    if (index === -1) {
      return Promise.resolve(null);
    }
    const current = this.rows[index] as PaymentCredentialGeneration;
    const next: PaymentCredentialGeneration = { ...current, status: 'retired', retiredAt };
    this.rows[index] = next;
    return Promise.resolve(next);
  }

  touchWebhookReceived(id: string, receivedAt: Date): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index !== -1) {
      const current = this.rows[index] as PaymentCredentialGeneration;
      this.rows[index] = { ...current, lastWebhookReceivedAt: receivedAt };
    }
    return Promise.resolve();
  }

  open(id: string): Promise<OpenedPaymentCredential | null> {
    const row = this.rows.find((item) => item.id === id);
    const secret = this.secrets.get(id);
    if (row === undefined || secret === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      id: row.id,
      generation: row.generation,
      secretKey: secret.secretKey,
      webhookSecret: secret.webhookSecret,
      apiVersion: row.apiVersion,
    });
  }

  async openForVerification(
    provider: string,
    environment: IntegrationEnvironment,
    limit: number,
  ): Promise<readonly OpenedPaymentCredential[]> {
    const rows = await this.list(provider, environment);
    const opened: OpenedPaymentCredential[] = [];
    for (const row of rows.slice(0, limit)) {
      const one = await this.open(row.id);
      if (one !== null) {
        opened.push(one);
      }
    }
    return opened;
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
/**
 * 対応メモの代替実装（`UD-121`）。
 *
 * ⚠️ 本番実装と同じく、更新と削除のメソッドを持たない。
 * 試験の都合で足すと、そのうち本番にも生える。
 */
/**
 * 返金・精算の設定の代替（`UD-104` / `UD-119`）。
 *
 * ⚠️ **既定は「決定した値」で入れてある。** 未設定を既定にすると、
 * 返金の期限が付かない状態がすべての試験の前提になってしまい、
 * 期限まわりの検査が素通りする。未設定の挙動は `clear()` で作る。
 */
export class InMemorySettlementSettings implements SettlementSettingsRepository {
  private current: SettlementSettings | null = {
    refundWindowDays: 14,
    payoutOffsetMonths: 1,
    minimumPayoutAmount: 1000,
    transferFeeBearer: 'creator',
  };

  find(): Promise<SettlementSettings | null> {
    return Promise.resolve(this.current);
  }

  save(
    _environment: IntegrationEnvironment,
    settings: SettlementSettings,
  ): Promise<SettlementSettings> {
    this.current = settings;
    return Promise.resolve(settings);
  }

  /** 未設定の配備を作る。⚠️ 既定にしない（上の注記）。 */
  clear(): void {
    this.current = null;
  }
}

/**
 * 返金の記録（`UD-104` / `UD-120`）。
 *
 * ⚠️ **本物と同じところで断る。** 「代替実装だから通す」を作ると、
 * 手元では通るのに本番で落ちる経路ができる。二重反映の防止（条件付きの
 * 成立）と、`processing` を取り消さないことは、ここでも同じに保つ。
 */
export class InMemoryRefunds implements RefundRepository {
  private readonly rows: RefundRecordView[] = [];
  /** 決済ごとの返金累計。⚠️ 事業者と同じく累計で持つ。 */
  private readonly refundedByOrder = new Map<string, number>();

  constructor(
    private readonly orders: InMemoryOrderRepository,
    /** 受取権と発行ジョブの「いまの姿」。⚠️ 試験ごとに差し替える。 */
    public entitlementStatus: EntitlementStatus | null = null,
    public mintStatus: MintJobStatus | null = null,
    /** 決済の世代と識別子。⚠️ `null` は「世代を通していない決済」。 */
    public credentialId: string | null = 'cred-1',
  ) {}

  /**
   * 相手が知っている受取権（付与イベントを送った／送る予定のもの）。
   *
   * ⚠️ **「配送済みか」ではなく「行があるか」で持つ。** 本物の判定と
   * そろえておかないと、試験だけが通る経路ができる。
   */
  public grantedEntitlements = new Map<
    string,
    { readonly commonUserId: string | null; readonly correlationId: string }
  >();

  /** 取り消す対象の受取権。⚠️ 状態は `entitlementStatus` と別に持つ。 */
  public revocableEntitlements: {
    readonly id: string;
    readonly status: EntitlementStatus;
    readonly orderLineId: string;
    readonly artworkId: string;
    readonly claimedCommonUserId: string | null;
  }[] = [];

  /** 積んだ取消イベント。⚠️ `eventId` をキーにして冪等を再現する。 */
  public readonly revocationEvents = new Map<string, string>();

  /** 送らないことにした付与イベントの受取権。 */
  public readonly superseded = new Set<string>();

  /**
   * 事業者側の決済識別子を差し替える。
   *
   * ⚠️ **`null` にすると、擬似ゲートウェイが本物と同じ所で断る。**
   * 「送れなかったときに記録がどう残るか」を確かめるために要る。
   * `undefined` は既定（注文IDから導く）。
   */
  paymentRefOverride: string | null | undefined = undefined;

  /** 試験から返金の記録を覗く。 */
  get all(): readonly RefundRecordView[] {
    return this.rows;
  }

  listByOrder(orderId: string): Promise<readonly RefundRecordView[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.orderId === orderId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  async loadContext(orderId: string): Promise<RefundContext | null> {
    const order = await this.orders.findById(orderId);
    if (order === null) {
      return null;
    }
    const paid = order.paymentStatus === 'succeeded';
    return {
      orderId,
      // ⚠️ 知らせの宛先の本人と注文番号（P0-4）。判定には使わない。
      accountId: order.accountId,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      currency: order.currency,
      // ⚠️ 焼き付けた値をそのまま返す。設定から計算し直さない。
      refundableUntil: this.orders.refundableUntil.get(orderId) ?? null,
      paymentStatus: order.paymentStatus,
      refundStatus: order.refundStatus,
      amountRefunded: this.refundedByOrder.get(orderId) ?? 0,
      /*
        ⚠️ **成功した決済があるかで見る。** `OrderView.hasPayment` は
           代替実装では常に `false`（決済行を持たないため）なので、
           そちらを見ると本物と違う経路を試験することになる。
      */
      paymentId: paid ? `payment-${orderId}` : null,
      credentialId: this.credentialId,
      paymentRef:
        this.paymentRefOverride === undefined
          ? paid
            ? `pi_${orderId}`
            : null
          : this.paymentRefOverride,
      chargeRef: null,
      entitlementStatus: this.entitlementStatus,
      mintStatus: this.mintStatus,
    };
  }

  start(command: StartRefundCommand): Promise<RefundRecordView> {
    const row: RefundRecordView = {
      id: command.refundId,
      orderId: command.orderId,
      amount: command.amount,
      currency: command.currency,
      reason: command.reason,
      status: 'requested',
      initiatedBy: command.initiatedBy,
      actorAccountId: command.actorAccountId,
      providerRefundRef: command.providerRefundRef,
      note: command.note,
      failureCode: null,
      createdAt: command.now,
      settledAt: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  async settle(command: SettleRefundCommand): Promise<RefundSettlement> {
    const index = this.rows.findIndex((row) => row.id === command.refundId);
    const row = index === -1 ? undefined : this.rows[index];
    const order = await this.orders.findById(command.orderId);

    // ⚠️ すでに成立していたら何もしない。二重反映しない。
    if (row === undefined || row.status !== 'requested') {
      return {
        alreadySettled: true,
        refundStatus: order?.refundStatus ?? 'none',
        amountRefunded: command.amountRefundedTotal,
        revokedEntitlements: 0,
        cancelledMintJobs: 0,
        annotatedMintJobs: 0,
        restoredSupply: 0,
        revocationEventsCreated: 0,
        revocationEventsDuplicate: 0,
        supersededGrantedEvents: 0,
        revocationsNeedingReview: [],
        revocationPayloadConflicts: [],
      };
    }

    this.rows[index] = {
      ...row,
      status: 'succeeded',
      providerRefundRef: command.providerRefundRef ?? row.providerRefundRef,
      settledAt: command.now,
    };
    this.refundedByOrder.set(command.orderId, command.amountRefundedTotal);

    const refundStatus = refundStatusAfter(command.amountRefundedTotal, order?.totalAmount ?? 0);
    this.orders.setRefundStatus(command.orderId, refundStatus);

    let revokedEntitlements = 0;
    const revocableStatuses = revocableEntitlementStatuses(command.revokeClaimedEntitlements);
    if (command.revokeEntitlement && this.entitlementStatus !== null) {
      if (revocableStatuses.includes(this.entitlementStatus)) {
        this.entitlementStatus = 'revoked';
        revokedEntitlements = 1;
      }
    }

    /*
      取消の知らせ（M3a）。
      ⚠️ **本物と同じ判定にする。** 「代替実装だから素通し」を作ると、
         手元では通るのに本番で落ちる経路ができる。判定はドメインの
         `decideRevocation` をそのまま呼び、冪等も `eventId` で再現する。
    */
    let revocationEventsCreated = 0;
    let revocationEventsDuplicate = 0;
    let supersededGrantedEvents = 0;
    const revocationsNeedingReview: { entitlementId: string; reason: 'recipient_unresolved' }[] =
      [];
    const revocationPayloadConflicts: {
      entitlementId: string;
      eventId: string;
      expectedPayloadHash: string;
      actualPayloadHash: string;
    }[] = [];

    if (command.revokeEntitlement && command.planRevocation !== null) {
      for (const target of this.revocableEntitlements) {
        if (!revocableStatuses.includes(target.status)) {
          continue;
        }
        const granted = this.grantedEntitlements.get(target.id);
        const decision = decideRevocation({
          entitlementId: target.id,
          orderId: command.orderId,
          hasGrantedEvent: granted !== undefined,
          grantedCommonUserId: granted?.commonUserId ?? null,
          claimedCommonUserId: target.claimedCommonUserId,
          grantedCorrelationId: granted?.correlationId ?? null,
        });
        if (decision.kind === 'revoke_only') {
          continue;
        }
        if (decision.kind === 'needs_review') {
          revocationsNeedingReview.push({ entitlementId: target.id, reason: decision.reason });
          continue;
        }
        const built = command.planRevocation({
          entitlementId: target.id,
          orderId: command.orderId,
          orderLineId: target.orderLineId,
          artworkId: target.artworkId,
          eventId: decision.eventId,
          commonUserId: decision.commonUserId,
          correlationId: decision.correlationId,
          // ⚠️ 現在時刻ではなく、返金が成立した時刻。
          occurredAt: command.now,
        });
        const existing = this.revocationEvents.get(built.eventId);
        if (existing === undefined) {
          this.revocationEvents.set(built.eventId, built.payloadHash);
          revocationEventsCreated += 1;
        } else if (existing === built.payloadHash) {
          revocationEventsDuplicate += 1;
        } else {
          revocationPayloadConflicts.push({
            entitlementId: target.id,
            eventId: built.eventId,
            expectedPayloadHash: built.payloadHash,
            actualPayloadHash: existing,
          });
        }
        if (!this.superseded.has(target.id)) {
          this.superseded.add(target.id);
          supersededGrantedEvents += 1;
        }
      }
    }

    let cancelledMintJobs = 0;
    if (command.cancelMintJob && this.mintStatus === 'queued') {
      this.mintStatus = 'cancelled';
      cancelledMintJobs = 1;
    }

    /*
      ⚠️ **`processing` を `cancelled` にしない**（`INV-M4`）。注記だけ。
         ここを簡略化すると、いちばん確かめたい不変条件が試験から消える。
    */
    const annotatedMintJobs = command.mintNote !== null && this.mintStatus === 'processing' ? 1 : 0;

    return {
      alreadySettled: false,
      refundStatus,
      amountRefunded: command.amountRefundedTotal,
      revokedEntitlements,
      cancelledMintJobs,
      annotatedMintJobs,
      restoredSupply: revokedEntitlements,
      revocationEventsCreated,
      revocationEventsDuplicate,
      supersededGrantedEvents,
      revocationsNeedingReview,
      revocationPayloadConflicts,
    };
  }

  fail(input: { readonly refundId: string; readonly failureCode: string }): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === input.refundId);
    const row = index === -1 ? undefined : this.rows[index];
    // ⚠️ 行は消さない。「試したが駄目だった」ことを残す。
    if (row !== undefined && row.status === 'requested') {
      this.rows[index] = { ...row, status: 'failed', failureCode: input.failureCode };
    }
    return Promise.resolve();
  }

  findByProviderRef(providerRefundRef: string): Promise<RefundRecordView | null> {
    return Promise.resolve(
      this.rows.find((row) => row.providerRefundRef === providerRefundRef) ?? null,
    );
  }
}

/**
 * 運用確認キュー（M3a）。
 *
 * ⚠️ **本物と同じところで冪等にする。** 同じ対象・同じ理由は 1 行に
 * まとめる。ここを素通しにすると、重複した Webhook で確認事項が増える
 * という不具合を、試験が見逃す。
 */
export class InMemoryOperationsReviews implements OperationsReviewRepository {
  private readonly rows: (OperationsReviewRecord & { key: string })[] = [];

  /** 試験から積まれた確認事項を覗く。 */
  get all(): readonly OperationsReviewRecord[] {
    return this.rows;
  }

  open(command: OpenOperationsReviewCommand): Promise<boolean> {
    const key = `${command.subjectType}/${command.subjectId}/${command.reasonCode}`;
    if (this.rows.some((row) => row.key === key)) {
      // ⚠️ 上書きしない。最初に気づいた時刻と理由を残す。
      return Promise.resolve(false);
    }
    this.rows.push({
      key,
      id: `review-${String(this.rows.length + 1)}`,
      subjectType: command.subjectType,
      subjectId: command.subjectId,
      orderId: command.orderId,
      reasonCode: command.reasonCode,
      detail: command.detail,
      status: 'open',
      resolvedByAccountId: null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: command.now,
      updatedAt: command.now,
    });
    return Promise.resolve(true);
  }

  list(query: OperationsReviewQuery): Promise<OperationsReviewPage> {
    let items: readonly OperationsReviewRecord[] = this.rows;
    if (query.statuses.length > 0) {
      items = items.filter((row) => query.statuses.includes(row.status));
    }
    if (query.reasonCodes.length > 0) {
      items = items.filter((row) => query.reasonCodes.includes(row.reasonCode));
    }
    return Promise.resolve({ items: items.slice(0, query.limit), nextCursor: null });
  }

  countOpen(): Promise<OperationsReviewOpenCounts> {
    const counts = {
      partial_refund_entitlement_unresolved: 0,
      wallet_revocation_recipient_unresolved: 0,
      wallet_revocation_payload_conflict: 0,
    };
    for (const row of this.rows) {
      if (row.status === 'open') {
        counts[row.reasonCode] += 1;
      }
    }
    return Promise.resolve(counts);
  }

  resolve(input: {
    readonly id: string;
    readonly actorAccountId: string;
    readonly note: string | null;
    readonly now: Date;
  }): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === input.id);
    const row = index === -1 ? undefined : this.rows[index];
    // ⚠️ 条件付き。すでに対応済みの行を上書きさせない。
    if (row === undefined || row.status !== 'open') {
      return Promise.resolve(false);
    }
    this.rows[index] = {
      ...row,
      status: 'resolved',
      resolvedByAccountId: input.actorAccountId,
      resolvedAt: input.now,
      resolutionNote: input.note,
      updatedAt: input.now,
    };
    return Promise.resolve(true);
  }
}

/**
 * 精算（`UD-119`）。
 *
 * ⚠️ **本物と同じところで断る。** 「代替実装だから通す」を作ると、手元では
 * 通るのに本番で落ちる経路ができる。1 作家さま × 1 期間 = 1 行、確定済みは
 * 置き換えない、二重払いをしない——この 3 つはここでも同じに保つ。
 */
/**
 * 作家さまの表示名（決定 2026-08-20）。
 *
 * ⚠️ **重複は本物と同じところで断る。** 「代替実装だから通す」を作ると、
 * 手元では通るのに本番で落ちる経路ができる。**鍵の一致**で見る——生の
 * 文字列で見ると、見た目が同じ名前を通してしまう。
 */
export class InMemoryCreatorProfiles implements CreatorProfileRepository {
  private readonly names = new Map<string, { value: string; key: string }>();

  find(accountId: string): Promise<CreatorProfile | null> {
    const row = this.names.get(accountId);
    return Promise.resolve({ accountId, displayName: row?.value ?? null });
  }

  saveDisplayName(
    accountId: string,
    name: ValidatedDisplayName,
  ): Promise<Result<CreatorProfile, DomainError>> {
    for (const [otherId, row] of this.names) {
      if (otherId !== accountId && row.key === name.key) {
        return Promise.resolve(err(domainError('DISPLAY_NAME_TAKEN', 'already taken')));
      }
    }
    this.names.set(accountId, { value: name.value, key: name.key });
    return Promise.resolve(ok({ accountId, displayName: name.value }));
  }
}

export class InMemoryPayouts implements PayoutRepository {
  private readonly payouts = new Map<string, PayoutView>();
  private readonly lines = new Map<string, PayoutLineView[]>();

  /**
   * 精算の対象になる注文。
   *
   * ⚠️ **試験ごとに差し替える。** 注文の代替実装は作家さまごとの集計を
   * 持たないので、ここへ直接置く。
   */
  candidates: PayoutCandidate[] = [];
  clawbacks: PayoutClawback[] = [];

  list(query: {
    readonly limit: number;
    readonly periodKey?: string | undefined;
    readonly creatorAccountId?: string | undefined;
    readonly status?: PayoutStatus | undefined;
  }): Promise<readonly PayoutView[]> {
    return Promise.resolve(
      [...this.payouts.values()]
        .filter(
          (row) =>
            (query.periodKey === undefined || row.periodKey === query.periodKey) &&
            (query.creatorAccountId === undefined ||
              row.creatorAccountId === query.creatorAccountId) &&
            (query.status === undefined || row.status === query.status),
        )
        .sort((a, b) => b.periodKey.localeCompare(a.periodKey))
        .slice(0, query.limit),
    );
  }

  findById(payoutId: string): Promise<PayoutView | null> {
    return Promise.resolve(this.payouts.get(payoutId) ?? null);
  }

  findByPeriod(creatorAccountId: string, periodKey: string): Promise<PayoutView | null> {
    return Promise.resolve(
      [...this.payouts.values()].find(
        (row) => row.creatorAccountId === creatorAccountId && row.periodKey === periodKey,
      ) ?? null,
    );
  }

  listLines(payoutId: string): Promise<readonly PayoutLineView[]> {
    return Promise.resolve(this.lines.get(payoutId) ?? []);
  }

  listCandidates(input: {
    readonly creatorAccountId: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
  }): Promise<readonly PayoutCandidate[]> {
    return Promise.resolve(
      this.candidates.filter(
        (row) =>
          row.creatorAccountId === input.creatorAccountId &&
          row.paidAt.getTime() >= input.periodStart.getTime() &&
          // ⚠️ 半開区間。終了の瞬間は次の期間のもの。
          row.paidAt.getTime() < input.periodEnd.getTime() &&
          // ⚠️ すでにどこかの精算に載っている注文は入れない。
          !this.alreadyPaidOut(row.orderId),
      ),
    );
  }

  listClawbacks(creatorAccountId: string): Promise<readonly PayoutClawback[]> {
    /*
      ⚠️ **一度差し引いた注文を二度引かない。** 二度引くと、作家さまから
         取りすぎる。本物は差し戻しの行の有無で見る。ここでも同じにする。
    */
    void creatorAccountId;
    return Promise.resolve(this.clawbacks.filter((row) => !this.alreadyClawedBack(row.orderId)));
  }

  countOpenRefundWindows(payoutId: string, now: Date): Promise<number> {
    /*
      ⚠️ **この精算の明細そのものから数える。** 候補の絞り込みで数えると、
         下書きを保存した直後は 0 件になる（もうこの精算に載っているため）。
    */
    const lines = this.lines.get(payoutId) ?? [];
    const open = lines.filter((line) => {
      if (line.isClawback) {
        return false;
      }
      const candidate = this.candidates.find((row) => row.orderId === line.orderId);
      const until = candidate?.refundableUntil ?? null;
      // ⚠️ 期限が付いていない注文も「開いている」と数える。
      return until === null || until.getTime() > now.getTime();
    });
    return Promise.resolve(open.length);
  }

  carriedInAmount(creatorAccountId: string, previousPeriodKey: string): Promise<number> {
    const previous = [...this.payouts.values()].find(
      (row) => row.creatorAccountId === creatorAccountId && row.periodKey === previousPeriodKey,
    );
    // ⚠️ 下書きのままの前月から繰り越さない。金額がまだ動く。
    if (previous === undefined || previous.status === 'draft') {
      return Promise.resolve(0);
    }
    return Promise.resolve(previous.carriedOutAmount);
  }

  listCreatorsForPeriod(input: {
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly previousPeriodKey: string;
  }): Promise<readonly string[]> {
    const sold = this.candidates
      .filter(
        (row) =>
          row.paidAt.getTime() >= input.periodStart.getTime() &&
          row.paidAt.getTime() < input.periodEnd.getTime(),
      )
      .map((row) => row.creatorAccountId);
    // ⚠️ 繰越だけの作家さまも含める。売上だけで絞ると、繰越が支払われない。
    const carried = [...this.payouts.values()]
      .filter(
        (row) =>
          row.periodKey === input.previousPeriodKey &&
          row.status !== 'draft' &&
          row.carriedOutAmount !== 0,
      )
      .map((row) => row.creatorAccountId);
    return Promise.resolve([...new Set([...sold, ...carried])]);
  }

  saveDraft(command: SavePayoutDraftCommand): Promise<PayoutView> {
    const existing = [...this.payouts.values()].find(
      (row) =>
        row.creatorAccountId === command.creatorAccountId && row.periodKey === command.periodKey,
    );
    if (existing !== undefined) {
      // ⚠️ 締めたあとは置き換えない。呼び出し側でも見ているが、ここでも見る。
      if (existing.status !== 'draft') {
        throw new Error('payout is not editable');
      }
      this.payouts.delete(existing.id);
      this.lines.delete(existing.id);
    }

    const view: PayoutView = {
      id: command.payoutId,
      creatorAccountId: command.creatorAccountId,
      periodKey: command.periodKey,
      periodStart: command.periodStart,
      periodEnd: command.periodEnd,
      dueAt: command.dueAt,
      status: 'draft',
      currency: command.currency,
      grossAmount: command.grossAmount,
      feeAmount: command.feeAmount,
      refundedAmount: command.refundedAmount,
      carriedInAmount: command.carriedInAmount,
      netAmount: command.netAmount,
      carriedOutAmount: command.carriedOutAmount,
      minimumPayoutAmount: command.minimumPayoutAmount,
      transferFeeBearer: command.transferFeeBearer,
      confirmedAt: null,
      paidAt: null,
      paidByAccountId: null,
      lineCount: command.lines.length,
      createdAt: command.now,
    };
    this.payouts.set(view.id, view);
    this.lines.set(
      view.id,
      command.lines.map((line) => ({ ...line })),
    );
    return Promise.resolve(view);
  }

  advance(input: {
    readonly payoutId: string;
    readonly from: PayoutStatus;
    readonly to: PayoutStatus;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<PayoutView | null> {
    const current = this.payouts.get(input.payoutId);
    // ⚠️ 条件付き更新。同時に押された「確定」を 2 回通さない。
    if (current === undefined || current.status !== input.from) {
      return Promise.resolve(null);
    }
    const next: PayoutView = {
      ...current,
      status: input.to,
      ...(input.to === 'confirmed' ? { confirmedAt: input.now } : {}),
      ...(input.to === 'paid' ? { paidAt: input.now, paidByAccountId: input.actorAccountId } : {}),
    };
    this.payouts.set(next.id, next);
    return Promise.resolve(next);
  }

  private alreadyPaidOut(orderId: string): boolean {
    return [...this.lines.values()]
      .flat()
      .some((line) => line.orderId === orderId && !line.isClawback);
  }

  private alreadyClawedBack(orderId: string): boolean {
    return [...this.lines.values()]
      .flat()
      .some((line) => line.orderId === orderId && line.isClawback);
  }
}

export class InMemoryOrderNotes implements OrderNoteRepository {
  listByOrder(orderId: string): Promise<readonly OrderNoteEntry[]> {
    return Promise.resolve(
      this.byOrder
        .filter((entry) => entry.orderId === orderId)
        .map((entry) => entry.note)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  append(input: {
    readonly id: string;
    readonly orderId: string;
    readonly authorAccountId: string;
    readonly body: string;
    readonly now: Date;
  }): Promise<OrderNoteEntry> {
    const note: OrderNoteEntry = {
      id: input.id,
      authorAccountId: input.authorAccountId,
      body: input.body,
      createdAt: input.now,
    };
    this.byOrder.push({ orderId: input.orderId, note });
    return Promise.resolve(note);
  }

  private readonly byOrder: { readonly orderId: string; readonly note: OrderNoteEntry }[] = [];
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, OrderView>();
  /**
   * 注文へ渡された規約の版（`UD-126`）。
   *
   * ⚠️ `OrderView` には載せていない。画面が使う値ではなく、
   * 問い合わせのときに調べる記録なので、試験からだけ覗ける形にしてある。
   */
  readonly termsSnapshots = new Map<
    string,
    { readonly termsVersionId: string | null; readonly termsVersion: number | null }
  >();
  /** 冪等キーの索引。`accountId + key`。実装は DB の UNIQUE 制約。 */
  private readonly byIdempotency = new Map<string, string>();
  private readonly sequence: string[] = [];

  constructor(
    private readonly artworks: InMemoryArtworkRepository,
    /**
     * 照合値から購入者を引くための名簿（`UD-121`）。
     *
     * ⚠️ 本番では DB の結合が担う。ここでは代替実装どうしを繋いでおく。
     * 省略すると、メールからの照合が**常に 0 件**になり、
     * 「通っているつもり」の緑になる。
     */
    private readonly accounts?: InMemoryAccountRepository,
  ) {}

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

    this.termsSnapshots.set(command.orderId, {
      termsVersionId: command.termsVersionId,
      termsVersion: command.termsVersion,
    });

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
        creatorNameSnapshot: command.item.creatorNameSnapshot,
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

  /**
   * 返金を受け付ける期限（`UD-104`）。
   *
   * ⚠️ `OrderView` には載せていない。画面が使う値ではなく、返金の判定が
   * 読む記録なので、試験と返金の代替実装からだけ覗ける形にしてある。
   */
  readonly refundableUntil = new Map<string, Date | null>();

  /** 返金の反映で使う。⚠️ 直接呼ぶのは代替実装だけ。 */
  setRefundStatus(orderId: string, refundStatus: OrderView['refundStatus']): void {
    const order = this.orders.get(orderId);
    if (order !== undefined) {
      this.orders.set(orderId, { ...order, refundStatus });
    }
  }

  markPaid(orderId: string, paidAt: Date, refundableUntil: Date | null = null): Promise<void> {
    const order = this.orders.get(orderId);
    if (
      order !== undefined &&
      (order.status === 'pending' || order.status === 'checkout_created')
    ) {
      // ⚠️ 決済確定の瞬間に焼き付ける。あとから設定を変えても動かさない。
      this.refundableUntil.set(orderId, refundableUntil);
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
    const criteria = query.criteria;
    const all = this.sequence
      .map((id) => this.orders.get(id))
      .filter((item): item is OrderView => item !== undefined)
      .filter((item) => query.accountId === undefined || item.accountId === query.accountId)
      .filter((item) => criteria === undefined || this.matches(item, criteria));
    const start = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const page = all.slice(start, start + query.limit);
    const nextIndex = start + query.limit;
    return Promise.resolve({
      items: page,
      nextCursor: nextIndex < all.length ? String(nextIndex) : null,
    });
  }

  /** 検索条件の当てはめ（`UD-121`）。本番は Prisma の `where` が担う。 */
  private matches(order: OrderView, criteria: OrderSearchCriteria): boolean {
    if (criteria.status !== null && order.status !== criteria.status) return false;
    if (criteria.paymentStatus !== null && order.paymentStatus !== criteria.paymentStatus) {
      return false;
    }
    if (criteria.orderNumber !== null) {
      const matched =
        criteria.orderNumber.kind === 'exact'
          ? order.orderNumber === criteria.orderNumber.value
          : order.orderNumber.endsWith(criteria.orderNumber.value);
      if (!matched) return false;
    }
    if (criteria.createdFrom !== null && order.createdAt < criteria.createdFrom) return false;
    if (criteria.createdTo !== null && order.createdAt > criteria.createdTo) return false;
    if (criteria.minTotalAmount !== null && order.totalAmount < criteria.minTotalAmount) {
      return false;
    }
    if (criteria.maxTotalAmount !== null && order.totalAmount > criteria.maxTotalAmount) {
      return false;
    }
    if (criteria.artworkTitle !== null) {
      const title = order.item?.titleSnapshot ?? '';
      if (!title.toLowerCase().includes(criteria.artworkTitle.toLowerCase())) return false;
    }
    if (criteria.emailHash !== null) {
      const account = this.accounts?.byId(order.accountId);
      if (account?.emailHash !== criteria.emailHash) return false;
    }
    return true;
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
  /** ⚠️ 件数だけ。金額は返さない（`UD-118`）。 */
  countByCredential(_credentialId: string): Promise<number> {
    return Promise.resolve(0);
  }

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
    void this.orders.markPaid(command.orderId, command.paidAt, command.refundableUntil);
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
  readonly legalConsents: InMemoryLegalConsents;
  readonly paymentCredentialRepository: InMemoryPaymentCredentials;
  /** ⚠️ 未設定の配備を作るために、実体の型で持つ（`clear()`）。 */
  readonly settlement: InMemorySettlementSettings;
  /** ⚠️ 受取権・発行ジョブの姿を差し替えるため、実体の型で持つ。 */
  readonly refunds: InMemoryRefunds;
  /** ⚠️ 精算の対象を差し替えるため、実体の型で持つ。 */
  readonly payouts: InMemoryPayouts;
  readonly profiles: InMemoryCreatorProfiles;
  readonly issuance: InMemoryEntitlementIssuance;
  /** ⚠️ 積まれた確認事項を覗くため、実体の型で持つ。 */
  readonly operationsReviews: InMemoryOperationsReviews;
  /** ⚠️ 積まれた知らせを覗くため、実体の型で持つ。 */
  readonly notifications: InMemoryNotifications;
  /** ⚠️ 置いた数から正しい色が出るかを見るため、実体の型で持つ。 */
  readonly operationsMetrics: InMemoryOperations;
  /** 本番販売ガード（P0-7）。⚠️ 条件を 1 つずつ崩すため実体の型で持つ。 */
  readonly productionReadiness: InMemoryProductionReadiness;
  readonly attestations: InMemoryAttestations;
  readonly mailTestSender: FakeMailTestSender;
  readonly customerDirectory: InMemoryCustomerDirectory;
  readonly creatorProfileDetails: InMemoryCreatorProfileDetails;
  readonly creatorEarnings: InMemoryCreatorEarnings;
  readonly accountNotes: InMemoryAccountNotes;
  readonly emailChangeRequests: InMemoryEmailChangeRequests;
  readonly entitlementAdmin: InMemoryEntitlementAdmin;
  readonly notificationTemplates: InMemoryNotificationTemplates;
  readonly collectibles: InMemoryCollectibles;
}

/**
 * 公開済みの特商法表記（試験用）。
 *
 * ⚠️ **中身は試験用の文字列。** 本物の表記ではない。実際の文面は
 * `UD-111` の法務確認を経て、管理画面から入力する。
 */
export function publishedTokushoho(): LegalDocumentVersion {
  const fields = Object.fromEntries(
    TOKUSHOHO_FIELD_KEYS.map((key) => [key, `試験用: ${key}`]),
  ) as unknown as TokushohoFields;
  return {
    id: 'tokushoho-seed',
    kind: 'tokushoho',
    version: 1,
    status: 'published',
    title: '特定商取引法に基づく表記',
    bodyText: null,
    tokushoho: fields,
    effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
    requiresReconsent: false,
    publishedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdByAccountId: 'account-seed',
    publishedByAccountId: 'account-seed',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
  };
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
    /*
      メール（P0-7 の 6 番目）。
      ⚠️ **`publicUrl` は `null`。** 到達性の確認を走らせない。確かめたいのは
         「届くホストがあるか」ではなく「この鍵で受け付けられるか」で、
         それは試し送りでしか分からない。
    */
    mail: { provider: 'resend', complete: true, missing: [], publicUrl: null },
  };
  const deliveries = new InMemoryWalletDeliveries();
  const auditLogReader = new InMemoryAuditLogReader(audit);
  const artworks = new InMemoryArtworkRepository(listings);
  const orderRepository = new InMemoryOrderRepository(artworks, accounts);
  const orderNotes = new InMemoryOrderNotes();
  const settlementSettings = new InMemorySettlementSettings();
  const refunds = new InMemoryRefunds(orderRepository);
  const payouts = new InMemoryPayouts();
  const profiles = new InMemoryCreatorProfiles();
  const commonUserLinks = new InMemoryCommonUserLinks();
  const paymentRepository = new InMemoryPaymentRepository(orderRepository);
  const paymentGateway = new FakePaymentGateway(
    TEST_WEBHOOK_SECRET,
    'http://localhost:3000/fake-checkout',
    () => clock.now(),
  );
  const clock = new FixedClock(TEST_NOW);
  const paymentCredentialRepository = new InMemoryPaymentCredentials();
  const legalRepository = new InMemoryLegalDocuments();
  /*
    ⚠️ **既定で特商法表記を公開済みにしておく。** 掲げるものが無ければ
       支払い口を作らせない決まりなので、これが無いと決済の試験がすべて
       「販売準備未完了」で落ちる。**その決まり自体を確かめる試験は、
       `harness.legalRepository.removeAll('tokushoho')` で未公開へ戻す。**
  */
  legalRepository.seed(publishedTokushoho());
  const issuance = new InMemoryEntitlementIssuance();
  const operationsReviews = new InMemoryOperationsReviews();
  const notifications = new InMemoryNotifications();
  const operationsMetrics = new InMemoryOperations();
  const productionReadiness = new InMemoryProductionReadiness();
  const attestations = new InMemoryAttestations();
  const mailTestSender = new FakeMailTestSender();
  const customerDirectory = new InMemoryCustomerDirectory();
  const creatorProfileDetails = new InMemoryCreatorProfileDetails();
  const creatorEarnings = new InMemoryCreatorEarnings();
  const accountNotes = new InMemoryAccountNotes();
  const emailChangeRequests = new InMemoryEmailChangeRequests();
  const entitlementAdmin = new InMemoryEntitlementAdmin();
  const notificationTemplates = new InMemoryNotificationTemplates();
  const collectibles = new InMemoryCollectibles();
  const legalConsents = new InMemoryLegalConsents(legalRepository);
  return {
    version: '0.1.0',
    probes: [],
    artworks,
    listings,
    // 返金・精算の設定（`UD-104` / `UD-119`）。⚠️ 既定は決定した値。
    settlement: settlementSettings,
    // 返金の記録（`UD-120`）。⚠️ 受取権と発行ジョブの姿は試験ごとに差し替える。
    refunds,
    // 運用確認キュー（M3a）。⚠️ 積めたかどうかを試験から覗く。
    operationsReviews,
    // 運営ダッシュボード（P0-6）。⚠️ 置いた数から色が決まるかを見る。
    operationsMetrics,
    entitlementAdmin,
    // 顧客サポート（P1-1）。⚠️ 積んだ行を試験から覗くため、実体の型で持つ。
    customerDirectory,
    accountNotes,
    emailChangeRequests,
    // 作家さま運営（P1-2）。⚠️ 保存した値を試験から覗くため、実体の型で持つ。
    creatorProfileDetails,
    creatorEarnings,
    creatorOperations: {
      profiles: creatorProfileDetails,
      earnings: creatorEarnings,
    },
    customers: {
      directory: customerDirectory,
      notes: accountNotes,
      emailChanges: emailChangeRequests,
    },
    operations: {
      repository: operationsMetrics,
      entitlements: entitlementAdmin,
      thresholds: DEFAULT_OPERATIONS_THRESHOLDS,
      jobKeys: ['issue-entitlements', 'deliver-entitlements', 'send-notifications'],
    },
    /*
      本番販売ガード（P0-7）。
      ⚠️ **既定は `staging`。** 判定はするが止めない。本番で止まることを
         確かめる試験だけが `production` へ差し替える。
    */
    productionReadiness,
    attestations,
    mailTestSender,
    production: {
      readiness: productionReadiness,
      attestations,
      environment: 'staging' as const,
      thresholds: DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
      mailTestSender,
    },
    // 購入者への知らせ（P0-4）。⚠️ 積めたかどうかを試験から覗く。
    notifications,
    notificationTemplates,
    notification: {
      templates: notificationTemplates,
      outbox: notifications,
      history: notifications,
      // ⚠️ 試験では既定で有効。無効の経路は個別の試験で差し替える。
      generationEnabled: true,
      siteName: 'テスト市',
      siteUrl: 'https://example.test',
      logger: silentLogger,
    },
    // 受取権の発行（P0-1）。⚠️ 対象の注文は試験ごとに `seedOrder` で置く。
    issuance,
    // ご自分が受け取ったもの（P0-3）。⚠️ 試験ごとに `seed` で置く。
    collectibles,
    // 精算（`UD-119`）。⚠️ 対象の注文は試験ごとに差し替える。
    payouts,
    // 作家さまの表示名（決定 2026-08-20）。
    profiles,
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
    // ⚠️ 試験でも鍵付きで動かす。鍵無しを既定にすると、照合が使えない
    //    ことに気付かないまま緑になる。
    emailHasher: new HmacEmailHasher(TEST_EMAIL_PEPPER),
    clock,
    ids: new SequentialIds(),
    storage: new InMemoryStorage(),
    audit,
    walletDeliveries: { admin: deliveries, outbox: deliveries },
    deliveries,
    auditLogs: auditLogReader,
    auditLogReader,
    paymentCredentials: {
      repository: paymentCredentialRepository,
      cipher: new ReversibleTestCipher(),
      config: {
        provider: 'fake',
        appEnvironment: 'production',
        // ⚠️ 既定は無効。有効なときの表示を見る試験だけが差し替える。
        emergencyOverrideActive: false,
        countPayments: async () => 0,
        // ⚠️ 外へ出ない擬似応答。鍵の末尾からアカウント識別子を組む。
        probeAccount: async (secretKey: string) => ({
          ok: true as const,
          accountRef: `acct_fake_${secretKey.slice(-4)}`,
        }),
      },
    },
    paymentCredentialRepository,
    legalDocuments: { documents: legalRepository, consents: legalConsents },
    legalRepository,
    legalConsents,
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
      /*
        返金の期限（`UD-104`）。
        ⚠️ **本番と同じ関数を通す。** 「設定が未登録なら期限を書き留めない」
           という規則を試験でも本物で確かめるため、ここに写しを作らない。
      */
      resolveRefundableUntil: createRefundWindowResolver(settlementSettings, 'production'),
      logger: silentLogger,
    },
    orders: {
      repository: orderRepository,
      notes: orderNotes,
      commonUserLinks,
      random: new SequentialRandom(),
      // ✅ 承認済み 2026-08-19（UD-109）: 20% = 2000。
      // ⚠️ 0 は「無料」ではなく「販売設定未完了」。0 の挙動を見る試験は
      //    `buildHarness` の戻りを書き換えて確かめる。
      resolvePlatformFeeRateBps: async () => APPROVED_FEE_RATE_BPS,
      /*
        注文へ残す規約の版（`UD-126`）。
        ⚠️ 既定は「規約が未公開」。公開してから注文する試験は、
           先に管理 API で公開してから注文する。
      */
      resolveEffectiveTerms: async () => {
        const effective = await legalRepository.findEffective('terms', clock.now());
        return effective === null ? null : { id: effective.id, version: effective.version };
      },
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
    // ⚠️ 既定は未登録。表示名を確かめる試験だけが上書きする。
    creatorDisplayName: null,
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

/**
 * 受取権の発行（P0-1）の代替実装。
 *
 * ⚠️ **判定は本物と同じドメイン関数（`planIssuance`）を通す。** ここだけ
 * 別の数え方にすると、代替実装では通るのに本番では落ちる（あるいはその逆）
 * 試験ができあがる。二重体が肩代わりしてよいのは**保存**だけで、**判定**は
 * 肩代わりさせない。
 */
export class InMemoryEntitlementIssuance implements EntitlementIssuanceRepository {
  private readonly orders = new Map<
    string,
    {
      orderNumber: string;
      accountId: string;
      paymentStatus: string;
      fulfillmentStatus: string;
      attemptCount: number;
      nextAttemptAt: Date | null;
      lastError: string | null;
      lines: { id: string; artworkId: string; quantity: number }[];
    }
  >();

  private readonly artworks = new Map<string, SupplyCounters>();

  /** 作った受取権。⚠️ 実物を数えるので、件数の正はここ。 */
  readonly entitlements: {
    id: string;
    orderLineId: string;
    unitIndex: number;
    serialNo: number;
  }[] = [];

  /** 次に `issueForOrder` を呼んだとき 1 度だけ落とす（途中失敗の再現）。 */
  failNext: string | null = null;

  private nextId = 1;

  seedOrder(input: {
    readonly orderId: string;
    readonly orderNumber?: string;
    readonly accountId?: string;
    readonly artworkId: string;
    readonly quantity: number;
    readonly maxSupply?: number;
    readonly paymentStatus?: string;
  }): void {
    const quantity = input.quantity;
    this.orders.set(input.orderId, {
      orderNumber: input.orderNumber ?? `SNK-${input.orderId}`,
      accountId: input.accountId ?? `account-${input.orderId}`,
      paymentStatus: input.paymentStatus ?? 'succeeded',
      fulfillmentStatus: 'not_started',
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      lines: [{ id: `line-${input.orderId}`, artworkId: input.artworkId, quantity }],
    });
    const existing = this.artworks.get(input.artworkId);
    this.artworks.set(input.artworkId, {
      maxSupply: input.maxSupply ?? existing?.maxSupply ?? 10,
      // 決済が済んだ枠は押さえたまま（決定 A）。
      reservedCount: (existing?.reservedCount ?? 0) + quantity,
      issuedCount: existing?.issuedCount ?? 0,
    });
  }

  counters(artworkId: string): SupplyCounters | undefined {
    return this.artworks.get(artworkId);
  }

  attemptsOf(orderId: string): number {
    return this.orders.get(orderId)?.attemptCount ?? 0;
  }

  lastErrorOf(orderId: string): string | null {
    return this.orders.get(orderId)?.lastError ?? null;
  }

  fulfillmentOf(orderId: string): string | undefined {
    return this.orders.get(orderId)?.fulfillmentStatus;
  }

  countFor(orderId: string): number {
    const order = this.orders.get(orderId);
    if (order === undefined) return 0;
    const lineIds = new Set(order.lines.map((line) => line.id));
    return this.entitlements.filter((row) => lineIds.has(row.orderLineId)).length;
  }

  listPending(limit: number, now: Date): Promise<IssuanceCandidate[]> {
    const rows: IssuanceCandidate[] = [];
    for (const [orderId, order] of this.orders) {
      if (order.paymentStatus !== 'succeeded' || order.fulfillmentStatus === 'fulfilled') continue;
      if (
        !isIssuanceDue(
          { nextAttemptAt: order.nextAttemptAt, attemptCount: order.attemptCount },
          now,
        )
      )
        continue;
      rows.push({ orderId, orderNumber: order.orderNumber });
      if (rows.length >= limit) break;
    }
    return Promise.resolve(rows);
  }

  issueForOrder(orderId: string, now: Date): Promise<Result<IssuanceOutcome, DomainError>> {
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      // ⚠️ 途中失敗の再現。投げた側は何も書き換えていない。
      return Promise.reject(new Error(message));
    }

    const order = this.orders.get(orderId);
    if (order === undefined) {
      return Promise.resolve(err(domainError('ENTITLEMENT_ORDER_NOT_FOUND', 'missing')));
    }
    if (order.paymentStatus !== 'succeeded') {
      return Promise.resolve(err(domainError('ENTITLEMENT_ORDER_NOT_PAID', 'unpaid')));
    }

    const entitlementIds: string[] = [];
    let issued = 0;

    for (const line of order.lines) {
      const counters = this.artworks.get(line.artworkId);
      if (counters === undefined) {
        return Promise.resolve(err(domainError('ENTITLEMENT_SUPPLY_MISMATCH', 'no counters')));
      }
      const alreadyIssued = this.entitlements.filter((row) => row.orderLineId === line.id).length;
      const plan = planIssuance({ quantity: line.quantity, alreadyIssued, counters });
      if (!plan.ok) {
        return Promise.resolve(plan);
      }
      if (plan.value.missing === 0) continue;

      this.artworks.set(line.artworkId, plan.value.counters);
      for (const unit of plan.value.units) {
        const id = `ent-${String(this.nextId)}`;
        this.nextId += 1;
        this.entitlements.push({
          id,
          orderLineId: line.id,
          unitIndex: unit.unitIndex,
          serialNo: unit.serialNo,
        });
        entitlementIds.push(id);
        issued += 1;
      }
    }

    order.fulfillmentStatus = 'fulfilled';
    order.attemptCount = 0;
    order.nextAttemptAt = null;
    order.lastError = null;
    void now;

    return Promise.resolve(ok({ orderId, orderNumber: order.orderNumber, issued, entitlementIds }));
  }

  recordFailure(input: {
    readonly orderId: string;
    readonly code: string;
    readonly now: Date;
  }): Promise<IssuanceRetry> {
    const order = this.orders.get(input.orderId);
    const previous = order?.attemptCount ?? 0;
    const retry = scheduleIssuanceRetry(previous, input.now);
    if (order !== undefined) {
      order.attemptCount = retry.attemptCount;
      order.nextAttemptAt = retry.nextAttemptAt;
      order.lastError = input.code;
    }
    return Promise.resolve(retry);
  }

  reconcile(): Promise<SupplyReconciliation[]> {
    const counts = new Map<string, number>();
    for (const [, order] of this.orders) {
      for (const line of order.lines) {
        const made = this.entitlements.filter((row) => row.orderLineId === line.id).length;
        counts.set(line.artworkId, (counts.get(line.artworkId) ?? 0) + made);
      }
    }
    return Promise.resolve(
      reconcileSupply(
        [...this.artworks].map(([artworkId, counters]) => ({
          artworkId,
          issuedCount: counters.issuedCount,
          entitlementCount: counts.get(artworkId) ?? 0,
        })),
      ),
    );
  }
}

/**
 * ご自分が受け取ったもの（P0-3）の代替実装。
 *
 * ⚠️ **絞り込みを本物と同じくこの中で行う。** 二重体だけが全件を返す形に
 * すると、「他人の分が見えないこと」の試験が二重体の都合で通ってしまう。
 */
export class InMemoryCollectibles implements CollectibleRepository {
  private readonly rows: CollectibleView[] = [];

  seed(overrides: Partial<CollectibleView> & { accountId: string }): CollectibleView {
    const index = this.rows.length + 1;
    const row: CollectibleView = {
      entitlementId: `ent-${String(index)}`,
      artworkId: 'artwork-1',
      artworkSlug: 'sample-artwork',
      artworkTitle: '天下布武の陣羽織',
      creatorName: '戦国工房',
      imageKey: 'artworks/sample.png',
      serialNo: index,
      acquiredAt: TEST_NOW,
      status: 'issued',
      deliveryStatus: 'not_started',
      orderNumber: `SNK-${String(index)}`,
      orderId: `order-${String(index)}`,
      ...overrides,
    };
    this.rows.push(row);
    this.owners.set(row.entitlementId, overrides.accountId);
    return row;
  }

  /** 受取権IDから持ち主を引く。⚠️ 応答には載せない値なので、ここだけで持つ。 */
  private readonly owners = new Map<string, string>();

  listForAccount(input: {
    readonly accountId: string;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): Promise<CollectibleListPage> {
    // ⚠️ ここが唯一の絞り込み。外して呼べる形にしない。
    const mine = this.rows.filter((row) => this.owners.get(row.entitlementId) === input.accountId);
    const items = mine.slice(0, Math.max(input.limit, 1));
    return Promise.resolve({ items, nextCursor: null });
  }
}

/**
 * 知らせの文面（試験用）。
 *
 * ⚠️ **既定で 9 種別すべてを公開済みにしておく。** 文面が無ければ知らせは
 * 積まれない決まりなので、これが無いと通知の試験がすべて「文面が無い」で
 * 空振りする。**その決まり自体を確かめる試験は `unpublish` で外す。**
 */
export class InMemoryNotificationTemplates implements NotificationTemplateRepository {
  private readonly rows: NotificationTemplateRecord[] = [];

  constructor(seedAll = true) {
    if (seedAll) {
      for (const eventType of NOTIFICATION_EVENT_TYPES) {
        this.rows.push({
          eventType,
          version: 1,
          subject: `[test] ${eventType} {{orderNumber}}`,
          body: `本文 {{orderNumber}} / {{siteName}}`,
          status: 'published',
          publishedAt: TEST_NOW,
          updatedAt: TEST_NOW,
        });
      }
    }
  }

  /** その種別の文面を取り下げる。⚠️ 「文面が無い」経路を試すため。 */
  unpublish(eventType: NotificationEventType): void {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]!.eventType === eventType) {
        this.rows.splice(i, 1);
      }
    }
  }

  /** 差し込み語を差し替える。⚠️ 値が足りない経路を試すため。 */
  setBody(eventType: NotificationEventType, subject: string, body: string): void {
    const index = this.rows.findIndex((row) => row.eventType === eventType);
    const next = { ...this.rows[index]!, subject, body };
    this.rows[index] = next;
  }

  findPublished(eventType: NotificationEventType): Promise<NotificationTemplateRecord | null> {
    const published = this.rows
      .filter((row) => row.eventType === eventType && row.status === 'published')
      .sort((a, b) => b.version - a.version);
    return Promise.resolve(published[0] ?? null);
  }

  listAll(): Promise<readonly NotificationTemplateRecord[]> {
    return Promise.resolve([...this.rows]);
  }

  listVersions(eventType: NotificationEventType): Promise<readonly NotificationTemplateRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.eventType === eventType));
  }

  createVersion(input: {
    readonly eventType: NotificationEventType;
    readonly subject: string;
    readonly body: string;
    readonly status: NotificationTemplateStatus;
    readonly actorAccountId: string | null;
    readonly now: Date;
  }): Promise<NotificationTemplateRecord> {
    const latest = this.rows
      .filter((row) => row.eventType === input.eventType)
      .reduce((max, row) => Math.max(max, row.version), 0);
    const record: NotificationTemplateRecord = {
      eventType: input.eventType,
      version: latest + 1,
      subject: input.subject,
      body: input.body,
      status: input.status,
      publishedAt: input.status === 'published' ? input.now : null,
      updatedAt: input.now,
    };
    this.rows.push(record);
    return Promise.resolve(record);
  }

  publish(input: {
    readonly eventType: NotificationEventType;
    readonly version: number;
    readonly now: Date;
  }): Promise<boolean> {
    const index = this.rows.findIndex(
      (row) =>
        row.eventType === input.eventType &&
        row.version === input.version &&
        row.status === 'draft',
    );
    if (index < 0) {
      return Promise.resolve(false);
    }
    this.rows[index] = {
      ...this.rows[index]!,
      status: 'published',
      publishedAt: input.now,
      updatedAt: input.now,
    };
    return Promise.resolve(true);
  }
}

/** 送信待ちと送信履歴（試験用）。⚠️ 重複は「作らない」で受ける。 */
export class InMemoryNotifications implements NotificationOutboxPort, NotificationHistoryPort {
  readonly rows: {
    record: NotificationRecord;
    maskedRecipient: string | null;
    recipientHash: string | null;
    skippedReasonCode: string | null;
    lastErrorCode: string | null;
    nextRetryAt: Date;
    sentAt: Date | null;
    createdAt: Date;
  }[] = [];

  enqueue(input: NotificationEnqueueInput): Promise<NotificationEnqueueOutcome> {
    const existing = this.rows.find(
      (row) =>
        row.record.eventType === input.eventType &&
        row.record.subjectType === input.subjectType &&
        row.record.subjectId === input.subjectId,
    );
    if (existing !== undefined) {
      // ⚠️ 例外にしない。業務側のトランザクションを巻き戻さない。
      return Promise.resolve({ kind: 'duplicate', id: existing.record.id });
    }
    this.rows.push({
      record: {
        id: input.id,
        eventType: input.eventType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        accountId: input.accountId,
        renderedSubject: input.renderedSubject,
        renderedBody: input.renderedBody,
        templateVersion: input.templateVersion,
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: 5,
        correlationId: input.correlationId,
      },
      maskedRecipient: null,
      recipientHash: null,
      skippedReasonCode: null,
      lastErrorCode: null,
      nextRetryAt: input.now,
      sentAt: null,
      createdAt: input.now,
    });
    return Promise.resolve({ kind: 'created', id: input.id });
  }

  claimBatch(input: { readonly limit: number; readonly now: Date }): Promise<NotificationRecord[]> {
    const picked: NotificationRecord[] = [];
    for (const row of this.rows) {
      if (picked.length >= input.limit) break;
      if (row.record.status !== 'PENDING') continue;
      if (row.nextRetryAt.getTime() > input.now.getTime()) continue;
      row.record = {
        ...row.record,
        status: 'PROCESSING',
        attemptCount: row.record.attemptCount + 1,
      };
      picked.push(row.record);
    }
    return Promise.resolve(picked);
  }

  markSent(input: {
    readonly id: string;
    readonly providerMessageId: string | null;
    readonly maskedRecipient: string;
    readonly recipientHash: string | null;
    readonly now: Date;
  }): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.record.id === input.id);
    if (row === undefined || row.record.status !== 'PROCESSING') {
      return Promise.resolve(false);
    }
    row.record = { ...row.record, status: 'SENT' };
    row.maskedRecipient = input.maskedRecipient;
    row.recipientHash = input.recipientHash;
    row.sentAt = input.now;
    return Promise.resolve(true);
  }

  recordFailure(input: NotificationFailureInput): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.record.id === input.id);
    if (row === undefined || row.record.status !== 'PROCESSING') {
      return Promise.resolve(false);
    }
    row.record = { ...row.record, status: input.status };
    row.lastErrorCode = input.errorCode;
    row.nextRetryAt = input.nextRetryAt;
    return Promise.resolve(true);
  }

  markSkipped(input: { readonly id: string; readonly reasonCode: string }): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.record.id === input.id);
    if (row === undefined || row.record.status !== 'PROCESSING') {
      return Promise.resolve(false);
    }
    row.record = { ...row.record, status: 'SKIPPED' };
    row.skippedReasonCode = input.reasonCode;
    return Promise.resolve(true);
  }

  reclaimStale(): Promise<number> {
    return Promise.resolve(0);
  }

  requeue(input: { readonly id: string; readonly now: Date }): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.record.id === input.id);
    if (row === undefined || (row.record.status !== 'FAILED' && row.record.status !== 'DEAD')) {
      return Promise.resolve(false);
    }
    row.record = { ...row.record, status: 'PENDING', attemptCount: 0 };
    row.nextRetryAt = input.now;
    row.lastErrorCode = null;
    return Promise.resolve(true);
  }

  list(query: NotificationHistoryQuery): Promise<NotificationHistoryPage> {
    const items = this.rows
      .filter((row) => query.status === undefined || row.record.status === query.status)
      .filter((row) => query.eventType === undefined || row.record.eventType === query.eventType)
      .filter((row) => query.subjectId === undefined || row.record.subjectId === query.subjectId)
      .slice(0, query.limit)
      .map((row) => this.toHistory(row));
    return Promise.resolve({ items, nextCursor: null });
  }

  findById(id: string): Promise<NotificationHistoryRecord | null> {
    const row = this.rows.find((candidate) => candidate.record.id === id);
    return Promise.resolve(row === undefined ? null : this.toHistory(row));
  }

  private toHistory(row: InMemoryNotifications['rows'][number]): NotificationHistoryRecord {
    return {
      id: row.record.id,
      eventType: row.record.eventType,
      subjectType: row.record.subjectType,
      subjectId: row.record.subjectId,
      maskedRecipient: row.maskedRecipient,
      templateVersion: row.record.templateVersion,
      subject: row.record.renderedSubject,
      status: row.record.status,
      attemptCount: row.record.attemptCount,
      lastErrorCode: row.lastErrorCode,
      skippedReasonCode: row.skippedReasonCode,
      sentAt: row.sentAt,
      createdAt: row.createdAt,
    };
  }
}

/**
 * 運営ダッシュボードの数え上げ（試験用）。
 *
 * ⚠️ **数字を試験から直に置く。** 本物の集計を真似ると、集計の試験に
 * なってしまう（そちらは DB の結合試験で見る）。ここで見たいのは
 * 「置いた数から、正しい色が出るか」である。
 */
export class InMemoryOperations implements OperationsMetricsPort {
  counts_: OperationsCounts = {
    todayOrderCount: 0,
    todayPaidAmount: 0,
    todayPaidCount: 0,
    todayPaymentFailedCount: 0,
    issuancePendingCount: 0,
    issuanceFailedCount: 0,
    walletDeliveryPendingCount: 0,
    walletDeliveryFailedCount: 0,
    operationsReviewOpenCount: 0,
    notificationPendingCount: 0,
    notificationFailedCount: 0,
    integrationFailureCount: 0,
    lastWebhookReceivedAt: TEST_NOW,
  };

  consistency_: ConsistencyCounts = {
    paidWithoutEntitlements: [],
    supplyDrift: [],
    revokedWithoutWalletNotice: [],
    claimedWithoutDelivery: [],
    unmaskedRecipient: [],
  };

  /** 記録された実行。⚠️ 種別ごとに 1 行を上書きする（本物と同じ）。 */
  readonly jobRuns = new Map<
    string,
    { lastSucceededAt: Date | null; lastFailedAt: Date | null; lastOutcome: string | null }
  >();

  counts(): Promise<OperationsCounts> {
    return Promise.resolve(this.counts_);
  }

  heartbeats(jobKeys: readonly string[]): Promise<readonly JobHeartbeat[]> {
    return Promise.resolve(
      jobKeys.map((jobKey) => {
        const row = this.jobRuns.get(jobKey);
        return {
          jobKey,
          lastSucceededAt: row?.lastSucceededAt ?? null,
          lastFailedAt: row?.lastFailedAt ?? null,
          lastOutcome: (row?.lastOutcome as JobHeartbeat['lastOutcome']) ?? null,
        };
      }),
    );
  }

  recordJobRun(input: {
    readonly jobKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly now: Date;
  }): Promise<void> {
    const existing = this.jobRuns.get(input.jobKey);
    this.jobRuns.set(input.jobKey, {
      // ⚠️ 失敗しても成功の時刻を消さない（本物と同じ）。
      lastSucceededAt:
        input.outcome === 'succeeded' ? input.now : (existing?.lastSucceededAt ?? null),
      lastFailedAt: input.outcome === 'failed' ? input.now : (existing?.lastFailedAt ?? null),
      lastOutcome: input.outcome,
    });
    return Promise.resolve();
  }

  consistency(): Promise<ConsistencyCounts> {
    return Promise.resolve(this.consistency_);
  }
}

/** 受取権の一覧（試験用）。⚠️ 個人情報の項目を持たない。 */
export class InMemoryEntitlementAdmin implements EntitlementAdminPort {
  rows: EntitlementAdminDetailRecord[] = [];

  list(query: {
    readonly status?: string | undefined;
    readonly accountId?: string | undefined;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly EntitlementAdminRecord[];
    readonly nextCursor: string | null;
  }> {
    const items = this.rows
      .filter((row) => query.status === undefined || row.status === query.status)
      .filter((row) => query.accountId === undefined || row.accountId === query.accountId)
      .slice(0, query.limit);
    return Promise.resolve({ items, nextCursor: null });
  }

  findById(id: string): Promise<EntitlementAdminDetailRecord | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return Promise.resolve(row ?? null);
  }

  listUndeliveredForAccount(accountId: string, limit: number): Promise<readonly string[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            row.accountId === accountId &&
            row.status === 'claimed' &&
            row.walletDeliveryStatus !== 'delivered',
        )
        .slice(0, limit)
        .map((row) => row.id),
    );
  }
}

/**
 * 本番販売ガードの事実（試験用）。
 *
 * ⚠️ **既定は「何も無い」。** 立ち上げた直後の姿がこれで、10 条件すべてが
 * 未達になる。既定で満たされる形にすると、条件を 1 つずつ確かめる試験が
 * すべて空振りしたまま緑になる。
 */
export class InMemoryProductionReadiness implements ProductionReadinessPort {
  facts_: ProductionReadinessFacts = {
    acceptingCredential: null,
    platformFeeRateBps: 0,
    publishedLegalKinds: [],
    walletCheck: null,
    mailCheck: null,
    jobs: [],
    owners: [],
    latestE2eSaleTest: null,
    latestOwnerApproval: null,
  };

  /** 10 条件すべてを満たした姿にする。⚠️ 試験が明示的に呼んだときだけ。 */
  makeReady(now: Date, credentialId = 'credential-1'): void {
    const recent = new Date(now.getTime() - 60 * 60_000);
    this.facts_ = {
      acceptingCredential: {
        id: credentialId,
        generation: 1,
        lastCheckSucceeded: true,
        lastCheckAt: recent,
        lastWebhookReceivedAt: recent,
      },
      platformFeeRateBps: 2000,
      publishedLegalKinds: ['terms', 'privacy', 'tokushoho'],
      walletCheck: { succeeded: true, executedAt: recent },
      mailCheck: { succeeded: true, executedAt: recent },
      jobs: [
        {
          jobKey: 'issue-entitlements',
          lastSucceededAt: recent,
          lastFailedAt: null,
          lastOutcome: 'succeeded',
        },
        {
          jobKey: 'deliver-entitlements',
          lastSucceededAt: recent,
          lastFailedAt: null,
          lastOutcome: 'succeeded',
        },
      ],
      owners: [{ accountId: 'account-user-owner', lastAal2At: recent }],
      latestE2eSaleTest: { succeeded: true, credentialId, attestedAt: recent },
      latestOwnerApproval: { succeeded: true, credentialId, attestedAt: recent },
    };
  }

  facts(): Promise<ProductionReadinessFacts> {
    return Promise.resolve(this.facts_);
  }
}

/** 人が残す証跡（試験用）。⚠️ **更新も削除も実装しない**（本物と同じ）。 */
export class InMemoryAttestations implements AttestationPort {
  readonly rows: AttestationRecord[] = [];

  record(command: RecordAttestationCommand, now: Date): Promise<string> {
    const id = `attestation-${String(this.rows.length + 1)}`;
    this.rows.push({
      id,
      kind: command.kind,
      succeeded: command.succeeded,
      credentialId: command.credentialId,
      attestedByAccountId: command.attestedByAccountId,
      note: command.note,
      attestedAt: now,
    });
    return Promise.resolve(id);
  }

  latest(kind: AttestationKind): Promise<AttestationFact | null> {
    // ⚠️ 「どこかに成功がある」ではなく「最新が成功か」（本物と同じ）。
    const rows = this.rows.filter((row) => row.kind === kind);
    const last = rows[rows.length - 1];
    return Promise.resolve(
      last === undefined
        ? null
        : {
            succeeded: last.succeeded,
            credentialId: last.credentialId,
            attestedAt: last.attestedAt,
          },
    );
  }

  list(limit: number): Promise<readonly AttestationRecord[]> {
    return Promise.resolve([...this.rows].reverse().slice(0, limit));
  }
}

/**
 * メールの試し送り（試験用）。
 *
 * ⚠️ **宛先を覚えておく。** 「押した本人の業務用アドレスへ送っているか」を
 * 試験が確かめられるようにするため。**本物は宛先を保存しない。**
 */
export class FakeMailTestSender {
  outcome: MailAttemptOutcome = { kind: 'accepted', providerMessageId: 'msg-1' };
  readonly sent: { readonly to: string; readonly subject: string }[] = [];

  send(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }): Promise<MailAttemptOutcome> {
    this.sent.push({ to: input.to, subject: input.subject });
    return Promise.resolve(this.outcome);
  }
}

/**
 * 顧客サポート（P1-1・試験用）。
 *
 * ⚠️ **氏名とメールアドレスの平文を持たない。** 本物と同じく、持っていない
 * ものは返せない。
 */
export class InMemoryCustomerDirectory implements CustomerDirectoryPort {
  summaries: CustomerSummary[] = [];
  entitlementRows: (CustomerEntitlement & { accountId: string })[] = [];
  orderRows: (CustomerOrderRow & { accountId: string })[] = [];
  refundRows: (CustomerRefundRow & { accountId: string })[] = [];
  candidates = new Map<string, DuplicateCandidate[]>();
  /** 照合値 → アカウントID。⚠️ 平文は持たない。 */
  byEmailHash = new Map<string, string[]>();

  findByEmailHash(emailHash: string, limit: number): Promise<readonly CustomerSummary[]> {
    const ids = this.byEmailHash.get(emailHash) ?? [];
    return Promise.resolve(
      ids.flatMap((id) => this.summaries.filter((row) => row.accountId === id)).slice(0, limit),
    );
  }

  findByCommonUserId(commonUserId: string, limit: number): Promise<readonly CustomerSummary[]> {
    return Promise.resolve(
      this.summaries.filter((row) => row.commonUserId === commonUserId).slice(0, limit),
    );
  }

  findByAccountId(accountId: string): Promise<CustomerSummary | null> {
    return Promise.resolve(this.summaries.find((row) => row.accountId === accountId) ?? null);
  }

  findByOrderNumber(orderNumber: string): Promise<CustomerSummary | null> {
    const order = this.orderRows.find((row) => row.orderNumber === orderNumber);
    return order === undefined ? Promise.resolve(null) : this.findByAccountId(order.accountId);
  }

  entitlements(accountId: string, limit: number): Promise<readonly CustomerEntitlement[]> {
    return Promise.resolve(
      this.entitlementRows.filter((row) => row.accountId === accountId).slice(0, limit),
    );
  }

  orders(accountId: string, limit: number): Promise<readonly CustomerOrderRow[]> {
    return Promise.resolve(
      this.orderRows.filter((row) => row.accountId === accountId).slice(0, limit),
    );
  }

  refunds(accountId: string, limit: number): Promise<readonly CustomerRefundRow[]> {
    return Promise.resolve(
      this.refundRows.filter((row) => row.accountId === accountId).slice(0, limit),
    );
  }

  duplicateCandidates(accountId: string, limit: number): Promise<readonly DuplicateCandidate[]> {
    return Promise.resolve((this.candidates.get(accountId) ?? []).slice(0, limit));
  }
}

/** アカウント単位の申し送り（試験用）。⚠️ 追記のみ。 */
export class InMemoryAccountNotes implements AccountNotePort {
  readonly rows: (AccountNoteRecord & { accountId: string })[] = [];

  add(input: {
    readonly accountId: string;
    readonly authorAccountId: string;
    readonly body: string;
    readonly now: Date;
  }): Promise<string> {
    const id = `note-${String(this.rows.length + 1)}`;
    this.rows.unshift({
      id,
      accountId: input.accountId,
      authorAccountId: input.authorAccountId,
      body: input.body,
      createdAt: input.now,
    });
    return Promise.resolve(id);
  }

  list(accountId: string, limit: number): Promise<readonly AccountNoteRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.accountId === accountId).slice(0, limit));
  }
}

/**
 * ご連絡先の変更申請（試験用）。
 *
 * ⚠️ **本物と同じく、決着した申請は動かない。** 代替実装が緩いと、
 * 「本人確認を飛ばせない」ことを確かめる試験が空振りする。
 */
export class InMemoryEmailChangeRequests implements EmailChangeRequestPort {
  readonly rows: EmailChangeRequestRecord[] = [];

  open(input: {
    readonly accountId: string;
    readonly requestedMaskedEmail: string;
    readonly requestedEmailHash: string;
    readonly openedByAccountId: string;
    readonly now: Date;
  }): Promise<string> {
    const id = `ecr-${String(this.rows.length + 1)}`;
    this.rows.unshift({
      id,
      accountId: input.accountId,
      requestedMaskedEmail: input.requestedMaskedEmail,
      status: 'requested',
      verificationMethod: null,
      verifiedByAccountId: null,
      verifiedAt: null,
      settledByAccountId: null,
      settledAt: null,
      note: null,
      openedByAccountId: input.openedByAccountId,
      createdAt: input.now,
    });
    return Promise.resolve(id);
  }

  findById(id: string): Promise<EmailChangeRequestRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  list(accountId: string, limit: number): Promise<readonly EmailChangeRequestRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.accountId === accountId).slice(0, limit));
  }

  verify(input: {
    readonly id: string;
    readonly method: IdentityVerificationMethod;
    readonly note: string | null;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<void> {
    this.replace(input.id, (row) => ({
      ...row,
      status: 'identity_verified',
      verificationMethod: input.method,
      verifiedByAccountId: input.actorAccountId,
      verifiedAt: input.now,
      note: input.note,
    }));
    return Promise.resolve();
  }

  settle(input: {
    readonly id: string;
    readonly status: 'completed' | 'rejected';
    readonly note: string | null;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<void> {
    this.replace(input.id, (row) => ({
      ...row,
      status: input.status,
      settledByAccountId: input.actorAccountId,
      settledAt: input.now,
      note: input.note,
    }));
    return Promise.resolve();
  }

  /** ⚠️ 決着した行は動かさない（本物の条件付き UPDATE と同じ）。 */
  private replace(
    id: string,
    change: (row: EmailChangeRequestRecord) => EmailChangeRequestRecord,
  ): void {
    const index = this.rows.findIndex((row) => row.id === id);
    const row = this.rows[index];
    if (row === undefined) {
      return;
    }
    if (row.status === 'completed' || row.status === 'rejected') {
      return;
    }
    this.rows[index] = change(row);
  }
}

/**
 * 作家さまのプロフィールの中身（試験用・P1-2）。
 *
 * ⚠️ **表示名の代替実装（`InMemoryCreatorProfiles`）とは別物。** あちらは
 * 一意性を持つ表示名、こちらは紹介文や画像。名前が似ているので、
 * 取り違えないよう別の名前にしてある。
 */
export class InMemoryCreatorProfileDetails implements CreatorProfilePort {
  readonly rows = new Map<string, CreatorProfileRecord>();

  find(accountId: string): Promise<CreatorProfileRecord | null> {
    return Promise.resolve(this.rows.get(accountId) ?? null);
  }

  save(input: {
    readonly accountId: string;
    readonly shopName: string | null;
    readonly bio: string | null;
    readonly links: readonly CreatorLink[];
    readonly invoiceNumber: string | null;
    readonly now: Date;
  }): Promise<CreatorProfileRecord> {
    const current = this.rows.get(input.accountId);
    const next: CreatorProfileRecord = {
      accountId: input.accountId,
      shopName: input.shopName,
      bio: input.bio,
      links: input.links,
      // ⚠️ 画像の鍵に触れない（本物と同じ）。触ると、直すたびに画像が消える。
      iconKey: current?.iconKey ?? null,
      coverKey: current?.coverKey ?? null,
      invoiceNumber: input.invoiceNumber,
    };
    this.rows.set(input.accountId, next);
    return Promise.resolve(next);
  }

  saveImageKey(input: {
    readonly accountId: string;
    readonly slot: 'icon' | 'cover';
    readonly key: string;
    readonly now: Date;
  }): Promise<void> {
    const current = this.rows.get(input.accountId) ?? {
      accountId: input.accountId,
      shopName: null,
      bio: null,
      links: [],
      iconKey: null,
      coverKey: null,
      invoiceNumber: null,
    };
    this.rows.set(input.accountId, {
      ...current,
      ...(input.slot === 'icon' ? { iconKey: input.key } : { coverKey: input.key }),
    });
    return Promise.resolve();
  }
}

/** 締めた精算の明細（試験用）。 */
export class InMemoryCreatorEarnings implements CreatorEarningsPort {
  readonly lines = new Map<string, PayoutLineDraft[]>();

  linesOf(payoutId: string): Promise<readonly PayoutLineDraft[]> {
    return Promise.resolve(this.lines.get(payoutId) ?? []);
  }
}
