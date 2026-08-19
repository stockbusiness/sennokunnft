-- 決済 Phase P2: Stripe Checkout と Webhook の受け皿
--
-- ⚠️ **追加のみ。** 既存の列・制約は変えていない。
-- ⚠️ **注文と決済のデータを消す経路は作らない**（指示書 §13）。

-- ---------------------------------------------------------------------------
-- 0. PaymentStatus — 「取り消された」を表せるようにする
-- ---------------------------------------------------------------------------
--
-- ⚠️ **`failed` で代用しない。** 支払い口の期限が切れたことと、
--    カードが拒否されたことは別の事実。同じ印にすると、運用が
--    「利用者に何が起きたか」を答えられなくなる。
--
-- ⚠️ ドメイン側（`OrderPaymentStatus`）には最初から `cancelled` があった。
--    DB 側だけ欠けていたので、そろえる。
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- ---------------------------------------------------------------------------
-- 1. payments — 試行を積み上げ、成功は 1 件だけ
-- ---------------------------------------------------------------------------
--
-- ⚠️ **試行ごとに行を作り、消さない**（決定B）。決済の失敗は
--    「何回目で、何が起きたか」を後から説明できないと、問い合わせに答えられない。
--    上書きすると履歴が消える。

-- Stripe が採番した識別子。値があるときだけ一意。
-- ⚠️ 部分索引にする。まだ埋まっていない行が複数あるのは正常。
CREATE UNIQUE INDEX "payments_provider_session_ref_key"
  ON "payments" ("provider", "provider_session_ref")
  WHERE "provider_session_ref" IS NOT NULL;

CREATE UNIQUE INDEX "payments_provider_charge_ref_key"
  ON "payments" ("provider", "provider_charge_ref")
  WHERE "provider_charge_ref" IS NOT NULL;

-- ⚠️ **1 注文に成功は 1 件だけ**（指示書 §9）。
--    2 件あると、二重に受け取ったのか記録の誤りなのか区別できない。
--    アプリの判定ではなく、ここが最後に止める。
CREATE UNIQUE INDEX "payments_one_succeeded_per_order"
  ON "payments" ("order_id")
  WHERE "status" = 'succeeded';

-- 事業者へ渡した冪等キー。同じキーで 2 行作らない。
CREATE UNIQUE INDEX "payments_provider_idempotency_key_key"
  ON "payments" ("provider", "provider_idempotency_key")
  WHERE "provider_idempotency_key" IS NOT NULL;

-- 支払い口の期限。期限内かどうかを DB でも判断できるようにする。
ALTER TABLE "payments" ADD COLUMN "expires_at" TIMESTAMPTZ(6);

-- 利用者を送る先。
-- ⚠️ **保存するのは、作り直さずに使い回すため。** 持っていないと、
--    「使い回す」たびに決済事業者を呼ぶことになり、そのとき冪等キーが
--    ずれると**別の支払い口ができる**。実際にその不具合を作った。
-- ⚠️ **管理画面へ出さない。** この URL を持つ人は誰でもその注文を支払える。
--    運用に要るのは識別子までで、URL は要らない。
ALTER TABLE "payments" ADD COLUMN "checkout_url" TEXT;

-- 注文ごとに新しい順で引く。
CREATE INDEX "payments_order_created_idx" ON "payments" ("order_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- 2. webhook_events — 受信の記録（指示書 §10）
-- ---------------------------------------------------------------------------
--
-- ⚠️ **新しい表を作らず、既存を広げる。** `webhook_events` には
--    `(provider, event_id)` の UNIQUE が既にあり、二重処理を止める仕掛けが
--    そこに入っている。もう 1 つ表を作ると、どちらが正か分からなくなる。

-- 固定した API バージョン。形が変わったことに後から気づくため。
ALTER TABLE "webhook_events" ADD COLUMN "api_version" TEXT;
-- 本番モードの事象か。⚠️ 試験の知らせで本番の注文を確定させないため。
ALTER TABLE "webhook_events" ADD COLUMN "livemode" BOOLEAN;
ALTER TABLE "webhook_events" ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "webhook_events" ADD COLUMN "order_id" UUID;
ALTER TABLE "webhook_events" ADD COLUMN "payment_id" UUID;
-- ⚠️ 事業者の符号をそのまま入れない。こちらで決めた安全な符号だけ。
ALTER TABLE "webhook_events" ADD COLUMN "last_error_code" TEXT;

ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_attempt_count_non_negative"
  CHECK ("attempt_count" >= 0);

-- 処理済みなら時刻が入る（片方だけの行を作らせない）。
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_processed_has_time"
  CHECK ("status" <> 'processed' OR "processed_at" IS NOT NULL);

CREATE INDEX "webhook_events_order_idx" ON "webhook_events" ("order_id", "received_at" DESC);

-- ---------------------------------------------------------------------------
-- 3. orders — Stripe の識別子を引くための索引
-- ---------------------------------------------------------------------------
--
-- Webhook は注文IDを metadata で持って来るが、metadata が欠けた知らせも届く。
-- そのとき支払い口の識別子から注文を辿れるようにしておく。
-- （`payments.provider_session_ref` の一意索引が既にその役を果たす）
