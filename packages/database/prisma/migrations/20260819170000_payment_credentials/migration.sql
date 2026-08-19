-- 決済資格情報の世代管理（`UD-118`・`docs/PAYMENT_CREDENTIAL_ROTATION.md`）。
--
-- ⚠️ **運営会社が変わっても、過去の注文を返金できるようにするための表。**
--    決済事業者側の識別子（session / charge）はアカウントに紐づくので、
--    鍵を上書きすると過去の注文が返金不能になる。だから世代で持つ。
--
-- ⚠️ **`integration_secrets` を流用しない。** あちらは「1 用途につき有効 1 件」で、
--    古いものは使わなくなる前提。決済は**古い世代を使い続ける**必要がある。

CREATE TABLE "payment_credentials" (
  "id"                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider"                  TEXT NOT NULL,
  "environment"               TEXT NOT NULL,
  -- 1 から始まる連番。⚠️ (provider, environment) ごとに一意。
  "generation"                INTEGER NOT NULL,
  -- 決済事業者側のアカウント識別子（acct_…）。⚠️ **秘密ではない。** 画面に出す。
  "account_ref"               TEXT,
  -- 運営が付ける覚え書き。⚠️ 秘密を書かせない（画面の注記で伝える）。
  "label"                     TEXT,
  "status"                    TEXT NOT NULL DEFAULT 'pending',
  -- 封の形は integration_secrets と同じ（AEAD）。⚠️ 平文の列を作らない。
  "secret_key_ciphertext"     TEXT NOT NULL,
  "secret_key_nonce"          TEXT NOT NULL,
  "secret_key_auth_tag"       TEXT NOT NULL,
  "webhook_secret_ciphertext" TEXT NOT NULL,
  "webhook_secret_nonce"      TEXT NOT NULL,
  "webhook_secret_auth_tag"   TEXT NOT NULL,
  "key_version"               TEXT NOT NULL,
  "api_version"               TEXT,
  -- 直近の接続確認。⚠️ **成功していないと有効化できない**（下の CHECK）。
  "last_check_succeeded"      BOOLEAN,
  "last_check_at"             TIMESTAMPTZ(6),
  "last_webhook_received_at"  TIMESTAMPTZ(6),
  "registered_by_account_id"  UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "activated_by_account_id"   UUID REFERENCES "accounts"("id") ON DELETE RESTRICT,
  -- active でも新規受付だけ止められる。⚠️ 返金と照会は続く。
  "accepts_new_payments"      BOOLEAN NOT NULL DEFAULT false,
  "activated_at"              TIMESTAMPTZ(6),
  "retired_at"                TIMESTAMPTZ(6),
  "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(6) NOT NULL
);

ALTER TABLE "payment_credentials"
  ADD CONSTRAINT "payment_credentials_status_valid"
  CHECK ("status" IN ('pending', 'active', 'retired'));

ALTER TABLE "payment_credentials"
  ADD CONSTRAINT "payment_credentials_environment_valid"
  CHECK ("environment" IN ('staging', 'production'));

ALTER TABLE "payment_credentials"
  ADD CONSTRAINT "payment_credentials_generation_positive"
  CHECK ("generation" >= 1);

-- 接続確認を通らずに有効化できない。
--
-- ⚠️ **鍵の打ち間違いをここで止める。** 二者承認をやめた（2026-08-19 決定）
--    代わりの守りなので、外さないこと。外すと、間違った鍵のまま
--    受付世代を切り替えられてしまう。
--
-- ⚠️ **`IS TRUE` を使う。`= true` にしない。** PostgreSQL の CHECK は
--    式が NULL のとき**通ってしまう**。まだ接続確認をしていない世代は
--    `last_check_succeeded` が NULL なので、`= true` だと
--    「false OR NULL」→ NULL となり、素通りする。実際にそう書いて、
--    実 DB の試験が捕まえた。
ALTER TABLE "payment_credentials"
  ADD CONSTRAINT "payment_credentials_active_requires_check"
  CHECK ("status" <> 'active' OR "last_check_succeeded" IS TRUE);

-- 誰が有効化したか分からない active を作らせない。
ALTER TABLE "payment_credentials"
  ADD CONSTRAINT "payment_credentials_active_requires_actor"
  CHECK ("status" <> 'active' OR "activated_by_account_id" IS NOT NULL);

-- pending や retired が新規受付になることはない。
ALTER TABLE "payment_credentials"
  ADD CONSTRAINT "payment_credentials_accepts_only_when_active"
  CHECK ("status" = 'active' OR "accepts_new_payments" = false);

CREATE UNIQUE INDEX "payment_credentials_generation_key"
  ON "payment_credentials" ("provider", "environment", "generation");

-- **新規の支払い口を作る世代は常に 1 つ。**
--
-- ⚠️ **部分UNIQUE でしか書けない。** Prisma のスキーマでは表せないので、
--    この表を作り直すときは必ず持っていくこと。
-- ⚠️ 2 つあるとオーバーセルではなく「どちらの事業者へ入金されるか不定」に
--    なる。0 なら販売が止まる。どちらも気づきにくい。
CREATE UNIQUE INDEX "payment_credentials_one_accepting"
  ON "payment_credentials" ("provider", "environment")
  WHERE "accepts_new_payments" = true;

CREATE INDEX "payment_credentials_lookup_idx"
  ON "payment_credentials" ("provider", "environment", "status", "generation" DESC);

-- その決済をどの世代の鍵で処理したか。
--
-- ⚠️ **これが設計の要。** 無いと、切り替え後に「どの鍵で返せばよいか」を
--    誰も判断できない。
-- ⚠️ NULL を許すのは移行のため（`docs/PAYMENT_CREDENTIAL_ROTATION.md` §11）。
--    既存行を埋めたあとに NOT NULL へ締める。
-- ⚠️ ON DELETE RESTRICT。世代を消せなくする（消すと返金経路が消える）。
ALTER TABLE "payments"
  ADD COLUMN "credential_id" UUID REFERENCES "payment_credentials"("id") ON DELETE RESTRICT;

CREATE INDEX "payments_credential_idx" ON "payments" ("credential_id");

-- 受信記録にも、どの世代の署名で通ったかを残す。
--
-- ⚠️ 旧アカウントからも知らせは届き続ける。「どの世代で通ったか」が
--    分からないと、届いているのに処理されない事象を追えない。
ALTER TABLE "webhook_events"
  ADD COLUMN "credential_id" UUID REFERENCES "payment_credentials"("id") ON DELETE RESTRICT;
