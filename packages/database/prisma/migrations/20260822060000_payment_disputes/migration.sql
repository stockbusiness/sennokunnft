-- チャージバック（決済の争い）を受ける（2026-08-22）
--
-- ⚠️ **争いが起きたことと、返金されたことは別である。** 申し立てを受けた
--    時点では、まだ何も返っていない。ここで受取権を取り消すと、**こちらが
--    勝ったときに、取り上げたものを返せない**——外部のウォレットへ渡した
--    ものは、こちらからは戻せない。
--
-- ⚠️ **`refunds` に混ぜない。** あちらは「返した」の記録で、こちらは
--    「争われている」の記録である。混ぜると、争いが起きただけの注文が
--    返金済みとして精算から外れる。
--
-- ⚠️ **表を持つのは、精算を止めるためでもある。** 争いの最中に作家さまへ
--    お支払いすると、負けたときに返してもらう話になる。いちばん揉める
--    作業で、少額なら回収を諦めることになり、諦めた分は運営の損になる。

CREATE TABLE "payment_disputes" (
  "id"          UUID PRIMARY KEY,
  "order_id"    UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  -- ⚠️ 決済行が特定できないこともある。争いの記録そのものは残す。
  "payment_id"  UUID REFERENCES "payments"("id") ON DELETE RESTRICT,
  "provider"    TEXT NOT NULL,
  -- 事業者が採番した争いの識別子。
  "dispute_ref" TEXT NOT NULL,
  "status"      TEXT NOT NULL,
  -- 事業者が言う理由。⚠️ **許可リストを通した符号のみ。**
  --    カード会社の事情をそのまま保存しない。
  "reason"      TEXT NOT NULL DEFAULT 'unknown',
  -- ⚠️ **争われている額。** 注文の総額と一致するとは限らない。
  "amount"      INTEGER NOT NULL,
  "currency"    TEXT NOT NULL,
  "opened_at"   TIMESTAMPTZ(6) NOT NULL,
  "closed_at"   TIMESTAMPTZ(6),
  -- 敗訴で作った返金。⚠️ 負けるまで NULL。
  "refund_id"   UUID REFERENCES "refunds"("id") ON DELETE RESTRICT,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

/*
  ⚠️ **同じ争いを 2 行にしない。** 申し立て・審理・決着で別々の知らせが
     届く。識別子で束ねないと、1 件の争いが 3 件に増え、精算が
     3 重に止まる。
*/
CREATE UNIQUE INDEX "payment_disputes_provider_ref_unique"
  ON "payment_disputes" ("provider", "dispute_ref");

-- ⚠️ **状態の語彙を閉じる。** 自由文にすると、綴りを間違えた行が
--    「決着していない争い」として永久に精算を止める。
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_status_known"
  CHECK ("status" IN ('warning', 'needs_response', 'under_review', 'won', 'lost'));

ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_reason_known"
  CHECK ("reason" IN (
    'fraudulent', 'product_not_received', 'product_unacceptable', 'duplicate',
    'subscription_canceled', 'unrecognized', 'credit_not_processed', 'general', 'unknown'
  ));

ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_amount_positive"
  CHECK ("amount" > 0);

/*
  ⚠️ **決着したら時刻が要る。** 無いまま `won` / `lost` にできると、
     「いつ終わったのか」が読めない。返金の期限や証拠の保管期間を
     数える起点が消える。
*/
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_closed_has_time"
  CHECK (("status" IN ('won', 'lost')) = ("closed_at" IS NOT NULL));

/*
  ⚠️ **返金を紐づけてよいのは敗訴だけ。** 勝った争いに返金が付いていたら、
     どこかで取り違えている。
*/
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_refund_only_when_lost"
  CHECK ("refund_id" IS NULL OR "status" = 'lost');

CREATE INDEX "payment_disputes_order_idx" ON "payment_disputes" ("order_id");

/*
  精算を止めるために引く索引。

  ⚠️ **警告は含めない。** カード会社が調べ始めただけで、申し立てに
     ならずに消えることもある。含めると、消えた警告のぶんまで精算を
     止め、作家さまへのお支払いが理由なく遅れる。
*/
CREATE INDEX "payment_disputes_open_idx"
  ON "payment_disputes" ("order_id")
  WHERE "status" IN ('needs_response', 'under_review');
