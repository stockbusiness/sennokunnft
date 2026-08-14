-- Claim（OVEW Wallet 連携）に必要な列を受取権へ追加する。
-- 配送そのものは実装しない（PR-NW04）。ここで用意するのは、
-- 公開状態を組み立てるために必要な最小の記録だけ。

-- AlterTable
ALTER TABLE "entitlements"
  ADD COLUMN "claimed_by_common_user_id" TEXT,
  ADD COLUMN "wallet_delivery_status" TEXT NOT NULL DEFAULT 'not_started';

-- 配送待ちの行を掃き出すときに使う。
CREATE INDEX "entitlements_wallet_delivery_status_idx"
  ON "entitlements"("wallet_delivery_status")
  WHERE "wallet_delivery_status" <> 'delivered';

-- ★ 配送状態は 3 つだけ。文字列カラムは放っておくと何でも入る。
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_wallet_delivery_status_known"
  CHECK ("wallet_delivery_status" IN ('not_started', 'pending', 'delivered'));

-- ★ common_user_id の形式。代理店システムの契約は cu_ + 32桁hex。
--   取り違えた値（自社の account id など）をそのまま保存させない。
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_claimed_common_user_id_format"
  CHECK (
    "claimed_by_common_user_id" IS NULL
    OR "claimed_by_common_user_id" ~ '^cu_[0-9a-f]{32}$'
  );

-- ★ 受け取っていないものを配送しない。
--   「まだ誰も受け取っていないのに Wallet へ配送中」という行が作れると、
--   公開状態が DELIVERY_PENDING を名乗る。受取の事実が無いまま
--   「お届け中です」と答えることになる。
--
--   ⚠️ **知っている値だけを対象にする。**
--   `<> 'not_started'` と書くと、綴りの誤った値を入れたときに
--   この制約が先に反応し、「知らない値だ」という本当の理由が隠れる。
--   制約 1 つにつき役割 1 つ。どの規則を破ったのか分からないと運用で直せない。
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_delivery_requires_claim"
  CHECK (
    "wallet_delivery_status" NOT IN ('pending', 'delivered')
    OR "status" = 'claimed'
  );

-- ★ 受け取っていない行に受取者が残っていない。
--   取り消しや失効で status を戻したときに、受取者だけが残る事故を防ぐ。
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_claimer_requires_claim"
  CHECK ("claimed_by_common_user_id" IS NULL OR "status" = 'claimed');
