-- 作家さまへの精算（UD-119。docs/SETTLEMENT_AND_REFUND.md §3-3）
--
-- ⚠️ **二重払いは DB で防ぐ。** payout_lines の UNIQUE (order_id) が
--    「同じ注文が 2 回精算に入る」を止める。アプリの注意力に頼らない。
--
-- ⚠️ **金額を人が直接書き換える口を作らない**（§4）。訂正は次の期間での
--    調整として行う。ここに UPDATE の経路を増やさないこと。

CREATE TABLE "payouts" (
  "id"                    UUID PRIMARY KEY,
  "creator_account_id"    UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  -- 締め月。`2026-08` の形。⚠️ 表示にも識別にも使う。
  "period_key"            TEXT NOT NULL,
  -- 締め期間。⚠️ **JST の月境界を UTC で保存する。** 開始は含み、終了は含まない。
  "period_start"          TIMESTAMPTZ(6) NOT NULL,
  "period_end"            TIMESTAMPTZ(6) NOT NULL,
  -- お支払いの期日。⚠️ 焼き付ける。設定を変えても過去の精算は動かない。
  "due_at"                TIMESTAMPTZ(6) NOT NULL,
  -- draft / confirmed / paid
  "status"                TEXT NOT NULL DEFAULT 'draft',
  "currency"              CHAR(3) NOT NULL DEFAULT 'JPY',
  -- 販売額の合計。
  "gross_amount"          INTEGER NOT NULL DEFAULT 0,
  -- 手数料の合計。
  "fee_amount"            INTEGER NOT NULL DEFAULT 0,
  -- 差し戻した額（確定済みの精算に載っていた注文の返金）。⚠️ 正の数で持つ。
  "refunded_amount"       INTEGER NOT NULL DEFAULT 0,
  -- 前月からの繰越。⚠️ マイナスもありうる。
  "carried_in_amount"     INTEGER NOT NULL DEFAULT 0,
  -- 今回のお支払額。⚠️ 最低支払額に満たなければ 0。
  "net_amount"            INTEGER NOT NULL DEFAULT 0,
  -- 翌月への繰越。⚠️ マイナスもありうる。
  "carried_out_amount"    INTEGER NOT NULL DEFAULT 0,
  -- ⚠️ **その時点の**設定。焼き付ける（SETTLEMENT_AND_REFUND.md §0 の②）。
  "minimum_payout_amount" INTEGER NOT NULL,
  "transfer_fee_bearer"   TEXT NOT NULL,
  "confirmed_at"          TIMESTAMPTZ(6),
  "paid_at"               TIMESTAMPTZ(6),
  "paid_by_account_id"    UUID REFERENCES "accounts"("id") ON DELETE SET NULL,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ⚠️ **1 作家さま × 1 締め期間 = 1 行。** 同じ期間の精算が 2 つできると、
--    どちらが正なのか誰にも分からなくなる。
CREATE UNIQUE INDEX "payouts_creator_period_key"
  ON "payouts" ("creator_account_id", "period_key");

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_status_known"
  CHECK ("status" IN ('draft', 'confirmed', 'paid'));

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_fee_bearer_known"
  CHECK ("transfer_fee_bearer" IN ('creator', 'platform'));

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_period_ordered"
  CHECK ("period_end" > "period_start");

-- ⚠️ **お支払額はマイナスにならない。** 差し引ききれない分は繰越で表す。
--    マイナスを許すと「作家さまへ請求する」形の行ができてしまう。
ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_net_not_negative" CHECK ("net_amount" >= 0);

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_gross_not_negative"
  CHECK ("gross_amount" >= 0 AND "fee_amount" >= 0 AND "refunded_amount" >= 0);

-- ⚠️ **確定した精算には、確定の時刻が必ず入る。** 入っていない confirmed は、
--    「いつ締めたか」を説明できない行になる。
ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_confirmed_has_time"
  CHECK ("status" = 'draft' OR "confirmed_at" IS NOT NULL);

-- ⚠️ **支払い済みには、支払った時刻と人が必ず入る。**
ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_paid_has_time"
  CHECK (("status" = 'paid') = ("paid_at" IS NOT NULL));

-- 締めの一覧を引くため。
CREATE INDEX "payouts_period_status_idx" ON "payouts" ("period_key", "status");
CREATE INDEX "payouts_creator_created_idx"
  ON "payouts" ("creator_account_id", "created_at" DESC);

-- --------------------------------------------------------------------------
-- 明細（注文 1 件ぶん）
-- --------------------------------------------------------------------------
CREATE TABLE "payout_lines" (
  "id"                      UUID PRIMARY KEY,
  "payout_id"               UUID NOT NULL REFERENCES "payouts"("id") ON DELETE CASCADE,
  "order_id"                UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "order_number"            TEXT NOT NULL,
  -- ⚠️ 注文時点の作品名。マスタを引き直さない。改名しても明細は変わらない。
  "artwork_title_snapshot"  TEXT NOT NULL,
  "gross_amount"            INTEGER NOT NULL,
  "fee_rate_bps"            INTEGER NOT NULL,
  "fee_amount"              INTEGER NOT NULL,
  -- ⚠️ 差し戻しはマイナス。合計だけ減らすと、作家さまが理由を読み取れない。
  "net_amount"              INTEGER NOT NULL,
  -- 確定済みの精算に載った注文の返金を、次回で差し引く行。
  "is_clawback"             BOOLEAN NOT NULL DEFAULT false,
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ⚠️ **二重払いをここで止める**（§3-3）。「同じ注文が 2 回精算に入る」を、
--    アプリの注意力ではなく制約で止める。
--    ⚠️ 差し戻しは同じ注文をもう一度指すので、売上の行だけを対象にする。
CREATE UNIQUE INDEX "payout_lines_order_key"
  ON "payout_lines" ("order_id")
  WHERE "is_clawback" = false;

-- ⚠️ 差し戻しも 1 注文 1 回まで。二度引くと作家さまから取りすぎる。
CREATE UNIQUE INDEX "payout_lines_clawback_key"
  ON "payout_lines" ("order_id")
  WHERE "is_clawback" IS TRUE;

-- ⚠️ 差し戻しは売上の行ではないので、金額を 0 に揃える。
--    揃えないと、販売額の合計が二重に積まれる。
ALTER TABLE "payout_lines"
  ADD CONSTRAINT "payout_lines_clawback_shape"
  CHECK (
    "is_clawback" IS FALSE
    OR ("gross_amount" = 0 AND "fee_amount" = 0 AND "net_amount" <= 0)
  );

ALTER TABLE "payout_lines"
  ADD CONSTRAINT "payout_lines_sale_shape"
  CHECK (
    "is_clawback" IS TRUE
    OR ("gross_amount" >= 0 AND "fee_amount" >= 0 AND "net_amount" >= 0)
  );

CREATE INDEX "payout_lines_payout_idx" ON "payout_lines" ("payout_id");
