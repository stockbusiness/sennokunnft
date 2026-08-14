-- CreateTable
CREATE TABLE "hmac_nonces" (
    "id" UUID NOT NULL,
    "key_id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hmac_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hmac_nonces_expires_at_idx" ON "hmac_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "hmac_nonces_key_id_nonce_key" ON "hmac_nonces"("key_id", "nonce");

-- ★ 期限は作成時より後。過去の期限を入れると、記録した瞬間に
--   「期限切れ＝未使用」と見なされ、リプレイを素通しする。
ALTER TABLE "hmac_nonces"
  ADD CONSTRAINT "hmac_nonces_expires_after_creation"
  CHECK ("expires_at" > "created_at");
