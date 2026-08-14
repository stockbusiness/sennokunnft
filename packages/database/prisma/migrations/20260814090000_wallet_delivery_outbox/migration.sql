-- OVEW Wallet への配送待ち行列と、その周辺の列を追加する（PR-NW04 §7 / §10 / §22 / §23）。
--
-- ここで足しているのは 4 つ。
--  1. orders.source        … Fixture 由来の注文を区別する
--  2. artworks.image_hash  … Wallet へ送る画像の内容ハッシュ
--  3. entitlements.wallet_delivered_at … 配送完了時刻
--  4. wallet_delivery_outbox … 配送待ち行列そのもの

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('PURCHASE', 'STAGING_FIXTURE');

-- CreateEnum
CREATE TYPE "WalletDeliveryOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD');

-- ============================================================================
-- 1. 注文の出自
-- ============================================================================
--
-- ⚠️ **`entitlements.order_id` を NULL 許容にしない**ための列。
--    staging の動作確認では「注文の無い受取権」を作りたくなるが、
--    列を緩めると、その穴は本番の経路にも開く。しかも
--    あとから注文なしの行が紛れ込んでも誰も気づけない。
--    Fixture 側で本物の Order / OrderLine を作り、出自だけを区別する。

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "source" "OrderSource" NOT NULL DEFAULT 'PURCHASE';

-- Fixture 行の洗い出し・掃除に使う。
CREATE INDEX "orders_source_created_at_idx" ON "orders"("source", "created_at");

-- ============================================================================
-- 2. 画像の内容ハッシュ
-- ============================================================================

-- AlterTable
ALTER TABLE "artworks" ADD COLUMN "image_hash" TEXT;

-- ★ 形式を固定する。`sha256:` + 64桁hex 以外を入れさせない。
--   Wallet はこの値で同一性を確かめる。形の違う値を送ると
--   「壊れている」ではなく「別物」として扱われる。
ALTER TABLE "artworks"
  ADD CONSTRAINT "artworks_image_hash_format"
  CHECK ("image_hash" IS NULL OR "image_hash" ~ '^sha256:[0-9a-f]{64}$');

-- ============================================================================
-- 3. 配送完了時刻
-- ============================================================================

-- AlterTable
ALTER TABLE "entitlements" ADD COLUMN "wallet_delivered_at" TIMESTAMPTZ(6);

-- ★ 「届いた」と「届いた時刻」を分離させない。
--   片方だけが入る書き方を許すと、状態は delivered なのに時刻が無い行、
--   あるいは時刻はあるのに状態が戻った行ができる。
--   どちらも「いつ届いたのか」を誰も答えられない。
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_delivered_at_matches_status"
  CHECK (("wallet_delivered_at" IS NOT NULL) = ("wallet_delivery_status" = 'delivered'));

-- ============================================================================
-- 4. 配送待ち行列
-- ============================================================================

-- CreateTable
CREATE TABLE "wallet_delivery_outbox" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "entitlement_id" UUID NOT NULL,
    "target_site_key" TEXT NOT NULL,
    -- ⚠️ jsonb にしない。署名は「送るバイト列そのもの」に対して行うため、
    --    キー順と空白を正規化する型に入れると、読み戻した本文が別物になる。
    "payload" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" "WalletDeliveryOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_retry_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "wallet_delivery_outbox_pkey" PRIMARY KEY ("id")
);

-- ★ 二重配送を防ぐ最後の砦。
--   相手の Idempotency-Key がこの値なので、同じイベントの行が 2 つあると
--   相手側の冪等性に頼りきりになる。こちら側でも作らせない。
CREATE UNIQUE INDEX "wallet_delivery_outbox_event_id_key" ON "wallet_delivery_outbox"("event_id");

-- 配送ワーカーの取得クエリ（status = 'PENDING' AND next_retry_at <= now()）用。
CREATE INDEX "wallet_delivery_outbox_status_next_retry_at_idx"
  ON "wallet_delivery_outbox"("status", "next_retry_at");

CREATE INDEX "wallet_delivery_outbox_entitlement_id_idx"
  ON "wallet_delivery_outbox"("entitlement_id");

-- AddForeignKey
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_entitlement_id_fkey"
  FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ★ 送るイベント名は 2 種類だけ。
--   綴りを間違えた行を作れると、相手は 400 を返し、こちらは
--   「相手が壊れている」と読み違える。名前は送る前に潰す。
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_event_type_known"
  CHECK ("event_type" IN ('entitlement.granted', 'entitlement.revoked'));

-- ★ 宛先も既知のものだけ。設定ミスで宛先不明の行が溜まらないようにする。
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_target_site_key_known"
  CHECK ("target_site_key" IN ('ovew-wallet'));

-- ★ 本文ハッシュの形式。artworks.image_hash と同じ規則にそろえる。
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_payload_hash_format"
  CHECK ("payload_hash" ~ '^sha256:[0-9a-f]{64}$');

-- ★ correlation_id は受信側と同じ字種に限る。
--   ログへ改行や制御文字が入る値を通すと、追跡どころか記録が壊れる。
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_correlation_id_format"
  CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$');

-- ★ 試行回数の下限。
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_attempt_count_non_negative"
  CHECK ("attempt_count" >= 0);

-- ★ 上限は 1 回以上。0 にすると一度も送らずに DEAD になる行が作れる。
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_max_attempts_positive"
  CHECK ("max_attempts" >= 1);

-- ★ 「届いた」と「届いた時刻」を分離させない（entitlements と同じ理由）。
ALTER TABLE "wallet_delivery_outbox"
  ADD CONSTRAINT "wallet_delivery_outbox_delivered_at_matches_status"
  CHECK (("delivered_at" IS NOT NULL) = ("status" = 'DELIVERED'));
