-- 決済 Phase P0・P1：注文基盤（指示書 §5）
--
-- ⚠️ **追加だけを行う。** 既存の列を消したり型を変えたりしない。
--    revert しても、既存の注文・受取権・監査ログは無傷で残る。
--
-- ⚠️ **既存の注文が 0 件でなくても通るように書いてある。**
--    新しい列は既定値を与えるか、既存行から埋め戻してから NOT NULL にする。

-- ---------------------------------------------------------------------------
-- 1. 注文の進み具合に、決済前の状態を足す
-- ---------------------------------------------------------------------------
--
-- ⚠️ **`failed` と `refunded` は残すが、もう使わない。**
--    決済の失敗は payment_status、返金は refund_status が持つ。
--    列挙型から値を消すと、過去の行が読めなくなる。消さずに、
--    新しい注文がそこへ遷移しないことをドメイン側の遷移表で守る。
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'checkout_created';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- ---------------------------------------------------------------------------
-- 2. 注文：番号・当事者・金額・4 つの状態
-- ---------------------------------------------------------------------------

-- 人が読み上げ、問い合わせで使う番号。参照の正は id（UUID）のまま。
ALTER TABLE "orders" ADD COLUMN "order_number" TEXT;

-- 共通顧客ID。まだ解決できていない購入者があるため NULL を許す。
ALTER TABLE "orders" ADD COLUMN "common_user_id" TEXT;

-- 1 注文 1 クリエイター（指示書 §3-4）。
ALTER TABLE "orders" ADD COLUMN "creator_account_id" UUID;

-- 金額。⚠️ すべて整数。手数料率も bps（1/100 %）の整数で持つ。
--    率を小数で持つと、金額に掛けた瞬間に誤差が入る。
ALTER TABLE "orders" ADD COLUMN "subtotal_amount" INTEGER;
ALTER TABLE "orders" ADD COLUMN "discount_amount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "platform_fee_rate_bps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "platform_fee_amount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "creator_amount" INTEGER;

-- 状態を 4 本に分ける（指示書 §7）。
-- ⚠️ 列挙型ではなく TEXT + CHECK にしてある。値を足すときに
--    `ALTER TYPE` を伴わず、他の状態列（wallet_delivery_status 等）と
--    同じ扱いにそろえるため。
ALTER TABLE "orders" ADD COLUMN "payment_status" TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE "orders" ADD COLUMN "fulfillment_status" TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE "orders" ADD COLUMN "refund_status" TEXT NOT NULL DEFAULT 'none';

-- 既存行の埋め戻し。
-- ⚠️ 手数料率 0・手数料 0 で埋める。過去の注文に、あとから決めた率を
--    さかのぼって適用しない。
UPDATE "orders" SET
  "subtotal_amount" = "total_amount",
  "creator_amount"  = "total_amount"
WHERE "subtotal_amount" IS NULL;

-- 注文番号は id から決まる形で埋める。
-- ⚠️ 乱数を使わない。同じ移行を 2 回流しても同じ番号になるようにして、
--    「移行のたびに番号が変わる」を避ける。
UPDATE "orders" SET "order_number" =
  'SNK-' || to_char("created_at" AT TIME ZONE 'UTC', 'YYYYMMDD') || '-' ||
  upper(translate(substring(replace("id"::text, '-', '') from 1 for 8), '01il', '2345'))
WHERE "order_number" IS NULL;

-- クリエイターは明細の作品から埋め戻す。
-- ⚠️ 明細の無い注文があるとここで NULL が残り、次の NOT NULL で失敗する。
--    その場合は移行を止めて調べる。勝手な値で埋めない
--    （PR 本文の「マイグレーション適用手順」に確認クエリを記載）。
UPDATE "orders" o SET "creator_account_id" = a."creator_account_id"
FROM "order_lines" ol
JOIN "artworks" a ON a."id" = ol."artwork_id"
WHERE ol."order_id" = o."id" AND o."creator_account_id" IS NULL;

ALTER TABLE "orders" ALTER COLUMN "order_number" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "subtotal_amount" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "creator_amount" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "creator_account_id" SET NOT NULL;

ALTER TABLE "orders" ADD CONSTRAINT "orders_order_number_key" UNIQUE ("order_number");
ALTER TABLE "orders" ADD CONSTRAINT "orders_creator_account_id_fkey"
  FOREIGN KEY ("creator_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 金額の不変条件。⚠️ アプリのバグがあっても、崩れた行を残さない。
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_non_negative"
  CHECK ("subtotal_amount" >= 0 AND "discount_amount" >= 0 AND "total_amount" >= 0
     AND "platform_fee_amount" >= 0 AND "creator_amount" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_fee_rate_range"
  CHECK ("platform_fee_rate_bps" >= 0 AND "platform_fee_rate_bps" <= 10000);
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_matches_subtotal"
  CHECK ("total_amount" = "subtotal_amount" - "discount_amount");
-- ⚠️ ここが要。手数料と配分の合計が支払額に一致しない行を作らせない。
ALTER TABLE "orders" ADD CONSTRAINT "orders_split_matches_total"
  CHECK ("platform_fee_amount" + "creator_amount" = "total_amount");

ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_known"
  CHECK ("payment_status" IN ('not_started','pending','succeeded','failed','cancelled','refunded'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfillment_status_known"
  CHECK ("fulfillment_status" IN ('not_started','processing','fulfilled','failed'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_status_known"
  CHECK ("refund_status" IN ('none','pending','partially_refunded','refunded','failed'));

-- 支払い済みなら時刻が入る（片方だけの行を作らせない）。
-- ⚠️ 同値ではなく含意にする。決済が成功していても、注文側の
--    進み具合の更新が一拍遅れる経路がありうる。逆向き
--    （時刻が入っているのに状態が進んでいない）は正常な途中経過。
-- ⚠️ 2 つの列の両方を見る。`paid_at` は管理画面が読む列であり、
--    どちらか片方だけを縛ると、もう片方の経路から空の行が入る。
ALTER TABLE "orders" ADD CONSTRAINT "orders_paid_has_time"
  CHECK (("payment_status" <> 'succeeded' AND "status" <> 'paid') OR "paid_at" IS NOT NULL);

CREATE INDEX "orders_creator_account_id_created_at_idx"
  ON "orders" ("creator_account_id", "created_at" DESC);
CREATE INDEX "orders_payment_status_created_at_idx"
  ON "orders" ("payment_status", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- 3. 注文明細：クリエイターと明細合計、そして 1 注文 1 明細
-- ---------------------------------------------------------------------------

ALTER TABLE "order_lines" ADD COLUMN "creator_account_id" UUID;
ALTER TABLE "order_lines" ADD COLUMN "total_amount" INTEGER;

UPDATE "order_lines" ol SET
  "creator_account_id" = a."creator_account_id",
  "total_amount" = ol."unit_price_amount" * ol."quantity"
FROM "artworks" a
WHERE a."id" = ol."artwork_id" AND ol."creator_account_id" IS NULL;

ALTER TABLE "order_lines" ALTER COLUMN "creator_account_id" SET NOT NULL;
ALTER TABLE "order_lines" ALTER COLUMN "total_amount" SET NOT NULL;

ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_creator_account_id_fkey"
  FOREIGN KEY ("creator_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_total_matches_unit_price"
  CHECK ("total_amount" = "unit_price_amount" * "quantity");

-- ⚠️ **MVP は 1 注文 1 明細**（指示書 §5.2）。
--    order_id だけの UNIQUE で「1 注文に明細は 1 本まで」を DB が守る。
--    ドメイン側でも 1 本しか作らないが、二重に持つ。
--    将来グッズで複数明細を許すときは、この制約を外す 1 行の移行で済む。
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_single_item_per_order" UNIQUE ("order_id");

-- UNIQUE が索引を兼ねるため、初期移行で作った通常索引は不要になる。
-- 同じ列に索引を 2 本持つと、書き込みのたびに両方を更新する。
DROP INDEX IF EXISTS "order_lines_order_id_idx";

-- ---------------------------------------------------------------------------
-- 4. 在庫・販売枠の予約（指示書 §5.3）
-- ---------------------------------------------------------------------------
--
-- ⚠️ **この表は「跡」であって「正」ではない。** 売り越しを防いでいるのは
--    artworks.reserved_count と CHECK 制約のほう。ここは
--    「いつ・どの注文が・いくつ押さえ、いつ解放したか」を追うためにある。

CREATE TABLE "inventory_reservations" (
  "id"          UUID         NOT NULL,
  "order_id"    UUID         NOT NULL,
  "listing_id"  UUID         NOT NULL,
  "artwork_id"  UUID         NOT NULL,
  "quantity"    INTEGER      NOT NULL,
  "status"      TEXT         NOT NULL DEFAULT 'reserved',
  "expires_at"  TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "released_at" TIMESTAMPTZ(6),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_listing_id_fkey"
  FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_artwork_id_fkey"
  FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_status_known"
  CHECK ("status" IN ('reserved','consumed','released'));
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_quantity_positive"
  CHECK ("quantity" > 0);

-- 状態と時刻が食い違う行を作らせない。
-- ⚠️ 含意にする。同値で縛ると、解放したあとに消費時刻を持つ行が
--    表現できなくなる（実際には起こらないが、縛りすぎると直せなくなる）。
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_released_has_time"
  CHECK ("status" <> 'released' OR "released_at" IS NOT NULL);
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_consumed_has_time"
  CHECK ("status" <> 'consumed' OR "consumed_at" IS NOT NULL);

-- ⚠️ **1 注文に有効な予約は 1 件だけ**（指示書 §5.3）。
--    2 件あると、解放が 1 件ぶんしか行われず在庫が戻らない。
CREATE UNIQUE INDEX "inventory_reservations_one_active_per_order"
  ON "inventory_reservations" ("order_id") WHERE "status" = 'reserved';

-- 期限切れの掃き出しで使う索引。全件走査させない。
CREATE INDEX "inventory_reservations_expiry_idx"
  ON "inventory_reservations" ("status", "expires_at");

-- ---------------------------------------------------------------------------
-- 5. 決済の受け皿（指示書 §5.4）
-- ---------------------------------------------------------------------------
--
-- ⚠️ **今回、ここへ書き込む経路は作らない。** Phase P2 で
--    Stripe Webhook から埋める。管理画面から成功状態にする API も作らない。

ALTER TABLE "payments" ADD COLUMN "provider_charge_ref" TEXT;
ALTER TABLE "payments" ADD COLUMN "provider_idempotency_key" TEXT;
ALTER TABLE "payments" ADD COLUMN "paid_at" TIMESTAMPTZ(6);
ALTER TABLE "payments" ADD COLUMN "failure_code" TEXT;
-- ⚠️ 外部の応答本文をそのまま入れない。運用が読むための短い要約だけ。
ALTER TABLE "payments" ADD COLUMN "failure_message_safe" TEXT;

ALTER TABLE "payments" ADD CONSTRAINT "payments_succeeded_has_time"
  CHECK ("status" <> 'succeeded' OR "paid_at" IS NOT NULL);
