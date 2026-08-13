-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('buyer', 'operator', 'auditor');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "ArtworkStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('draft', 'scheduled', 'active', 'suspended', 'ended');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'paid', 'failed', 'expired', 'refunded');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');

-- CreateEnum
CREATE TYPE "EntitlementStatus" AS ENUM ('issued', 'claimed', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "MintJobStatus" AS ENUM ('queued', 'processing', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'published', 'failed');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "auth_provider" TEXT NOT NULL,
    "auth_subject" TEXT NOT NULL,
    "email_hash" TEXT,
    "display_name" TEXT,
    "role" "AccountRole" NOT NULL DEFAULT 'buyer',
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artworks" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image_key" TEXT,
    "image_content_type" TEXT,
    "image_byte_size" INTEGER,
    "max_supply" INTEGER NOT NULL,
    "reserved_count" INTEGER NOT NULL DEFAULT 0,
    "issued_count" INTEGER NOT NULL DEFAULT 0,
    "status" "ArtworkStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "artworks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" UUID NOT NULL,
    "artwork_id" UUID NOT NULL,
    "price_amount" INTEGER NOT NULL,
    "price_currency" CHAR(3) NOT NULL,
    "max_quantity_per_order" INTEGER NOT NULL DEFAULT 1,
    "status" "ListingStatus" NOT NULL DEFAULT 'draft',
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "total_amount" INTEGER NOT NULL,
    "total_currency" CHAR(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "reserved_until" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "artwork_id" UUID NOT NULL,
    "artwork_title_snapshot" TEXT NOT NULL,
    "unit_price_amount" INTEGER NOT NULL,
    "unit_price_currency" CHAR(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_session_ref" TEXT,
    "provider_payment_ref" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_refunded" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "payload_digest" TEXT NOT NULL,
    "error_summary" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "artwork_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "serial_no" INTEGER NOT NULL,
    "claim_token_hash" TEXT NOT NULL,
    "status" "EntitlementStatus" NOT NULL DEFAULT 'issued',
    "expires_at" TIMESTAMPTZ(6),
    "claimed_by_account_id" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mint_jobs" (
    "id" UUID NOT NULL,
    "entitlement_id" UUID NOT NULL,
    "status" "MintJobStatus" NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "idempotency_key" TEXT NOT NULL,
    "submission_ref" TEXT,
    "last_error_code" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mint_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nft_tokens" (
    "id" UUID NOT NULL,
    "entitlement_id" UUID NOT NULL,
    "mint_job_id" UUID NOT NULL,
    "chain_ref" TEXT NOT NULL,
    "contract_ref" TEXT NOT NULL,
    "token_ref" TEXT NOT NULL,
    "tx_ref" TEXT,
    "owner_ref" TEXT NOT NULL,
    "metadata_uri" TEXT,
    "minted_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nft_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_account_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "summary" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_auth_provider_auth_subject_key" ON "accounts"("auth_provider", "auth_subject");

-- CreateIndex
CREATE UNIQUE INDEX "artworks_slug_key" ON "artworks"("slug");

-- CreateIndex
CREATE INDEX "artworks_status_idx" ON "artworks"("status");

-- CreateIndex
CREATE INDEX "listings_artwork_id_idx" ON "listings"("artwork_id");

-- CreateIndex
CREATE INDEX "listings_status_starts_at_ends_at_idx" ON "listings"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "listings_display_order_idx" ON "listings"("display_order");

-- CreateIndex
CREATE INDEX "orders_status_reserved_until_idx" ON "orders"("status", "reserved_until");

-- CreateIndex
CREATE INDEX "orders_account_id_created_at_idx" ON "orders"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_account_id_idempotency_key_key" ON "orders"("account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "order_lines_order_id_idx" ON "order_lines"("order_id");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_payment_ref_key" ON "payments"("provider", "provider_payment_ref");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "entitlements_account_id_status_idx" ON "entitlements"("account_id", "status");

-- CreateIndex
CREATE INDEX "entitlements_order_id_idx" ON "entitlements"("order_id");

-- CreateIndex
CREATE INDEX "entitlements_status_expires_at_idx" ON "entitlements"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_artwork_id_serial_no_key" ON "entitlements"("artwork_id", "serial_no");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_claim_token_hash_key" ON "entitlements"("claim_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "mint_jobs_entitlement_id_key" ON "mint_jobs"("entitlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "mint_jobs_idempotency_key_key" ON "mint_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "mint_jobs_status_next_attempt_at_idx" ON "mint_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "nft_tokens_entitlement_id_key" ON "nft_tokens"("entitlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "nft_tokens_mint_job_id_key" ON "nft_tokens"("mint_job_id");

-- CreateIndex
CREATE INDEX "nft_tokens_owner_ref_idx" ON "nft_tokens"("owner_ref");

-- CreateIndex
CREATE UNIQUE INDEX "nft_tokens_chain_ref_contract_ref_token_ref_key" ON "nft_tokens"("chain_ref", "contract_ref", "token_ref");

-- CreateIndex
CREATE INDEX "outbox_events_status_occurred_at_idx" ON "outbox_events"("status", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_occurred_at_idx" ON "audit_logs"("target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_account_id_occurred_at_idx" ON "audit_logs"("actor_account_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_claimed_by_account_id_fkey" FOREIGN KEY ("claimed_by_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mint_jobs" ADD CONSTRAINT "mint_jobs_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_tokens" ADD CONSTRAINT "nft_tokens_mint_job_id_fkey" FOREIGN KEY ("mint_job_id") REFERENCES "mint_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- CHECK 制約・部分ユニーク索引・トリガ（手書き）
-- ----------------------------------------------------------------------------
-- Prisma のスキーマ言語では表現できないため、ここに手で書く。
-- schema.prisma を変更してマイグレーションを再生成しても、
-- この節は自動では復元されない。**削除しないこと。**
--
-- これらはアプリのバグがあっても不正なデータを物理的に作れなくするための
-- 最終防壁である（DATABASE_DESIGN.md §3-4）。
-- ============================================================================

-- --- 作品: 発行上限と在庫カウンタ -------------------------------------------
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_max_supply_positive" CHECK ("max_supply" >= 1);
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_reserved_count_non_negative" CHECK ("reserved_count" >= 0);
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_issued_count_non_negative" CHECK ("issued_count" >= 0);
-- ★ オーバーセルの最終防壁。行ロックの実装を誤ってもここで止まる。
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_supply_within_max" CHECK ("reserved_count" + "issued_count" <= "max_supply");
-- 画像は「キー・MIME・サイズ」が揃うか、まったく無いかのどちらか。
-- 中途半端な状態を許すと、表示側が毎回 null チェックの組み合わせを考える羽目になる。
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_image_fields_consistent" CHECK (
  ("image_key" IS NULL AND "image_content_type" IS NULL AND "image_byte_size" IS NULL)
  OR ("image_key" IS NOT NULL AND "image_content_type" IS NOT NULL AND "image_byte_size" IS NOT NULL)
);
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_image_size_positive" CHECK ("image_byte_size" IS NULL OR "image_byte_size" > 0);

-- --- 出品 -------------------------------------------------------------------
-- 価格は 0 より大きい。無償配布は販売とは別の導線として扱う。
ALTER TABLE "listings" ADD CONSTRAINT "listings_price_positive" CHECK ("price_amount" > 0);
ALTER TABLE "listings" ADD CONSTRAINT "listings_max_quantity_positive" CHECK ("max_quantity_per_order" >= 1);
-- 終了日時は開始日時より後。
ALTER TABLE "listings" ADD CONSTRAINT "listings_period_ordered" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at");
-- 「予約」なのに開始日時が無い状態を作らせない。
-- ドメイン側は「scheduled かつ開始日時を過ぎている＝販売中」と扱うので、
-- 開始日時が無い scheduled があると判定が曖昧になる。
ALTER TABLE "listings" ADD CONSTRAINT "listings_scheduled_requires_start" CHECK (
  "status" <> 'scheduled' OR "starts_at" IS NOT NULL
);

-- ★ 同一作品に、有効な出品を同時に複数作らせない。
--   販売中と販売予定を「有効」とみなす。価格改定は
--   「停止（suspended）→ 編集 → 再開」の手順で行う。
CREATE UNIQUE INDEX "listings_one_effective_per_artwork"
  ON "listings" ("artwork_id")
  WHERE "status" IN ('active', 'scheduled');

-- ★ 公開済みの作品にしか有効な出品を作らせない。
--   作品と出品は別テーブルなので CHECK では表現できず、トリガで担保する。
--   （カタログに出ていないものが購入できる経路を塞ぐ）
CREATE OR REPLACE FUNCTION "listings_require_published_artwork"() RETURNS TRIGGER AS $$
DECLARE
  artwork_status TEXT;
BEGIN
  IF NEW."status" IN ('active', 'scheduled') THEN
    SELECT "status"::TEXT INTO artwork_status FROM "artworks" WHERE "id" = NEW."artwork_id";
    IF artwork_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'listings_require_published_artwork: artwork % is not published', NEW."artwork_id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "listings_require_published_artwork_trigger"
  BEFORE INSERT OR UPDATE ON "listings"
  FOR EACH ROW EXECUTE FUNCTION "listings_require_published_artwork"();

-- 注記: 作品を後から archived にしても、既存の出品はそのまま残る。
--       公開APIが作品の状態で絞り込むため露出はしない。
--       出品を止めたい場合は出品側も ended にする運用とする。

-- --- 注文 -------------------------------------------------------------------
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_non_negative" CHECK ("total_amount" >= 0);

-- --- 注文明細 ---------------------------------------------------------------
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_quantity_positive" CHECK ("quantity" >= 1);
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_unit_price_non_negative" CHECK ("unit_price_amount" >= 0);

-- --- 決済 -------------------------------------------------------------------
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_non_negative" CHECK ("amount" >= 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_non_negative" CHECK ("amount_refunded" >= 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_within_amount" CHECK ("amount_refunded" <= "amount");

-- --- 受取権 -----------------------------------------------------------------
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_serial_no_positive" CHECK ("serial_no" >= 1);
-- claimed のときは受取者と受取日時が必ず埋まっていること。
-- 状態列と実データが食い違うと、監査でも復旧でも判断できなくなる。
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_claimed_fields_present" CHECK (
  "status" <> 'claimed' OR ("claimed_by_account_id" IS NOT NULL AND "claimed_at" IS NOT NULL)
);

-- --- 発行ジョブ -------------------------------------------------------------
ALTER TABLE "mint_jobs" ADD CONSTRAINT "mint_jobs_attempt_count_non_negative" CHECK ("attempt_count" >= 0);
ALTER TABLE "mint_jobs" ADD CONSTRAINT "mint_jobs_max_attempts_positive" CHECK ("max_attempts" >= 1);

-- --- Outbox -----------------------------------------------------------------
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_attempt_count_non_negative" CHECK ("attempt_count" >= 0);
