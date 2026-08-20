-- 返金と精算の設定、および注文の返金期限（UD-104 / UD-119）
--
-- ⚠️ **設定を変えても過去の記録が動かないようにするのが目的。**
--    設定はここに 1 行だけ置き、使った値は記録側へ焼き付ける。
--    詳細と禁止事項は docs/SETTLEMENT_AND_REFUND.md。

-- --------------------------------------------------------------------------
-- 1. 設定（環境ごとに 1 行）
-- --------------------------------------------------------------------------
CREATE TABLE "settlement_settings" (
  "environment"           TEXT PRIMARY KEY,
  -- 返金を受け付ける日数（決済完了から）。
  -- ⚠️ 0 は「返金を受け付けない」という正しい設定。「未設定」ではない。
  "refund_window_days"    INTEGER NOT NULL,
  -- 締めから支払いまでの月数。1 = 月末締め・翌月末払い。
  "payout_offset_months"  INTEGER NOT NULL,
  -- 最低支払額（円）。未満は翌月へ繰り越す。
  "minimum_payout_amount" INTEGER NOT NULL,
  -- 振込手数料の負担。creator / platform
  "transfer_fee_bearer"   TEXT NOT NULL,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by_account_id" UUID REFERENCES "accounts"("id") ON DELETE SET NULL
);

ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_environment_known"
  CHECK ("environment" IN ('staging', 'production'));

-- ⚠️ 上限は打ち間違いを止めるため。返金期間に 3650（10 年）と打たれると、
--    その間ずっと精算できない注文が積み上がる。気づくのは作家さまから
--    「入金がない」と言われたとき。
ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_refund_window_range"
  CHECK ("refund_window_days" BETWEEN 0 AND 180);

ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_payout_offset_range"
  CHECK ("payout_offset_months" BETWEEN 0 AND 6);

ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_minimum_payout_range"
  CHECK ("minimum_payout_amount" BETWEEN 0 AND 100000);

ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_fee_bearer_known"
  CHECK ("transfer_fee_bearer" IN ('creator', 'platform'));

-- ⚠️ **返金の窓が精算より後に閉じる設定を、DB でも止める。**
--    返金期間が精算までの猶予を超えると、「支払い済みの注文が返金される」が
--    常態になる。作家さまから返してもらう作業が毎月発生し、少額なら回収を
--    諦めることになる。28 日を 1 か月の最短として見る。
ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_window_within_payout_delay"
  CHECK ("refund_window_days" <= "payout_offset_months" * 28);

-- 初期値（2026-08-20 決定）。
-- ⚠️ **コードに `?? 14` を書かない。** 既定値はここで一度入れるだけ。
--    コードに書くと、設定行が消えたことに誰も気づかないまま動き続ける。
INSERT INTO "settlement_settings"
  ("environment", "refund_window_days", "payout_offset_months", "minimum_payout_amount", "transfer_fee_bearer")
VALUES
  ('staging',    14, 1, 1000, 'creator'),
  ('production', 14, 1, 1000, 'creator');

-- --------------------------------------------------------------------------
-- 2. 注文の返金期限
-- --------------------------------------------------------------------------
-- ⚠️ **決済確定の時点で確定して書く。** 「決済日 + 設定値」を判定のたびに
--    計算しない。計算すると、14 日 → 30 日に変えた瞬間、精算済みの注文が
--    「まだ返金できる」に化ける。
ALTER TABLE "orders" ADD COLUMN "refundable_until" TIMESTAMPTZ(6);

-- ⚠️ 支払われていない注文に期限は無い。逆に、期限があるのに未払いは矛盾。
--    ⚠️ **支払い済みでも NULL を許す。** この列より前に支払われた注文が
--    あるため（移行）。埋まっていない行は返金の判定で弾かれる。
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_refundable_until_requires_payment"
  CHECK ("refundable_until" IS NULL OR "payment_status" = 'succeeded');

-- 「返金の窓が閉じた注文だけ精算する」を引くため。
CREATE INDEX "orders_refundable_until_idx" ON "orders" ("refundable_until");
