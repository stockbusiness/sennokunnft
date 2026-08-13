-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "common_user_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "common_user_id" TEXT,
ADD COLUMN     "common_user_last_error" TEXT,
ADD COLUMN     "common_user_linked_at" TIMESTAMPTZ(6),
ADD COLUMN     "common_user_next_attempt_at" TIMESTAMPTZ(6),
ADD COLUMN     "common_user_status" TEXT NOT NULL DEFAULT 'UNRESOLVED';

-- CreateIndex
CREATE INDEX "accounts_common_user_status_common_user_next_attempt_at_idx" ON "accounts"("common_user_status", "common_user_next_attempt_at");

-- CreateIndex
CREATE INDEX "accounts_common_user_id_idx" ON "accounts"("common_user_id");

-- ★ 状態は 5 つだけ。文字列カラムは放っておくと何でも入る。
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_common_user_status_known"
  CHECK ("common_user_status" IN ('UNRESOLVED', 'PENDING', 'RESOLVED', 'CONFLICT', 'ERROR'));

-- ★ common_user_id の形式。代理店システムの契約は cu_ + 32桁hex。
--   形を見るのは、取り違えた値（自社の account id など）を
--   そのまま保存してしまう事故を防ぐため。
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_common_user_id_format"
  CHECK ("common_user_id" IS NULL OR "common_user_id" ~ '^cu_[0-9a-f]{32}$');

-- ★ RESOLVED を名乗る行には、必ず値と紐付け時刻がある。
--   片方だけ埋まった RESOLVED を許すと、Claim の照合が
--   「解決済みなのに ID が無い」行に当たって落ちる。
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_common_user_resolved_has_id"
  CHECK (
    "common_user_status" <> 'RESOLVED'
    OR ("common_user_id" IS NOT NULL AND "common_user_linked_at" IS NOT NULL)
  );

-- ★ まだ試していない行に、試行回数や失敗理由が残っていない。
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_common_user_unresolved_is_clean"
  CHECK (
    "common_user_status" <> 'UNRESOLVED'
    OR ("common_user_attempt_count" = 0 AND "common_user_last_error" IS NULL)
  );

-- ★ 試行回数は負にならない。
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_common_user_attempt_count_non_negative"
  CHECK ("common_user_attempt_count" >= 0);
