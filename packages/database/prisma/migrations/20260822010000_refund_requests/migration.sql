-- 返金の申請と審査（方針整理 2026-08-22）
--
-- **これまで、返金は運営が注文の画面から直に実行するだけだった。** 誰が
-- 申し出て、誰が調べ、誰が承認したのかが残らない。ここでは
-- **申請 → 審査 → 可否 → 実行**を、記録の残る手続きとして扱う。
--
-- ⚠️ **既存の `refunds` を置き換えない。** あちらは決済事業者への返金
--    そのものの記録で、こちらはその手前の手続きである。1 つにまとめると、
--    事業者へ投げていない申請と投げた返金が同じ表に混ざる。
--
-- ⚠️ **既存の行に触れる移行を書かない。** これまでの返金は申請を持たない
--    （`refunds.request_id` は NULL）。埋め戻すと、無かった手続きを
--    あったことにしてしまう。

CREATE TABLE "refund_requests" (
  "id"                       UUID PRIMARY KEY,
  "order_id"                 UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "status"                   TEXT NOT NULL DEFAULT 'submitted',
  "reason"                   TEXT NOT NULL,
  -- ⚠️ 理由から決まる。人が選び直せない（アプリ側の `categoryOf`）。
  "category"                 TEXT NOT NULL,
  -- 運営の書き込み。⚠️ 購入者には見せない。
  "note"                     TEXT,
  -- 購入者が書いた申し出。⚠️ 文字として扱う（HTML にしない）。
  "buyer_statement"          TEXT,
  "amount"                   INTEGER NOT NULL,
  "is_full_refund"           BOOLEAN NOT NULL,
  -- revoke / keep。⚠️ 一部返金では運営が承認のときに指定する。
  "entitlement_disposition"  TEXT NOT NULL DEFAULT 'keep',
  "requested_by_account_id"  UUID REFERENCES "accounts"("id") ON DELETE SET NULL,
  "reviewed_by_account_id"   UUID REFERENCES "accounts"("id") ON DELETE SET NULL,
  "approved_by_account_id"   UUID REFERENCES "accounts"("id") ON DELETE SET NULL,
  "dual_approval_required"   BOOLEAN NOT NULL DEFAULT FALSE,
  -- 原則対象外を、運営が例外として通したか。
  "approved_as_exception"    BOOLEAN NOT NULL DEFAULT FALSE,
  "rejection_note"           TEXT,
  -- 実行してできた返金の行。⚠️ 実行するまで NULL。
  "refund_id"                UUID REFERENCES "refunds"("id") ON DELETE RESTRICT,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ⚠️ **状態の語彙を閉じる。** 自由文にすると、綴りを間違えた行が
--    どの一覧にも出ないまま残る。
ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_status_known"
  CHECK ("status" IN (
    'submitted', 'creator_review', 'reviewed', 'approval_pending',
    'approved', 'rejected', 'executing', 'executed', 'execution_failed'
  ));

ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_category_known"
  CHECK ("category" IN ('operator_only', 'creator_confirmation', 'excluded'));

ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_disposition_known"
  CHECK ("entitlement_disposition" IN ('revoke', 'keep'));

-- ⚠️ **0 円の返金申請を作らない。** 記録だけが残り、何も起きない行になる。
ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_amount_positive"
  CHECK ("amount" > 0);

/*
  ⚠️ **二重承認は「別の人」でなければ成立しない。**
     同じ人が申請して承認できるなら、承認の欄が 1 つ増えただけで
     歯止めにならない。アプリ側でも見るが、**DB でも止める**——
     アプリを通さない書き込みがありうる。
*/
ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_dual_approval_distinct"
  CHECK (
    NOT "dual_approval_required"
    OR "approved_by_account_id" IS NULL
    OR "requested_by_account_id" IS NULL
    OR "approved_by_account_id" <> "requested_by_account_id"
  );

/*
  ⚠️ **却下には理由が要る。** 理由の無い却下は、購入者にも運営自身にも
     説明できない。
*/
ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_rejection_has_note"
  CHECK ("status" <> 'rejected' OR "rejection_note" IS NOT NULL);

/*
  ⚠️ **実行済みには返金の行が要る。** 無いまま `executed` にすると、
     「返金した」という記録だけがあって、返金そのものが無い状態になる。
*/
ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_executed_has_refund"
  CHECK ("status" <> 'executed' OR "refund_id" IS NOT NULL);

/*
  ⚠️ **同じ注文に、決着していない申請を 2 つ作らない。** 作れると、
     2 人が別々に承認して**二重返金**になる。部分 UNIQUE 索引で止める。
  ⚠️ Prisma では条件付き索引を書けないため、**ここにだけ存在する**。
*/
CREATE UNIQUE INDEX "refund_requests_open_per_order"
  ON "refund_requests" ("order_id")
  WHERE "status" NOT IN ('rejected', 'executed');

CREATE INDEX "refund_requests_status_created_idx"
  ON "refund_requests" ("status", "created_at" DESC);
CREATE INDEX "refund_requests_order_idx" ON "refund_requests" ("order_id");

-- 手続きの証跡（追記のみ）
--
-- ⚠️ **監査ログ（`audit_logs`）と別に持つ。** あちらは運営の操作全般で、
--    こちらは**この申請に何が起きたか**を時系列で読むためのもの。
--    1 つにまとめると、1 件の申請を追うのに全操作から拾い集めることになる。
CREATE TABLE "refund_request_events" (
  "id"               UUID PRIMARY KEY,
  "request_id"       UUID NOT NULL REFERENCES "refund_requests"("id") ON DELETE RESTRICT,
  "action"           TEXT NOT NULL,
  "actor_account_id" UUID REFERENCES "accounts"("id") ON DELETE SET NULL,
  -- ⚠️ **金額と符号まで。** 購入者の申し出の本文をここへ写さない。
  "summary"          JSONB NOT NULL DEFAULT '{}',
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "refund_request_events_request_idx"
  ON "refund_request_events" ("request_id", "created_at");

/*
  ⚠️ **追記のみ。** 訂正は新しい行を足して表す。書き換えられる証跡は、
     証跡ではない。アプリに更新・削除の口を作らないだけでは足りない——
     **アプリを通さない書き込み**も止める。
*/
CREATE OR REPLACE FUNCTION "refund_request_events_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '返金申請の証跡は追記のみです（refund_request_events_append_only）。'
    '訂正は新しい記録を足して表してください。';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_request_events_no_update"
  BEFORE UPDATE ON "refund_request_events"
  FOR EACH ROW EXECUTE FUNCTION "refund_request_events_append_only"();

CREATE TRIGGER "refund_request_events_no_delete"
  BEFORE DELETE ON "refund_request_events"
  FOR EACH ROW EXECUTE FUNCTION "refund_request_events_append_only"();

-- 作家さまへの事実確認
--
-- ⚠️ **回答は任意である。** 期限が来れば運営だけで進める。「答えないと
--    返金できない」にすると、答えない作家さまがいるだけで購入者が待たされる。
CREATE TABLE "creator_refund_inquiries" (
  "id"                 UUID PRIMARY KEY,
  -- ⚠️ 申請 1 件につき 1 回。何度も聞き直す形にしない（期限が意味を失う）。
  "request_id"         UUID NOT NULL UNIQUE
                         REFERENCES "refund_requests"("id") ON DELETE RESTRICT,
  "creator_account_id" UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "asked_at"           TIMESTAMPTZ(6) NOT NULL,
  "due_at"             TIMESTAMPTZ(6) NOT NULL,
  "answered_at"        TIMESTAMPTZ(6),
  -- 作家さまの回答。⚠️ 文字として扱う。
  "answer"             TEXT,
  -- 添付の保管庫の鍵。⚠️ URL ではなく鍵で持つ（保管庫を替えられるように）。
  "attachment_keys"    TEXT[] NOT NULL DEFAULT '{}',
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

/*
  ⚠️ **答えた時刻と中身は、そろっているか丸ごと無いか。** 片方だけの行は
     「答えたのに中身が無い」を静かに作る。
*/
ALTER TABLE "creator_refund_inquiries"
  ADD CONSTRAINT "creator_refund_inquiries_answer_complete"
  CHECK (("answered_at" IS NULL) = ("answer" IS NULL));

-- ⚠️ **期限は依頼より後。** 逆だと、依頼した瞬間に切れている。
ALTER TABLE "creator_refund_inquiries"
  ADD CONSTRAINT "creator_refund_inquiries_due_after_asked"
  CHECK ("due_at" > "asked_at");

CREATE INDEX "creator_refund_inquiries_creator_idx"
  ON "creator_refund_inquiries" ("creator_account_id", "due_at");

-- 作家さまからの回収待ち
--
-- ⚠️ **これは請求書ではない。** 記録であって、取り立ての仕組みではない。
-- ⚠️ **既存の繰越（`carried_out_amount`）を置き換えない。** あちらは
--    「精算 1 件のなかで引ききれなかった額」で、こちらは
--    **「精算をまたいで残っている額」**である。
CREATE TABLE "creator_receivables" (
  "id"                 UUID PRIMARY KEY,
  "creator_account_id" UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "order_id"           UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  -- ⚠️ **正の数**で持つ。符号は使う側が付ける。
  "amount"             INTEGER NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'outstanding',
  "settled_by_account_id" UUID REFERENCES "accounts"("id") ON DELETE SET NULL,
  "settled_at"         TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE "creator_receivables"
  ADD CONSTRAINT "creator_receivables_status_known"
  CHECK ("status" IN ('outstanding', 'offset', 'settled', 'written_off'));

ALTER TABLE "creator_receivables"
  ADD CONSTRAINT "creator_receivables_amount_positive"
  CHECK ("amount" > 0);

/*
  ⚠️ **決着した行には、いつ・誰が、が要る。** 無いまま `settled` にできると、
     「いつの間にか消えていた」を作れる。
*/
ALTER TABLE "creator_receivables"
  ADD CONSTRAINT "creator_receivables_settled_has_time"
  CHECK (("status" = 'outstanding') = ("settled_at" IS NULL));

/*
  ⚠️ **同じ注文で回収待ちを 2 行作らない。** 作れると、1 回の返金で
     二重に取り立てることになる。
*/
CREATE UNIQUE INDEX "creator_receivables_order_unique"
  ON "creator_receivables" ("order_id");

CREATE INDEX "creator_receivables_creator_status_idx"
  ON "creator_receivables" ("creator_account_id", "status");

-- 既存の返金へ、申請への参照を足す
--
-- ⚠️ **NULL 可のまま。** これまでの返金は申請を持たない。埋め戻すと、
--    無かった手続きをあったことにしてしまう。
ALTER TABLE "refunds" ADD COLUMN "request_id" UUID
  REFERENCES "refund_requests"("id") ON DELETE RESTRICT;

CREATE INDEX "refunds_request_idx" ON "refunds" ("request_id");

-- 返金の取り決めへ、期限としきい値を足す
--
-- ⚠️ **定数で埋めない。** 運用が始まってから必ず調整することになる。
ALTER TABLE "settlement_settings"
  -- 作家さまの回答期限（営業日）。⚠️ **祝日は見ていない**（表を持たないため）。
  ADD COLUMN "creator_inquiry_business_days" INTEGER NOT NULL DEFAULT 3,
  -- 二重承認が要る金額。⚠️ **NULL は「二重承認を使わない」。**
  --    0 を「常に要る」の意味に使わない——設定を消し忘れたのか、
  --    全件に課したいのかが読めなくなる。
  ADD COLUMN "dual_approval_threshold_amount" INTEGER;

ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_inquiry_days_range"
  CHECK ("creator_inquiry_business_days" BETWEEN 1 AND 20);

ALTER TABLE "settlement_settings"
  ADD CONSTRAINT "settlement_settings_dual_threshold_positive"
  CHECK ("dual_approval_threshold_amount" IS NULL OR "dual_approval_threshold_amount" > 0);
