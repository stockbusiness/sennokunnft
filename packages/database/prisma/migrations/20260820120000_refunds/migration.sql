-- 返金の記録（UD-104 / UD-120。docs/SETTLEMENT_AND_REFUND.md §3-2）
--
-- ⚠️ **追記のみ。取り消す口を作らない。** 間違えたら再課金であって、
--    記録を消すことではない。UPDATE で状態を進めるだけにする。

CREATE TABLE "refunds" (
  "id"                  UUID PRIMARY KEY,
  "order_id"            UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  -- どの決済を戻したか。⚠️ 世代の鍵はここから解決する（UD-118）。
  -- ⚠️ NULL を許すのは、決済行が特定できない事業者発の返金があるため。
  --    そのときは記録だけ残す。
  "payment_id"          UUID REFERENCES "payments"("id") ON DELETE RESTRICT,
  -- 戻した額（円）。⚠️ 最小通貨単位の整数。
  "amount"              INTEGER NOT NULL,
  "currency"            CHAR(3) NOT NULL,
  -- こちらで決めた符号。⚠️ 事業者の文言をそのまま入れない。
  "reason"              TEXT NOT NULL,
  -- admin / provider。⚠️ 事業者の画面からの返金を「運営の誰か」に丸めない。
  "initiated_by"        TEXT NOT NULL,
  -- 誰が行ったか。provider なら NULL。
  "actor_account_id"    UUID REFERENCES "accounts"("id") ON DELETE SET NULL,
  -- requested / succeeded / failed
  "status"              TEXT NOT NULL DEFAULT 'requested',
  -- 事業者側の識別子。⚠️ 二重反映を防ぐ鍵。
  "provider_refund_ref" TEXT,
  -- 失敗の分類。⚠️ 事業者の符号をそのまま入れない。
  "failure_code"        TEXT,
  -- 運用の注記。⚠️ 事業者の応答本文を入れない。
  "note"                TEXT,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "settled_at"          TIMESTAMPTZ(6)
);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_status_known"
  CHECK ("status" IN ('requested', 'succeeded', 'failed'));

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_reason_known"
  CHECK ("reason" IN ('buyer_request', 'our_fault', 'provider_initiated'));

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_initiated_by_known"
  CHECK ("initiated_by" IN ('admin', 'provider'));

-- ⚠️ **事業者の画面からの返金に、運営の誰かを紐づけさせない。**
--    紐づくと、こちらを経由した返金と見分けが付かなくなる。
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_provider_has_no_actor"
  CHECK ("initiated_by" <> 'provider' OR "actor_account_id" IS NULL);

-- ⚠️ **成立した返金には、いつ成立したかが必ず入る。**
--    入っていない succeeded は、精算の「返金済みを除く」を狂わせる。
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_settled_has_time"
  CHECK (("status" = 'succeeded') = ("settled_at" IS NOT NULL));

-- ⚠️ **同じ返金を 2 回積まない。** こちらから投げた返金にも、あとから
--    charge.refunded が届く。アプリの注意力ではなく制約で止める。
--    部分索引にしてあるのは、まだ投げていない行（NULL）を除くため。
CREATE UNIQUE INDEX "refunds_provider_ref_key"
  ON "refunds" ("provider_refund_ref")
  WHERE "provider_refund_ref" IS NOT NULL;

CREATE INDEX "refunds_order_created_idx" ON "refunds" ("order_id", "created_at" DESC);

-- 事業者へ届かないまま残った行を洗い出すため。
CREATE INDEX "refunds_status_created_idx" ON "refunds" ("status", "created_at");

-- --------------------------------------------------------------------------
-- 注文の返金状態
-- --------------------------------------------------------------------------
-- ⚠️ **返金済みの注文に、返金の記録が無い状態を作らせない。**
--    Stripe の画面から返金され、追随に失敗した注文がここに引っかかる。
--    ……という制約は書けない（行を跨ぐため）。代わりに索引を張って、
--    運用で洗い出せるようにする。
CREATE INDEX "orders_refund_status_idx" ON "orders" ("refund_status", "paid_at" DESC);
