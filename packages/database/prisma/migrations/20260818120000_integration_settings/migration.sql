-- 外部連携の設定と資格情報（管理画面・外部連携 指示書 §5・§6）。
--
-- ⚠️ **既存のテーブルには一切触れない。** 追加のみ。
--    revert しても設定・Outbox・監査ログは無傷で残る（指示書 §17）。

-- 1) 公開してよい設定
--
-- ⚠️ **ここに秘密の列を作らない。** CHECK では「秘密が入っていないこと」を
--    表現できない。**列そのものを用意しない**ことでしか担保できない。
CREATE TABLE "integration_settings" (
    "id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    -- 接続先。https 以外は起動時と保存時に弾く（アプリ側）。
    "endpoint_url" TEXT,
    "api_version" TEXT,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    -- 連携が有効か。production を有効にできる条件はアプリ側が判定する。
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    -- 楽観ロック。古い画面からの上書きを弾く（指示書 §12）。
    "row_version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'storage', 'auth'));

ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_environment_valid"
  CHECK ("environment" IN ('staging', 'production'));

-- ⚠️ **時間の指定を無制限にしない。** 0 だと即時失敗、極端に長いと
--    worker が 1 件で詰まる。上限は既存の WALLET_DELIVERY_TIMEOUT_MS と揃える。
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_timeout_range"
  CHECK ("timeout_ms" BETWEEN 1000 AND 60000);

ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_attempts_range"
  CHECK ("max_attempts" BETWEEN 1 AND 20);

ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_row_version_positive"
  CHECK ("row_version" >= 1);

-- サービスと環境の組は 1 つだけ。
CREATE UNIQUE INDEX "integration_settings_service_environment_key"
  ON "integration_settings" ("service", "environment");

-- 2) 暗号化した資格情報
--
-- ⚠️ **平文の列を作らない。** 上と同じ理由。
CREATE TABLE "integration_secrets" (
    "id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    -- 同じサービスで複数の資格情報を持てるようにする（鍵ID と 署名鍵 など）。
    "purpose" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    -- どの暗号鍵で包んだか。鍵の交換に備えて必ず持つ。
    "key_version" TEXT NOT NULL,
    -- 画面での見分け用。**平文の一部**なので、末尾 4 文字までしか入れない。
    "last_four" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_account_id" UUID,
    "activated_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_secrets_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'storage', 'auth'));

ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_environment_valid"
  CHECK ("environment" IN ('staging', 'production'));

ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_status_valid"
  CHECK ("status" IN ('pending', 'active', 'retired'));

-- ⚠️ **識別表示を 4 文字に縛る。** 「もう少し出したい」で伸ばされると、
--    そのぶん秘密が平文で残る。DB 側で上限を決めておく。
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_last_four_short"
  CHECK (char_length("last_four") <= 4);

-- ⚠️ **同値ではなく含意にする。** 退役した資格情報にも「いつ有効になったか」は
--    残る。同値で縛ると、退役させた瞬間にこの制約へ引っかかって保存できない。
--    （実 PostgreSQL の試験で実際に踏んだ。）
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_active_has_time"
  CHECK ("status" <> 'active' OR "activated_at" IS NOT NULL);

ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_retired_has_time"
  CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL));

-- ⚠️ **有効な資格情報は用途ごとに 1 件だけ。**
--    2 件あると、どちらで署名したのか分からなくなる。
--    交換の途中で落ちても 2 件にならないことを、ここで担保する。
CREATE UNIQUE INDEX "integration_secrets_active_key"
  ON "integration_secrets" ("service", "environment", "purpose") WHERE "status" = 'active';

-- ⚠️ 待機中も 1 件だけ。2 通目を作れると、どちらを有効化するのか決まらない。
CREATE UNIQUE INDEX "integration_secrets_pending_key"
  ON "integration_secrets" ("service", "environment", "purpose") WHERE "status" = 'pending';

CREATE INDEX "integration_secrets_service_environment_status_idx"
  ON "integration_secrets" ("service", "environment", "status");

-- 3) 接続テストの記録
CREATE TABLE "integration_connection_checks" (
    "id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    -- 失敗の分類。⚠️ 外部の生の応答本文を入れない（秘匿値が混ざりうる）。
    "failure_code" TEXT,
    "duration_ms" INTEGER NOT NULL,
    -- どの資格情報で試したか。交換の途中でどちらを試したかを辿るため。
    "secret_id" UUID,
    "executed_by_account_id" UUID,
    "correlation_id" TEXT,
    "executed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_connection_checks_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "integration_connection_checks" ADD CONSTRAINT "integration_connection_checks_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'storage', 'auth'));

ALTER TABLE "integration_connection_checks" ADD CONSTRAINT "integration_connection_checks_environment_valid"
  CHECK ("environment" IN ('staging', 'production'));

-- 成功したものに失敗の分類が付いていない、を担保する。
ALTER TABLE "integration_connection_checks" ADD CONSTRAINT "integration_connection_checks_failure_only_when_failed"
  CHECK ("succeeded" = false OR "failure_code" IS NULL);

-- 直近の結果を引くための索引（指示書 §9 の有効期間の判定に使う）。
CREATE INDEX "integration_connection_checks_service_environment_executed__idx"
  ON "integration_connection_checks" ("service", "environment", "executed_at" DESC);

-- ⚠️ 実行者のアカウントは、記録が残っているあいだ消せない。
--    誰が試したのかが辿れなくなるため。
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_updated_by_account_id_fkey"
  FOREIGN KEY ("updated_by_account_id") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_created_by_account_id_fkey"
  FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "integration_connection_checks" ADD CONSTRAINT "integration_connection_checks_executed_by_account_id_fkey"
  FOREIGN KEY ("executed_by_account_id") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "integration_connection_checks" ADD CONSTRAINT "integration_connection_checks_secret_id_fkey"
  FOREIGN KEY ("secret_id") REFERENCES "integration_secrets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
