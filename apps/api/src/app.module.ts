import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import express from 'express';
import type { AccountLookupPort, TokenVerifierPort } from '@sengoku/auth';
import type {
  ArtworkRepository,
  ClaimTokenPort,
  RateLimiterPort,
  IdempotencyStore,
  AuditLogPort,
  EmailHashPort,
  ClockPort,
  IdGeneratorPort,
  ListingRepository,
  StoragePort,
  StaffInvitationRepository,
  StaffMemberRepository,
  IntegrationRepository,
  LegalDocumentRepository,
  LegalConsentRepository,
  PaymentCredentialRepository,
  SecretCipherPort,
  AuditLogReadPort,
  OrderRepository,
  OrderNoteRepository,
  SettlementSettingsRepository,
  CollectibleRepository,
  EntitlementIssuanceRepository,
  RefundRepository,
  DisputePort,
  RefundRequestPort,
  CreatorInquiryPort,
  CreatorReceivablePort,
  RefundPolicyPort,
  PayoutRepository,
  CreatorDirectoryPort,
  SalesReportPort,
  CreatorProfileRepository,
  PaymentRepository,
  PaymentGatewayPort,
  CommonUserLinkRepository,
  RandomPort,
  WalletDeliveryAdminPort,
  WalletDeliveryOutboxPort,
  IntegrationEnvironment,
  IntegrationSettings,
  IntegrationService as IntegrationServiceName,
  EnvIntegrationSummary,
  ProbeOutcome,
  OperationsReviewRepository,
  RevocationReconcileRepository,
  MailSenderPort,
  NotificationHistoryPort,
  NotificationOutboxPort,
  NotificationTemplateRepository,
  RecipientResolverPort,
  OperationsThresholds,
  OperationsAlertSettingsPort,
  AlertWebhookPort,
  OperationsMetricsPort,
  EntitlementAdminPort,
  // 顧客サポート（P1-1）。
  AccountNotePort,
  CustomerDirectoryPort,
  EmailChangeRequestPort,
  // 作家さま運営（P1-2）。
  CreatorEarningsPort,
  CreatorProfilePort,
  PayoutAccountCipherPort,
  PayoutAccountPort,
} from '@sengoku/domain';
import type { NotifiableEntitlement as NotifiableEntitlementRow } from '@sengoku/database';
import { canDiscloseCheckoutTerms } from '@sengoku/domain';
import type {
  AttestationPort,
  ProductionReadinessPort,
  ProductionReadinessThresholds,
} from '@sengoku/domain';
import type { SenNoKuniHmacVerifier } from '@sengoku/integrations';
import type { Logger } from '@sengoku/observability';

/**
 * 何も書き出さないログ。
 *
 * ⚠️ **本番で使わない。** 決済を繋いでいない配備（手元・E2E）で、
 * 返金の経路が logger を要求するために置いてある。決済を繋いだ配備では
 * `payments.logger` が渡るので、こちらは使われない。
 */
const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => SILENT_LOGGER,
  // ⚠️ pino の全面を実装しない。使うのは上の 5 つと `child` だけ。
} as unknown as Logger;
import { AuthGuard } from './auth/auth.guard';
import { ClaimController } from './claim/claim.controller';
import { ClaimService } from './claim/claim.service';
import { WalletAutoDeliveryService } from './claim/auto-delivery.service';
import { WalletDeliveryPlanner } from './claim/delivery.planner';
import { ClaimReissueController } from './claim/reissue.controller';
import { ReissueService, type ClaimTokenRotationSource } from './claim/reissue.service';
import { CLAIM_HMAC_CONFIG, SenNoKuniHmacGuard, type ClaimHmacConfig } from './claim/hmac.guard';
import {
  CLAIM_RATE_LIMIT_CONFIG,
  ClaimRateLimitGuard,
  type ClaimRateLimitConfig,
} from './claim/rate-limit.guard';
import type { ContentHasher } from './common/content-hash';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { IdempotencyService } from './common/idempotency';
import { AdminCatalogController } from './catalog/admin-catalog.controller';
import { AdminCatalogService } from './catalog/admin-catalog.service';
import { CreatorCatalogController } from './catalog/creator-catalog.controller';
import { CreatorCatalogService } from './catalog/creator-catalog.service';
import { CatalogController, PublicListingController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { ArtworkImageService, type StorageKeyFactory } from './catalog/image.service';
import { StaffController, StaffInvitationAcceptController } from './staff/staff.controller';
import { StaffService } from './staff/staff.service';
import { IntegrationController } from './integration/integration.controller';
import {
  IntegrationService_,
  type PaymentDeploymentStatus,
} from './integration/integration.service';
import { WalletDeliveryController } from './wallet-delivery/wallet-delivery.controller';
import { WalletDeliveryAdminService } from './wallet-delivery/wallet-delivery.service';
import {
  OrderController,
  AdminOrderController,
  CheckoutController,
} from './order/order.controller';
import { OrderService } from './order/order.service';
import { OrderSupportService } from './order/order-support.service';
import {
  COLLECTIBLE_CONFIG,
  CollectibleController,
  type CollectibleConfig,
} from './order/collectible.controller';
import {
  EntitlementIssuanceService,
  ISSUANCE_CONFIG,
  type IssuanceConfig,
} from './order/issuance.service';
import { RefundService } from './order/refund.service';
import {
  AdminRefundRequestController,
  BuyerRefundRequestController,
  CreatorRefundInquiryController,
} from './refund/refund-request.controller';
import {
  REFUND_REQUEST_CONFIG,
  RefundRequestService,
  type RefundRequestConfig,
} from './refund/refund-request.service';
import { WalletRevokePlanner } from './claim/revoke.planner';
import { RevocationReconcileService } from './claim/revocation-reconcile.service';
import { OperationsReviewController } from './operations/operations-review.controller';
import { OperationsReviewService } from './operations/operations-review.service';
import { NotificationController } from './notification/notification.controller';
import { NotificationAdminService } from './notification/notification-admin.service';
import { NotificationService, NOTIFICATION_CONFIG } from './notification/notification.service';
import { NotificationSendService } from './notification/send.service';
import { BuyerNotifier } from './notification/buyer-notifier';
import { NotificationSweepService } from './notification/sweep.service';
import { OperationsController } from './operations/operations.controller';
import { CustomerController } from './customer/customer.controller';
import { CreatorOperationsController } from './catalog/creator-operations.controller';
import { CreatorOperationsService } from './catalog/creator-operations.service';
import { CustomerSupportService } from './customer/customer.service';
import { OperationsDashboardService } from './operations/dashboard.service';
import { AdminOperationsAlertController } from './operations/alert.controller';
import {
  ALERT_CONFIG,
  OperationsAlertService,
  type AlertConfig,
  type AlertWebhookCipher,
} from './operations/alert.service';
import { ProductionController } from './production/production.controller';
import { ProductionReadinessService } from './production/readiness.service';
import { MailCheckService, type MailTestSender } from './production/mail-check.service';
import {
  AdminSettlementController,
  SETTLEMENT_CONFIG,
  type SettlementConfig,
} from './settlement/settlement.controller';
import { AdminPayoutController } from './settlement/payout.controller';
import {
  AdminCreatorDirectoryController,
  AdminSalesReportController,
} from './reporting/reporting.controller';
import {
  REPORTING_CONFIG,
  ReportingService,
  type ReportingConfig,
} from './reporting/reporting.service';
import {
  CreatorProfileController,
  PROFILE_CONFIG,
  type ProfileConfig,
} from './catalog/profile.controller';
import { PAYOUT_CONFIG, PayoutService, type PayoutConfig } from './settlement/payout.service';
import { CheckoutService } from './order/checkout.service';
import { PaymentWebhookService } from './order/webhook.service';
import { PaymentWebhookController } from './order/webhook.controller';
import {
  INTERNAL_JOB_CONFIG,
  InternalJobsController,
  type InternalJobConfig,
} from './order/internal-jobs.controller';
import {
  AdminLegalController,
  LegalConsentController,
  PublicLegalController,
} from './legal/legal.controller';
import { LegalService } from './legal/legal.service';
import { LegalRevisionNoticeService } from './legal/legal-revision-notice.service';
import { PaymentCredentialController } from './payment-credential/payment-credential.controller';
import {
  PaymentCredentialService,
  type PaymentCredentialConfig,
} from './payment-credential/payment-credential.service';
import { AuditLogController } from './audit/audit.controller';
import { AuditLogQueryService } from './audit/audit.service';
import { HealthController } from './health/health.controller';
import { HealthService, type DependencyProbe } from './health/health.service';

/**
 * アプリケーションが必要とする外部依存。
 *
 * 具体的な実装クラスではなく**ポート**を受け取る。
 * こうしておくと、テストからは Fake を、本番からは Prisma 実装を差し込める。
 * DI コンテナに実装クラスを直接登録すると、
 * コントローラのテストのたびに実 DB が必要になってしまう。
 */
export interface AppDependencies {
  readonly version: string;
  readonly probes?: readonly DependencyProbe[];
  readonly artworks: ArtworkRepository;
  readonly listings: ListingRepository;
  readonly accounts: AccountLookupPort;
  /** 運営スタッフの在籍と招待（`UD-803`）。 */
  readonly staffMembers: StaffMemberRepository;
  readonly staffInvitations: StaffInvitationRepository;
  /**
   * 外部連携の設定と資格情報（管理画面・外部連携 指示書）。
   *
   * ⚠️ **暗号鍵が無い環境では渡さない。** 「渡すが中で落ちる」形にすると、
   * 設定画面を開いた人に 500 が返るだけで、原因が鍵の欠けだと分からない。
   * 経路ごと生やさないほうが、起動ログで気付ける。
   */
  readonly integrations?: {
    /**
     * 接続先へ届くかどうかを確かめる手段（指示書 §4.3・要決定 06）。
     *
     * ⚠️ **業務データを送る実装を渡さない。** 相手は受取権を作る口で、
     * 試し打ちしてよい相手ではない。安全なテスト手段が確認できるまで、
     * 本文を持たない確認だけにする。
     */
    readonly probe: (
      endpointUrl: string,
      timeoutMs: number,
    ) => Promise<{ readonly outcome: ProbeOutcome; readonly durationMs: number }>;
    /**
     * 配備環境から読める、その連携の姿。
     *
     * ⚠️ **値を返させない。** 返すのは方式と、欠けている設定の**名前**まで。
     * ここが値を返す形になった瞬間、秘密が API の応答へ届く道ができる。
     */
    readonly describeEnvironment: (service: IntegrationServiceName) => EnvIntegrationSummary;
    /**
     * 決済の配備側の状態。
     *
     * ⚠️ **鍵そのもの・先頭・末尾を返させない。** 返すのは
     * 「設定されているか」「テストか本番か」「最後に知らせが届いた時刻」まで。
     */
    readonly describePaymentDeployment: () => Promise<PaymentDeploymentStatus>;
    readonly repository: IntegrationRepository & {
      ensureSettings(
        id: string,
        service: IntegrationServiceName,
        environment: IntegrationEnvironment,
      ): Promise<IntegrationSettings>;
    };
    /** このプロセスがどの環境か。⚠️ 設定の `environment` とは別物。 */
    readonly appEnvironment: IntegrationEnvironment;
  };
  /**
   * 送信の運用画面（管理画面・外部連携 指示書 §5）。
   *
   * ⚠️ **読む口と送り直す口を分けて受け取る。** 読む口は本文を返さない型で、
   * 送り直す口は状態を戻すだけ。ひとつにまとめると、画面向けの経路から
   * 本文へ手が届いてしまう。
   *
   * ⚠️ **無い環境では経路ごと生やさない。** 「渡すが中で落ちる」形にすると、
   * 開いた人に 500 が返るだけで、原因が配線の欠けだと分からない。
   */
  readonly walletDeliveries?: {
    readonly admin: WalletDeliveryAdminPort;
    readonly outbox: Pick<WalletDeliveryOutboxPort, 'requeue'>;
  };
  /** 監査ログの閲覧（指示書 §5）。 */
  readonly auditLogs?: AuditLogReadPort;
  /**
   * 法務文書（利用規約・プライバシーポリシー・特商法表記）。
   *
   * ⚠️ **無い環境では経路ごと生やさない。** 公開ページの口だけが開いて
   * 500 を返すより、404 のほうが原因が分かる。
   */
  /**
   * 決済資格情報の世代（`UD-118`）。
   *
   * ⚠️ **暗号鍵が無い環境では渡さない。** 「渡すが中で落ちる」形にすると、
   * 画面を開いた人に 500 が返るだけで、原因が鍵の欠けだと分からない。
   */
  readonly paymentCredentials?: {
    readonly repository: PaymentCredentialRepository;
    readonly cipher: SecretCipherPort;
    readonly config: PaymentCredentialConfig;
  };
  readonly legalDocuments?: {
    readonly documents: LegalDocumentRepository;
    /** 規約への同意（`UD-126`）。 */
    readonly consents: LegalConsentRepository;
  };
  readonly idempotency: IdempotencyStore;
  /**
   * 注文と在庫の仮引当（決済 Phase P0・P1）。
   *
   * ⚠️ **手数料率をここで受け取る。** ブラウザからは受け取らない
   * （指示書 §4.2）。既定 0 は「まだ決めていない」の意味で、
   * 決定ではない（`UD-109`）。
   *
   * ⚠️ `internalJobToken` が無ければ内部ジョブの経路を生やさない。
   * 「未設定なら素通し」にすると、設定を忘れた環境で外から在庫を操作できる。
   */
  readonly orders: {
    readonly repository: OrderRepository;
    /** 問い合わせの対応メモ（`UD-121`）。⚠️ 追記のみ。 */
    readonly notes: OrderNoteRepository;
    readonly commonUserLinks: CommonUserLinkRepository;
    readonly random: RandomPort;
    /** ⚠️ 呼び出しのたびに引く。管理画面で変えたら次の注文から効く。 */
    readonly resolvePlatformFeeRateBps: () => Promise<number>;
    /**
     * 注文時点で施行されていた規約の版（`UD-126`）。
     *
     * ⚠️ **同意を確かめる口ではない。** 注文へ「何が表示されていたか」を
     * 残すためだけに引く。未公開なら `null` を返し、**注文を止めない**。
     */
    readonly resolveEffectiveTerms: () => Promise<{
      readonly id: string;
      readonly version: number;
    } | null>;
    readonly reservationMinutes: number;
    readonly internalJobToken?: string | undefined;
  };
  /**
   * 決済（決済 Phase P2）。
   *
   * ⚠️ **無い環境では経路ごと生やさない。** 「渡すが中で落ちる」形にすると、
   * 鍵の設定を忘れた環境で Webhook の口だけが開き、署名を確かめずに
   * 受けるか全部拒否するかのどちらかになる。前者は誰でも
   * 「決済成功」を送れる。
   */
  readonly payments?: {
    readonly gateway: PaymentGatewayPort;
    readonly repository: PaymentRepository;
    readonly provider: string;
    /** この配備が本番の決済を扱うか。⚠️ 事業者の `livemode` と突き合わせる。 */
    readonly expectLivemode: boolean;
    /**
     * 返金を受け付ける期限を決める（`UD-104`）。
     *
     * ⚠️ **決済確定のたびに引く。** 引いた値は注文へ焼き付けられるので、
     * あとから設定を変えても過去の注文は動かない。
     */
    readonly resolveRefundableUntil: (paidAt: Date) => Promise<Date | null>;
    readonly logger: Logger;
  };
  readonly tokenVerifier: TokenVerifierPort;
  /**
   * 照合用のメール値を作る口（`UD-121`）。
   *
   * ⚠️ **省略できない。** 「無ければ素のハッシュ」という逃げ道を作ると、
   * 配備によって保護の強さが変わる。鍵の無い配備でも実装は渡し、
   * その実装が `null` を返す形にしてある。
   */
  readonly emailHasher: EmailHashPort;
  /**
   * 返金と精算の設定（`UD-104` / `UD-119`）。
   *
   * ⚠️ **省略できない。** 無いと返金の期限が付かず、購入者都合の返金が
   * 一切通らなくなる。それに気づくのは問い合わせが来たとき。
   */
  readonly settlement: SettlementSettingsRepository;
  /**
   * 返金の記録（`UD-104` / `UD-120`）。
   *
   * ⚠️ **省略できない。** 無いと、事業者の画面から返金されたときに
   * 追随できず、返金済みの注文が「お支払い済み」のまま精算に乗る。
   */
  readonly refunds: RefundRepository;
  /**
   * 返金の申請と審査（方針整理 2026-08-22）。
   *
   * ⚠️ **`refunds` と別に持つ。** あちらは**決済事業者へ投げた返金**の
   * 記録で、こちらは**その手前の手続き**である。1 つにまとめると、
   * 投げていない申し出と投げた返金が同じ表に混ざる。
   *
   * ⚠️ **省略できない。** 無いと、購入者からの申し出を受ける口が無く、
   * 返金は運営が注文の画面から直接押す形だけになる——審査の記録が
   * どこにも残らない。
   */
  /**
   * チャージバック（決済の争い・2026-08-22）。
   *
   * ⚠️ **`null` は「争いを受けない」を意味する。** 受けない配備では、
   * 受けたことを `webhook_events` に残すだけで先へ進まない。あとから
   * 配線したときに、取りこぼした知らせを追える形にしてある。
   */
  readonly disputes?: DisputePort | null | undefined;
  readonly refundRequests: {
    readonly requests: RefundRequestPort;
    readonly inquiries: CreatorInquiryPort;
    readonly receivables: CreatorReceivablePort;
    /** ⚠️ 行が無ければ `null` を返す実装であること（既定値で埋めない）。 */
    readonly policy: RefundPolicyPort;
  };
  /**
   * 受取権の発行（P0-1）。
   *
   * ⚠️ **省略できない。** 無いと、決済が済んだ注文から受取権が生まれず、
   * Claim も Wallet 配送も一度も動かない。
   */
  readonly issuance: EntitlementIssuanceRepository;
  /**
   * ご自分が受け取ったもの（P0-3）。
   *
   * ⚠️ **省略できない。** 無いと、買った方が自分の持ち物を確かめられない。
   */
  readonly collectibles: CollectibleRepository;
  /**
   * 作家さまへの精算（`UD-119`）。
   *
   * ⚠️ **省略できない。** 無いと締めも確定もできず、作家さまへの
   * お支払いが記録として残らない。
   */
  readonly payouts: PayoutRepository;
  /**
   * 運営の売上レポートと作家さまの一覧（`UD-123` / `UD-124` の一部）。
   *
   * ⚠️ **読み取りだけの口である。** ここに「直す」実装を足さない。
   */
  readonly reporting: {
    readonly sales: SalesReportPort;
    readonly creators: CreatorDirectoryPort;
  };
  /**
   * 作家さまの表示名（決定 2026-08-20）。
   *
   * ⚠️ **省略できない。** 無いと名乗れず、公開ページで作家さまが
   * 匿名のままになる。
   */
  readonly profiles: CreatorProfileRepository;
  /**
   * 運用確認キュー（M3a）。
   *
   * ⚠️ **省略できない。** 無いと、機械が決められなかったことが
   * ログだけになり、忙しい日にそのまま埋もれる。
   */
  readonly operationsReviews: OperationsReviewRepository;
  /**
   * 全額返金にともなう取消（M3a）。**3 つに分かれている。**
   *
   * ⚠️ **1 つにまとめない。** 止めたい対象が 3 段あるため
   * （業務方針そのもの／作るか／送るか）。
   */
  readonly revocation?: {
    /**
     * 受取済み（`claimed`）も取り消すか（`UD-104` 追補）。
     *
     * ⚠️ 偽のあいだは従来どおり未受取だけを取り消す。
     */
    readonly revokeClaimed: boolean;
    /**
     * 取消イベントを作るか。
     *
     * ⚠️ **日次の補完もこのフラグに従う。** 従わせないと、無効へ戻したのに
     * 時計が作り続ける。
     */
    readonly generationEnabled: boolean;
    /** 取りこぼしを埋めるための読み取り。 */
    readonly reconcile: RevocationReconcileRepository;
    /** 取消の知らせを積む先。 */
    readonly outbox: WalletDeliveryOutboxPort;
    readonly logger: Logger;
  };
  /**
   * 購入者への知らせ（P0-4）。
   *
   * ⚠️ **省略できない。** 省略できるようにすると、知らせの無い配備が
   * 「正常」に見える。買った方から見ると、何も届かないのは異常である。
   */
  readonly notification: {
    readonly templates: NotificationTemplateRepository;
    readonly outbox: NotificationOutboxPort;
    readonly history: NotificationHistoryPort;
    /**
     * 知らせを**作る**か。
     *
     * ⚠️ **送るかどうかとは別の軸。** まとめると、送信だけ止めたい場面で
     * 生成まで止まり、止めていたあいだの注文が永久に知らされなくなる。
     */
    readonly generationEnabled: boolean;
    readonly siteName: string;
    readonly siteUrl: string;
    /**
     * 実際に送る側。
     *
     * ⚠️ **`undefined` は「まだ送らない」を意味する。** 積むところまでは
     * 動かし、送信だけを止められるようにしてある。
     */
    readonly delivery?: {
      readonly recipients: RecipientResolverPort;
      readonly mailer: MailSenderPort;
    };
    /**
     * 「届いた」「止まっている」を数え上げる口。
     *
     * ⚠️ **省略できる。** 数え上げなくても、注文・決済・返金の知らせは
     * 従来どおり積まれる。ここが無いのはお届け結果の知らせだけ。
     */
    readonly sweepSource?: {
      listDeliveredWithoutNotice(limit: number): Promise<readonly NotifiableEntitlementRow[]>;
      listStalledWithoutNotice(limit: number): Promise<readonly NotifiableEntitlementRow[]>;
    };
    readonly logger: Logger;
  };
  /**
   * 運営ダッシュボード（P0-6）。
   *
   * ⚠️ **省略できない。** 省略できるようにすると、指標の見えない配備が
   * 「正常」に見える。止まっていることに誰も気づけない状態そのものが、
   * この機能で塞ぎたかった穴である。
   */
  readonly operations: {
    readonly repository: OperationsMetricsPort;
    readonly entitlements: EntitlementAdminPort;
    readonly thresholds: OperationsThresholds;
    /** 見る対象の時計仕掛け。⚠️ 記録が無くても項目は出す。 */
    readonly jobKeys: readonly string[];
    /**
     * 人が意図して止めている時計仕掛け（2026-08-22）。
     *
     * ⚠️ **`jobKeys` から引かない。** 引くと画面から項目ごと消え、
     * 「止めている」ではなく「そんな処理は無い」に見える。
     */
    readonly pausedJobKeys?: readonly string[];
    /**
     * 運営への知らせ（`UD-1102` の一部）。
     *
     * ⚠️ **省略できる。** 繋いでいない配備がある。必須にすると、そこで
     * 起動しなくなる。画面は「この配備では知らせを送れません」と断る。
     */
    readonly alerts?: {
      readonly settings: OperationsAlertSettingsPort;
      /** 状況の画面の URL。⚠️ 知らせに載せる唯一のリンク。 */
      readonly dashboardUrl: string;
      /** ⚠️ どちらも `null` になりうる（送る口が無い配備）。 */
      readonly mailer: MailTestSender | null;
      readonly webhook: AlertWebhookPort | null;
      readonly cipher: AlertWebhookCipher | null;
    };
  };
  /**
   * 本番販売ガード（P0-7）。
   *
   * ⚠️ **省略できる形にしていない。** 省略できると、繋ぎ忘れた配備で
   * ガードごと消える——**それは「売ってよい」と判定するのと同じ**である。
   * 判定に要る事実を集められない配備は、そもそも本番で売れない。
   */
  readonly production: {
    readonly readiness: ProductionReadinessPort;
    readonly attestations: AttestationPort;
    /** ⚠️ このプロセスの環境。要求から受け取らない。 */
    readonly environment: IntegrationEnvironment;
    readonly thresholds: ProductionReadinessThresholds;
    /** メールの試し送り。⚠️ 持たない配備では `null`（押されたら断る）。 */
    readonly mailTestSender: MailTestSender | null;
  };
  /**
   * 顧客サポート（P1-1）。
   *
   * ⚠️ **付け替えの口をここに足さない。** 注文・受取権・ウォレットの
   * 持ち主を人が変えられる依存は、この形に存在しない。
   */
  readonly customers: {
    readonly directory: CustomerDirectoryPort;
    readonly notes: AccountNotePort;
    readonly emailChanges: EmailChangeRequestPort;
    /**
     * ご連絡先を取り寄せる口（決定 2026-08-21）。
     *
     * ⚠️ **省略できる。** 認証基盤へ繋いでいない配備では、応対の画面は
     * 「この配備では取り寄せられません」と断る。**必須にすると起動しない。**
     *
     * ⚠️ **知らせの送信（`notification.delivery`）とは別の軸。** 送信を
     * 止めている配備でも、問い合わせ対応でご連絡先は要る。まとめると、
     * 送信を止めた日から応対ができなくなる。
     */
    readonly recipients?: RecipientResolverPort;
  };
  /**
   * 作家さま運営（P1-2）。
   *
   * ⚠️ **誰の分かを要求から受け取る口を、この形に足さない。** 売上は
   * その方の商いの中身そのもので、他人が覗いてよいものではない。
   */
  readonly creatorOperations: {
    readonly profiles: CreatorProfilePort;
    readonly earnings: CreatorEarningsPort;
    /**
     * お振込先（P1-3・`UD-124` 決定 2026-08-21）。
     *
     * ⚠️ **省略できる。** 暗号鍵を設定していない配備では預かれない。
     * **必須にすると、そこで起動しなくなる。** 画面は
     * 「まだご登録いただけません」と断る。
     */
    readonly payoutAccounts?: {
      readonly store: PayoutAccountPort;
      readonly cipher: PayoutAccountCipherPort;
    };
  };
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly storage: StoragePort;
  readonly audit: AuditLogPort;
  readonly generateStorageKey: StorageKeyFactory;
  /** 画像の内容ハッシュ計算。実装は `@sengoku/integrations` の `contentHash`。 */
  readonly hashContent: ContentHasher;
  /**
   * Claim（OVEW Wallet 連携）。
   *
   * ⚠️ **既定は無効。** 有効化するのは、相手側の署名器が v1.1 FINAL へ揃い、
   * 固定ベクトルが両システムで一致してから。
   */
  readonly claim?: {
    readonly enabled: boolean;
    readonly claims: ClaimTokenRotationSource;
    readonly tokens: ClaimTokenPort;
    readonly verifier: SenNoKuniHmacVerifier | null;
    readonly logger: Logger;
    readonly rateLimiter: RateLimiterPort;
    /** 1 分あたりの上限（鍵IDごと）。用途で枠を分ける。 */
    readonly getPerMinute: number;
    readonly postPerMinute: number;
    /** 受取ページの前置き。末尾のスラッシュを含めない。 */
    readonly claimBaseUrl: string;
    /**
     * Wallet への配送を有効にするか。
     *
     * ⚠️ **Claim 本体とは別のフラグ。**
     * 有効にすると、受取確定と同時に配送本文が組み立てられ、
     * 組み立てられない作品（長期URLの画像が無い等）は受取が失敗する。
     * 画像の長期URL（Cloudflare R2）が整うまでは無効のままにする。
     */
    readonly deliveryEnabled: boolean;
  };
}

/**
 * アプリケーションのルートモジュール。
 *
 * 機能ごとにコントローラを分けてあるので、
 * Phase 3 以降で注文・受取を足してもここが肥大化しない。
 */
/**
 * 画像アップロードで受け付ける本文の上限。
 *
 * ドメイン側の上限（5MB）より少し大きくしてある。
 * ここで先に切ると Express 既定の 413（HTML）が返り、
 * 統一したエラー契約から外れてしまうため、
 * **判定はドメイン側に任せて、こちらは暴走を止めるだけ**にする。
 */
const RAW_BODY_LIMIT = '8mb';

@Module({})
export class AppModule implements NestModule {
  /**
   * 画像は生のバイト列で受け取る。
   *
   * JSON パーサに通さないのは、画像をテキストとして解釈させないため。
   * 対象を画像の MIME に限定しているので、他のエンドポイントには影響しない。
   */
  configure(consumer: MiddlewareConsumer): void {
    // ⚠️ **すべての経路へ最初に適用する。**
    //    ここより後に置いたミドルウェアのログにも相関IDが乗る。
    consumer.apply(CorrelationMiddleware).forRoutes('*');
    consumer
      .apply(express.raw({ type: ['image/*', 'application/octet-stream'], limit: RAW_BODY_LIMIT }))
      .forRoutes('api/v1/admin/artworks/:id/image', 'api/v1/creator/artworks/:id/image');
  }

  static register(deps: AppDependencies): DynamicModule {
    // ⚠️ **依存が無いときは、経路ごと生やさない。**
    //    「登録はするが呼ばれたら落ちる」形にすると、Nest は起動時に
    //    すべての provider を作るため、Claim を使わない構成まで道連れに落ちる。
    //    実際にそれで既存の API テストが全滅した。
    const claim = deps.claim;
    const integrations = deps.integrations;
    const walletDeliveries = deps.walletDeliveries;
    const auditLogs = deps.auditLogs;
    const legalDocuments = deps.legalDocuments;
    const paymentCredentials = deps.paymentCredentials;
    const internalJobToken = deps.orders.internalJobToken;
    const payments = deps.payments;
    /*
      取消の本文を組み立てる道具（M3a）。
      ⚠️ **フラグに関係なく作る。** 状態を持たず、外部にも触れない。
         作るかどうかを決めるのは、これを**渡すかどうか**の側。
    */
    const revokePlanner = new WalletRevokePlanner(deps.hashContent);
    const revocation = deps.revocation;
    return {
      module: AppModule,
      controllers: [
        HealthController,
        CatalogController,
        PublicListingController,
        AdminCatalogController,
        CreatorCatalogController,
        StaffController,
        StaffInvitationAcceptController,
        OrderController,
        AdminOrderController,
        // 返金と精算の設定（`UD-104` / `UD-119`）。⚠️ 変更はオーナー限定。
        AdminSettlementController,
        AdminPayoutController,
        // 返金の申請と審査（方針整理 2026-08-22）。
        AdminRefundRequestController,
        BuyerRefundRequestController,
        CreatorRefundInquiryController,
        // 運営の売上レポートと作家さまの一覧（`UD-123` / `UD-124` の一部）。
        AdminSalesReportController,
        AdminCreatorDirectoryController,
        // 自分の表示名（決定 2026-08-20）。⚠️ 自分の分しか触れない。
        CreatorProfileController,
        // ご自分が受け取ったもの（P0-3）。⚠️ 自分の分しか見えない。
        CollectibleController,
        ...(internalJobToken === undefined || internalJobToken === ''
          ? []
          : [InternalJobsController]),
        ...(payments === undefined ? [] : [CheckoutController, PaymentWebhookController]),
        ...(integrations === undefined ? [] : [IntegrationController]),
        ...(walletDeliveries === undefined ? [] : [WalletDeliveryController]),
        ...(auditLogs === undefined ? [] : [AuditLogController]),
        ...(legalDocuments === undefined
          ? []
          : [PublicLegalController, AdminLegalController, LegalConsentController]),
        ...(paymentCredentials === undefined ? [] : [PaymentCredentialController]),
        ...(claim === undefined ? [] : [ClaimController, ClaimReissueController]),
        // 運用確認キュー（M3a）。⚠️ 積む口は無く、読むのと印を付けるだけ。
        OperationsReviewController,
        // 知らせの文面と送信履歴（P0-4）。⚠️ 積む口も送る口もここには無い。
        NotificationController,
        // 運営ダッシュボード（P0-6）。⚠️ 見るのと動かすので権限が違う。
        OperationsController,
        // 運営への知らせ（`UD-1102` の一部）。
        AdminOperationsAlertController,
        // 本番販売ガード（P0-7）。⚠️ 判定そのものは支払い口を作る側が行う。
        ProductionController,
        CustomerController,
        CreatorOperationsController,
      ],
      providers: [
        {
          provide: HealthService,
          useFactory: () => new HealthService(deps.version, deps.probes ?? []),
        },
        {
          provide: CatalogService,
          useFactory: () =>
            new CatalogService(deps.artworks, deps.listings, deps.clock, deps.storage),
        },
        {
          provide: AdminCatalogService,
          useFactory: () =>
            new AdminCatalogService(
              deps.artworks,
              deps.listings,
              deps.ids,
              deps.clock,
              deps.storage,
              deps.audit,
            ),
        },
        {
          provide: CreatorCatalogService,
          useFactory: (admin: AdminCatalogService) =>
            // ⚠️ 業務規則は `AdminCatalogService` を通す。所有権だけを足す。
            new CreatorCatalogService(admin, deps.artworks, deps.listings),
          inject: [AdminCatalogService],
        },
        {
          provide: ArtworkImageService,
          useFactory: () =>
            new ArtworkImageService(
              deps.artworks,
              deps.storage,
              deps.generateStorageKey,
              deps.audit,
              deps.hashContent,
            ),
        },
        {
          // 返金と精算の設定（`UD-104` / `UD-119`）。
          // ⚠️ 変えられるのは「これから」だけ。過去の記録は焼き付けてある。
          provide: SETTLEMENT_CONFIG,
          useFactory: (): SettlementConfig => ({
            repository: deps.settlement,
            // ⚠️ 環境はプロセスに固定する。要求から受け取れるようにすると、
            //    本番から staging を書き換えられる。
            appEnvironment: deps.integrations?.appEnvironment ?? 'staging',
            audit: deps.audit,
          }),
        },
        {
          provide: PROFILE_CONFIG,
          useFactory: (): ProfileConfig => ({
            repository: deps.profiles,
            audit: deps.audit,
          }),
        },
        {
          // 精算（`UD-119`）。⚠️ 金額を人が書き換える口を足さないこと。
          provide: PAYOUT_CONFIG,
          useFactory: (): PayoutConfig => ({
            repository: deps.payouts,
            settings: deps.settlement,
            // ⚠️ 環境はプロセスに固定する。要求から受け取らない。
            appEnvironment: deps.integrations?.appEnvironment ?? 'staging',
            clock: deps.clock,
            ids: deps.ids,
            audit: deps.audit,
            /*
              お振込先（決定 2026-08-21）。
              ⚠️ **作家さま向けと同じ組を渡す。** 2 つ持つと、鍵を
                 入れ替えるときに片方だけ古いままになる。
              ⚠️ **`null` は「この配備では預かる仕組みが無い」。** 画面は
                 「この配備では読み取れません」と断る。
            */
            payoutAccounts: deps.creatorOperations.payoutAccounts ?? null,
          }),
        },
        PayoutService,
        {
          /*
            返金の申請と審査（方針整理 2026-08-22）。

            ⚠️ **`RefundService` を包む形にする。** 決済事業者へ投げる処理を
               2 つ持つと、片方だけ直したときに在庫の戻しや受取権の
               取り消しが食い違う。
          */
          provide: REFUND_REQUEST_CONFIG,
          useFactory: (): RefundRequestConfig => ({
            requests: deps.refundRequests.requests,
            inquiries: deps.refundRequests.inquiries,
            receivables: deps.refundRequests.receivables,
            policy: deps.refundRequests.policy,
            orders: deps.orders.repository,
            refunds: deps.refunds,
            // ⚠️ 環境はプロセスに固定する。要求から受け取らない。
            appEnvironment: deps.integrations?.appEnvironment ?? 'staging',
            clock: deps.clock,
            ids: deps.ids,
            audit: deps.audit,
            logger: payments?.logger ?? SILENT_LOGGER,
          }),
        },
        {
          /*
            ⚠️ **知らせを渡す。** 渡さないと、作家さまは事実確認が来たことに
               ログインするまで気づけない——ご回答の期限は営業日で進むのに。
          */
          provide: RefundRequestService,
          inject: [REFUND_REQUEST_CONFIG, RefundService, BuyerNotifier],
          useFactory: (
            config: RefundRequestConfig,
            refunds: RefundService,
            notifier: BuyerNotifier,
          ) => new RefundRequestService(config, refunds, notifier),
        },
        {
          // 運営の売上レポートと作家さまの一覧（`UD-123` / `UD-124` の一部）。
          provide: REPORTING_CONFIG,
          useFactory: (): ReportingConfig => ({
            sales: deps.reporting.sales,
            creators: deps.reporting.creators,
            // ⚠️ 紹介文とインボイス番号は作家さま運営の側から読む。
            //    同じ表を 2 つの実装で読まない。
            profiles: deps.creatorOperations.profiles,
            payouts: deps.payouts,
            clock: deps.clock,
          }),
        },
        ReportingService,
        {
          /*
            ご自分が受け取ったもの（P0-3）。

            ⚠️ **管理側の読み取りモデルを流用していない。** あちらは購入者・
               金額・手数料まで載る。流用すると、画面に出さないつもりの値が
               応答には載っている状態になる。
          */
          provide: COLLECTIBLE_CONFIG,
          useValue: {
            repository: deps.collectibles,
            storage: deps.storage,
          } satisfies CollectibleConfig,
        },
        {
          /*
            受取権の発行（P0-1）。

            ⚠️ **決済を繋いでいない配備でも配る。** 掃き出しの口と、
               受取権の件数と在庫カウンタの突き合わせは、決済に依らず要る。
          */
          provide: ISSUANCE_CONFIG,
          useValue: {
            repository: deps.issuance,
            audit: deps.audit,
            clock: deps.clock,
          } satisfies IssuanceConfig,
        },
        EntitlementIssuanceService,
        {
          /*
            返金の実行（`UD-104` / `UD-120`）。
            ⚠️ **決済を繋いでいない配備でも配る。** 返金の記録を読む口
               （`GET :id/refunds`）は決済に依らず要る。投げる先が無い
               ときは、送信の直前で断る（黙って成功にしない）。
          */
          provide: RefundService,
          inject: [BuyerNotifier],
          useFactory: (notifier: BuyerNotifier) =>
            new RefundService(
              deps.refunds,
              payments?.gateway ?? null,
              deps.clock,
              deps.ids,
              deps.audit,
              /*
                ⚠️ **決済を繋いでいない配備では書き出さない。** この経路で
                   ログに載るのは注文IDと符号だけだが、送る先が無い配備で
                   出力を増やす理由も無い。
              */
              payments?.logger ?? SILENT_LOGGER,
              /*
                受取済みも取り消すか（`UD-104` 追補）。
                ⚠️ **既定は偽。** 設定していない配備の振る舞いを変えない。
              */
              deps.revocation?.revokeClaimed ?? false,
              /*
                取消イベントの組み立て。
                ⚠️ **生成フラグが無効なら `null`。** 渡さないのではなく
                   `null` を渡す——Nest の任意注入は `undefined` を渡してくるため、
                   境界で必ずどちらかへそろえる（P0-2 で同型の不具合を出した）。
              */
              deps.revocation?.generationEnabled === true ? revokePlanner.plan : null,
              deps.operationsReviews,
              // ご返金の受付と完了を買った方へ知らせる（P0-4）。
              notifier,
            ),
        },
        {
          // 運用確認キューの読み書き（M3a）。⚠️ 積む口はここに無い。
          provide: OperationsReviewService,
          useFactory: () =>
            new OperationsReviewService(deps.operationsReviews, deps.clock, deps.audit),
        },
        /*
          購入者への知らせ（P0-4）。
          ⚠️ **設定を `Symbol` で注入する。** interface は実行時に消えるので、
             Nest は型では解決できない。
        */
        {
          provide: NOTIFICATION_CONFIG,
          useValue: {
            generationEnabled: deps.notification.generationEnabled,
            siteName: deps.notification.siteName,
            siteUrl: deps.notification.siteUrl,
          },
        },
        {
          provide: NotificationService,
          useFactory: () =>
            new NotificationService(
              deps.notification.templates,
              deps.notification.outbox,
              deps.ids,
              deps.clock,
              deps.notification.logger,
              {
                generationEnabled: deps.notification.generationEnabled,
                siteName: deps.notification.siteName,
                siteUrl: deps.notification.siteUrl,
              },
            ),
        },
        {
          provide: BuyerNotifier,
          inject: [NotificationService],
          useFactory: (notifications: NotificationService): BuyerNotifier =>
            new BuyerNotifier(notifications, {
              siteUrl: deps.notification.siteUrl,
            }),
        },
        ...(deps.notification.sweepSource === undefined
          ? []
          : [
              {
                provide: NotificationSweepService,
                inject: [BuyerNotifier],
                useFactory: (notifier: BuyerNotifier): NotificationSweepService =>
                  new NotificationSweepService(deps.notification.sweepSource!, notifier),
              },
            ]),
        {
          provide: ProductionReadinessService,
          useFactory: (): ProductionReadinessService =>
            new ProductionReadinessService(
              deps.production.readiness,
              deps.production.attestations,
              deps.clock,
              deps.audit,
              deps.production.environment,
              deps.production.thresholds,
            ),
        },
        {
          provide: MailCheckService,
          /*
            ⚠️ **`optional`。** 外部連携の設定一式は、暗号鍵を持たない配備には
               存在しない。必須にすると、鍵の無い配備で**起動そのものが落ちる**
               ——実際に e2e がそれで落ちた（2026-08-21）。
            ⚠️ **見つからない依存に Nest が渡すのは `undefined`。** `null` では
               ないので、境界で揃える。
          */
          inject: [{ token: IntegrationService_, optional: true }],
          useFactory: (integrations: IntegrationService_ | undefined): MailCheckService =>
            new MailCheckService(
              integrations ?? null,
              deps.staffMembers,
              deps.clock,
              deps.audit,
              deps.production.environment,
              deps.production.mailTestSender,
            ),
        },
        {
          provide: CreatorOperationsService,
          /*
            ⚠️ **見込みは `PayoutService` を通す。** 締めるときと同じ関数を
               使うことが、この画面の唯一の存在理由である。別に計算する
               口をここへ足さないこと。
          */
          /*
            ⚠️ **知らせは `optional`。** 繋いでいない配備では provider ごと
               存在しない。必須にすると、そこで起動しなくなる。
          */
          inject: [PayoutService, { token: NotificationService, optional: true }],
          useFactory: (
            payoutService: PayoutService,
            notifications: NotificationService | undefined,
          ): CreatorOperationsService =>
            new CreatorOperationsService(
              payoutService,
              deps.payouts,
              deps.creatorOperations.earnings,
              deps.creatorOperations.profiles,
              deps.profiles,
              /*
                ⚠️ **`null` は「この配備では同意を確かめられない」。** 法務
                   文書の仕組みを繋いでいない配備がある。繋いでいなければ
                   「未同意」として出す——**同意したことにしない**。
              */
              deps.legalDocuments?.consents ?? null,
              deps.settlement,
              deps.storage,
              deps.integrations?.appEnvironment ?? 'staging',
              deps.clock,
              deps.audit,
              /*
                お振込先（P1-3）。
                ⚠️ **`null` は「この配備では預かれない」。** 暗号鍵を設定して
                   いない配備がある。必須にすると、そこで起動しなくなる。
                   画面は「まだご登録いただけません」と断る。
              */
              deps.creatorOperations.payoutAccounts ?? null,
              notifications ?? null,
              deps.notification?.siteUrl ?? '',
            ),
        },
        {
          provide: CustomerSupportService,
          /*
            ⚠️ **平文のアドレスを持ち回らない。** 受け取った瞬間に照合値と
               伏せた表記へ変え、元の値は捨てる（`emailHasher` がその境界）。
          */
          useFactory: (): CustomerSupportService =>
            new CustomerSupportService(
              deps.customers.directory,
              deps.customers.notes,
              deps.customers.emailChanges,
              deps.emailHasher,
              deps.clock,
              deps.audit,
              /*
                ⚠️ **`?? null` で正規化する。** 省略されたときに `undefined`
                   が渡ると、`null` を待っている側の判定をすり抜ける。
              */
              deps.customers.recipients ?? null,
            ),
        },
        /*
          運営への知らせ（`UD-1102` の一部）。
          ⚠️ **繋いでいない配備では provider ごと置かない。** 置くと、
             設定はできるのに永久に届かない状態を作れてしまう。
        */
        ...(deps.operations.alerts === undefined
          ? []
          : [
              {
                provide: ALERT_CONFIG,
                useValue: {
                  settings: deps.operations.alerts.settings,
                  metrics: deps.operations.repository,
                  thresholds: deps.operations.thresholds,
                  jobKeys: deps.operations.jobKeys,
                  clock: deps.clock,
                  audit: deps.audit,
                  // ⚠️ 環境はプロセスに固定する。要求から受け取らない。
                  appEnvironment: deps.integrations?.appEnvironment ?? 'staging',
                  dashboardUrl: deps.operations.alerts.dashboardUrl,
                  mailer: deps.operations.alerts.mailer,
                  webhook: deps.operations.alerts.webhook,
                  cipher: deps.operations.alerts.cipher,
                } satisfies AlertConfig,
              },
              OperationsAlertService,
            ]),
        {
          provide: OperationsDashboardService,
          /*
            ⚠️ **やり直しの相手は `optional`。** 発行も配送も、繋いで
               いない配備では provider ごと存在しない。必須にすると起動しない。
               口は生やしたまま「この配備では押せません」と断る。
          */
          inject: [
            EntitlementIssuanceService,
            { token: WalletAutoDeliveryService, optional: true },
          ],
          useFactory: (
            issuance: EntitlementIssuanceService,
            autoDelivery: WalletAutoDeliveryService | undefined,
          ): OperationsDashboardService =>
            new OperationsDashboardService(
              deps.operations.repository,
              deps.operations.entitlements,
              deps.clock,
              deps.audit,
              deps.operations.thresholds,
              deps.operations.jobKeys,
              deps.operations.pausedJobKeys ?? [],
              issuance,
              // ⚠️ `undefined` を `null` へ寄せる（P0-2 で同型の不具合を出した）。
              autoDelivery ?? null,
              // ⚠️ 争いを受けていない配備では `null`。空の一覧を返す。
              deps.disputes ?? null,
            ),
        },
        {
          provide: NotificationAdminService,
          useFactory: () =>
            new NotificationAdminService(
              deps.notification.templates,
              deps.notification.history,
              deps.notification.outbox,
              deps.clock,
              deps.audit,
            ),
        },
        /*
          実際に送る側。
          ⚠️ **送らない配備では provider ごと作らない。** 作っておいて中で
             握りつぶすと、「止めたはずのものが動く」余地が残る。
             口（cron）は生やしたまま 0 件を返す。
        */
        ...(deps.notification.delivery === undefined
          ? []
          : [
              {
                provide: NotificationSendService,
                inject: [{ token: NotificationSweepService, optional: true }],
                useFactory: (
                  sweep: NotificationSweepService | undefined,
                ): NotificationSendService =>
                  new NotificationSendService(
                    deps.notification.outbox,
                    deps.notification.delivery!.recipients,
                    deps.notification.delivery!.mailer,
                    deps.emailHasher,
                    deps.clock,
                    deps.audit,
                    deps.notification.logger,
                    sweep ?? null,
                  ),
              },
            ]),
        /*
          取消の取りこぼしを埋める処理（M3a）。
          ⚠️ **生成フラグが無効なら provider ごと作らない。** 作っておいて
             中で握りつぶすと、「止めたはずのものが別の入口から動く」余地が残る。
             口（cron）は生やしたまま 0 件を返す。
        */
        ...(revocation === undefined || !revocation.generationEnabled
          ? []
          : [
              {
                provide: RevocationReconcileService,
                useFactory: (): RevocationReconcileService =>
                  new RevocationReconcileService(
                    revocation.reconcile,
                    revocation.outbox,
                    deps.operationsReviews,
                    revokePlanner.plan,
                    deps.clock,
                    deps.audit,
                    revocation.logger,
                  ),
              },
            ]),
        {
          // 注文の検索・経過・対応メモ（`UD-121`）。
          // ⚠️ ここは読み取りと追記だけ。状態を変える処理を足さない。
          provide: OrderSupportService,
          useFactory: () =>
            new OrderSupportService(
              deps.orders.repository,
              deps.orders.notes,
              // ⚠️ 決済を繋いでいない配備では null。経過から決済の行が消えるだけ。
              payments?.repository ?? null,
              deps.emailHasher,
              deps.clock,
              deps.ids,
              deps.audit,
            ),
        },
        {
          provide: IdempotencyService,
          useFactory: () => new IdempotencyService(deps.idempotency, deps.clock),
        },
        {
          provide: OrderService,
          inject: [BuyerNotifier],
          useFactory: (notifier: BuyerNotifier) =>
            new OrderService(
              deps.orders.repository,
              deps.listings,
              deps.artworks,
              deps.orders.commonUserLinks,
              // ⚠️ 決済を繋いでいない配備では null。詳細画面が 500 にならない。
              payments?.repository ?? null,
              deps.clock,
              deps.ids,
              deps.orders.random,
              deps.audit,
              {
                resolvePlatformFeeRateBps: deps.orders.resolvePlatformFeeRateBps,
                resolveEffectiveTerms: deps.orders.resolveEffectiveTerms,
                reservationMinutes: deps.orders.reservationMinutes,
              },
              // ご注文を承った知らせ（P0-4）。
              notifier,
            ),
        },
        ...(internalJobToken === undefined || internalJobToken === ''
          ? []
          : [
              {
                provide: INTERNAL_JOB_CONFIG,
                /*
                  ⚠️ **自動配送は `optional` で受け取る。** Wallet へ繋いで
                     いない配備では provider ごと存在しないため、必須にすると
                     起動しない。掃き出しの口は生やしたまま 0 件を返す。
                */
                inject: [
                  { token: WalletAutoDeliveryService, optional: true },
                  { token: RevocationReconcileService, optional: true },
                  { token: NotificationSendService, optional: true },
                  { token: LegalRevisionNoticeService, optional: true },
                  { token: OperationsAlertService, optional: true },
                ],
                useFactory: (
                  autoDelivery: WalletAutoDeliveryService | undefined,
                  revocationReconcile: RevocationReconcileService | undefined,
                  notificationSend: NotificationSendService | undefined,
                  legalRevisionNotices: LegalRevisionNoticeService | null | undefined,
                  operationsAlerts: OperationsAlertService | undefined,
                ): InternalJobConfig => ({
                  token: internalJobToken,
                  /*
                    ⚠️ **`undefined` を `null` へ寄せる。** 見つからない依存に
                       Nest が渡すのは `undefined` で、`null` ではない。
                       受け取る側が `=== null` で見ていると素通りし、
                       無い相手のメソッドを呼んで 500 になる。
                  */
                  autoDelivery: autoDelivery ?? null,
                  operationsAlerts: operationsAlerts ?? null,
                  revocationReconcile: revocationReconcile ?? null,
                  notificationSend: notificationSend ?? null,
                  // ⚠️ 法務文書を繋いでいない配備では provider ごと無い。
                  legalRevisionNotices: legalRevisionNotices ?? null,
                  /*
                    時計仕掛けの生死を記録する先（P0-6）。
                    ⚠️ **`null` にしない。** 記録が無いと、運営の画面では
                       「一度も成功していない」と「そもそも記録していない」が
                       区別できない。
                  */
                  jobRuns: deps.operations.repository,
                  clock: deps.clock,
                }),
              },
            ]),
        ...(payments === undefined
          ? []
          : [
              {
                provide: CheckoutService,
                inject: [ProductionReadinessService],
                useFactory: (productionReadiness: ProductionReadinessService) =>
                  new CheckoutService(
                    deps.orders.repository,
                    payments.repository,
                    payments.gateway,
                    deps.clock,
                    deps.ids,
                    deps.audit,
                    {
                      provider: payments.provider,
                      /*
                        ⚠️ **法務文書を繋いでいない配備では、売らせない。**
                           「確かめられないから通す」にすると、表示義務を
                           果たせないまま販売できてしまう。配線の欠けは
                           運営が直せるが、法に触れた販売は取り消せない。
                      */
                      /*
                        本番販売ガード（P0-7）。
                        ⚠️ **画面を隠すだけにしない。** 管理画面で
                           「準備中」と出しても、この口は直接叩ける。
                      */
                      assertSellable: () => productionReadiness.assertSellable(),
                      canDiscloseCheckoutTerms: async () => {
                        if (legalDocuments === undefined) {
                          return false;
                        }
                        const effective = await legalDocuments.documents.findEffective(
                          'tokushoho',
                          deps.clock.now(),
                        );
                        return canDiscloseCheckoutTerms(effective?.tokushoho ?? null);
                      },
                    },
                  ),
              },
              {
                provide: PaymentWebhookService,
                inject: [
                  RefundService,
                  EntitlementIssuanceService,
                  // ⚠️ Wallet へ繋いでいない配備では存在しない。
                  { token: WalletAutoDeliveryService, optional: true },
                  BuyerNotifier,
                ],
                useFactory: (
                  refundService: RefundService,
                  issuanceService: EntitlementIssuanceService,
                  autoDelivery: WalletAutoDeliveryService | undefined,
                  notifier: BuyerNotifier,
                ) =>
                  new PaymentWebhookService(
                    payments.gateway,
                    payments.repository,
                    deps.orders.repository,
                    deps.clock,
                    deps.ids,
                    deps.audit,
                    payments.logger,
                    {
                      provider: payments.provider,
                      expectLivemode: payments.expectLivemode,
                      resolveRefundableUntil: payments.resolveRefundableUntil,
                    },
                    // ⚠️ 事業者の画面からの返金に追随する（`UD-120`）。
                    refundService,
                    // ⚠️ 決済確定の直後に受取権を作る（P0-1）。
                    issuanceService,
                    // ⚠️ 登録済みの方には、その場で届けにいく（P0-2）。
                    //    ⚠️ 見つからない依存に Nest が渡すのは `undefined`。
                    autoDelivery ?? null,
                    // 決済の結果を買った方へ知らせる（P0-4）。
                    notifier,
                    /*
                      チャージバックを受ける。
                      ⚠️ **Nest が見つからない依存に渡すのは `undefined`。**
                         `?? null` でそろえないと、「受けない」の判定が
                         `null` 比較のままだと素通りする。
                    */
                    deps.disputes ?? null,
                  ),
              },
            ]),
        ...(integrations === undefined
          ? []
          : [
              {
                provide: IntegrationService_,
                useFactory: () =>
                  new IntegrationService_(
                    integrations.repository,
                    deps.ids,
                    deps.clock,
                    deps.audit,
                    integrations.appEnvironment,
                    integrations.probe,
                    integrations.describeEnvironment,
                    integrations.describePaymentDeployment,
                  ),
              },
            ]),
        ...(walletDeliveries === undefined
          ? []
          : [
              {
                provide: WalletDeliveryAdminService,
                useFactory: () =>
                  new WalletDeliveryAdminService(
                    walletDeliveries.admin,
                    walletDeliveries.outbox,
                    deps.clock,
                    deps.audit,
                  ),
              },
            ]),
        ...(auditLogs === undefined
          ? []
          : [
              {
                provide: AuditLogQueryService,
                useFactory: () => new AuditLogQueryService(auditLogs),
              },
            ]),
        ...(paymentCredentials === undefined
          ? []
          : [
              {
                provide: PaymentCredentialService,
                useFactory: () =>
                  new PaymentCredentialService(
                    paymentCredentials.repository,
                    paymentCredentials.cipher,
                    deps.clock,
                    deps.audit,
                    paymentCredentials.config,
                  ),
              },
            ]),
        ...(legalDocuments === undefined
          ? []
          : [
              {
                provide: LegalRevisionNoticeService,
                /*
                  改定の知らせ（`UD-127`）。
                  ⚠️ **知らせの仕組みは `optional`。** 繋いでいない配備が
                     ある。必須にすると、そこで起動しなくなる。
                */
                inject: [{ token: NotificationService, optional: true }],
                useFactory: (
                  notifications: NotificationService | undefined,
                ): LegalRevisionNoticeService | null =>
                  notifications === undefined
                    ? null
                    : new LegalRevisionNoticeService(
                        legalDocuments.documents,
                        notifications,
                        deps.clock,
                        deps.notification?.siteUrl ?? '',
                      ),
              },
              {
                provide: LegalService,
                inject: [LegalRevisionNoticeService],
                useFactory: (notices: LegalRevisionNoticeService | null): LegalService =>
                  new LegalService(
                    legalDocuments.documents,
                    deps.clock,
                    deps.audit,
                    legalDocuments.consents,
                    notices,
                  ),
              },
            ]),
        {
          provide: StaffService,
          useFactory: () =>
            new StaffService(
              deps.staffMembers,
              deps.staffInvitations,
              deps.ids,
              deps.clock,
              deps.audit,
            ),
        },
        ...(claim === undefined
          ? []
          : [
              {
                provide: ClaimService,
                useFactory: (idempotency: IdempotencyService) =>
                  new ClaimService(
                    claim.claims,
                    claim.tokens,
                    deps.clock,
                    idempotency,
                    // 無効なら planner ごと渡さない。「渡すが中で何もしない」に
                    // すると、無効なのに本文を組み立てて落ちる経路が残る。
                    claim.deliveryEnabled
                      ? new WalletDeliveryPlanner(deps.ids, deps.storage, deps.hashContent)
                      : null,
                  ),
                inject: [IdempotencyService],
              },
              /*
                Wallet への自動配送（P0-2）。

                ⚠️ **配送を有効にしていない配備では配らない。** 「渡すが中で
                   何もしない」にすると、無効なのに本文を組み立てて落ちる
                   経路が残る（`ClaimService` の planner と同じ扱い）。
              */
              ...(claim.deliveryEnabled
                ? [
                    {
                      provide: WalletAutoDeliveryService,
                      useFactory: () =>
                        new WalletAutoDeliveryService(
                          claim.claims,
                          new WalletDeliveryPlanner(deps.ids, deps.storage, deps.hashContent),
                          deps.clock,
                          deps.audit,
                        ),
                    },
                  ]
                : []),
              SenNoKuniHmacGuard,
              ClaimRateLimitGuard,
              {
                provide: ReissueService,
                useFactory: () =>
                  new ReissueService(
                    claim.claims,
                    claim.tokens,
                    deps.clock,
                    deps.audit,
                    claim.claimBaseUrl,
                  ),
              },
              {
                provide: CLAIM_RATE_LIMIT_CONFIG,
                useFactory: (): ClaimRateLimitConfig => ({
                  limiter: claim.rateLimiter,
                  clock: deps.clock,
                  getPerMinute: claim.getPerMinute,
                  postPerMinute: claim.postPerMinute,
                }),
              },
              {
                provide: CLAIM_HMAC_CONFIG,
                useFactory: (): ClaimHmacConfig => ({
                  verifier: claim.verifier,
                  clock: deps.clock,
                  logger: claim.logger,
                  // 既定は無効。有効化は相手側の署名器が揃ってから。
                  enabled: claim.enabled,
                }),
              },
            ]),
        {
          // ✅ 認可はガードで一括保護する。ルート個別にチェックを書かない。
          //    グローバル登録なので、新しいエンドポイントを足しても
          //    自動的に保護対象になる（宣言を忘れたら通らない向き）。
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) =>
            new AuthGuard(
              reflector,
              deps.tokenVerifier,
              deps.accounts,
              deps.clock,
              deps.emailHasher,
            ),
          inject: [Reflector],
        },
      ],
    };
  }
}
