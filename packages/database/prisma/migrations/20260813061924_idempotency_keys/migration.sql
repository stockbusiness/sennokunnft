-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_actor_account_id_key_key" ON "idempotency_keys"("actor_account_id", "key");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ★ 状態は 2 つだけ。文字列カラムは放っておくと何でも入るので、DB 側で閉じる。
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_status_known"
  CHECK ("status" IN ('in_progress', 'completed'));

-- ★ completed なら応答が揃っていること。片方だけ埋まった行を作らせない。
--   （揃っていない completed を返すと、2 回目の呼び出しが壊れた応答を受け取る）
--   ⚠️ 制約 1 つにつき役割 1 つ。未知の状態はここでは弾かない
--   （弾くと、状態が不正なのか応答が欠けているのか区別がつかなくなる）。
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_completed_has_response"
  CHECK (
    "status" NOT IN ('in_progress', 'completed')
    OR
    ("status" = 'in_progress' AND "status_code" IS NULL AND "completed_at" IS NULL)
    OR
    ("status" = 'completed' AND "status_code" IS NOT NULL AND "completed_at" IS NOT NULL)
  );

-- ★ 有効期限は作成時より後。
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_expires_after_creation"
  CHECK ("expires_at" > "created_at");
