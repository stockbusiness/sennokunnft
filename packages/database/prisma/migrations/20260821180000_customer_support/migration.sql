-- 顧客サポート（実運営 指示書 P1-1）。
--
-- ⚠️ すべて追加型。既存テーブル・既存データへの変更は無い。
--
-- ⚠️ **氏名とメールアドレスの平文を保存する列を作らない**（`UD-503`）。
--    列が無ければ、あとから「ここに入れておこう」ができない。

-- アカウント単位の申し送り。
--
-- ⚠️ **注文単位のメモ（`order_notes`）とは別。** あちらは「この注文で何が
--    あったか」、こちらは「この方について何を知っておくべきか」。
--    片方に寄せると、注文をまたぐ事情（重複アカウント、代理のご連絡先など）が
--    どの注文にも属さないまま行き場を失う。
CREATE TABLE "account_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    -- ⚠️ 書いた運営スタッフ。氏名やメールではなくアカウントIDで持つ。
    "author_account_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "account_notes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "account_notes"
  ADD CONSTRAINT "account_notes_account_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT;

ALTER TABLE "account_notes"
  ADD CONSTRAINT "account_notes_author_fkey"
  FOREIGN KEY ("author_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT;

-- ★ 空のメモを残させない。空行が並ぶと、読む人が全部読み飛ばす。
ALTER TABLE "account_notes"
  ADD CONSTRAINT "account_notes_body_present"
  CHECK (btrim("body") <> '');

-- ★ 長文の置き場にしない。
ALTER TABLE "account_notes"
  ADD CONSTRAINT "account_notes_body_length"
  CHECK (char_length("body") <= 2000);

CREATE INDEX "account_notes_account_created_at_idx"
  ON "account_notes" ("account_id", "created_at" DESC);

-- ご連絡先の変更申請。
--
-- ⚠️ **ここでアドレスは変わらない。** 認証の正は認証基盤側にあり、
--    こちらが持つのは照合用の値だけ（`UD-503`）。この表が受け持つのは
--    「申し出があった」「本人確認をした」「向こうで変えた」の 3 つの記録。
--
-- ⚠️ **新しいアドレスの平文を持たない。** 伏せた表記と照合用の値まで。
CREATE TABLE "email_change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    -- ⚠️ 伏せた表記（`t*****@e******.jp`）。**ここから元へは戻せない。**
    "requested_masked_email" TEXT NOT NULL,
    -- ⚠️ 鍵付きハッシュ。重複の確認と、あとからの突き合わせにだけ使う。
    "requested_email_hash" TEXT NOT NULL,
    -- requested / identity_verified / completed / rejected
    "status" TEXT NOT NULL DEFAULT 'requested',
    -- 本人確認の方法。⚠️ 自由文にしない（何をしたか分からなくなる）。
    "verification_method" TEXT,
    "verified_by_account_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "settled_by_account_id" UUID,
    "settled_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "opened_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "email_change_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_account_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT;

ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_opened_by_fkey"
  FOREIGN KEY ("opened_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT;

ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_verified_by_fkey"
  FOREIGN KEY ("verified_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT;

ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_settled_by_fkey"
  FOREIGN KEY ("settled_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT;

-- ★ 状態の語彙を縛る。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_status_known"
  CHECK ("status" IN ('requested', 'identity_verified', 'completed', 'rejected'));

-- ★ 本人確認の方法の語彙を縛る。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_method_known"
  CHECK (
    "verification_method" IS NULL
    OR "verification_method" IN ('existing_contact_reply', 'order_details_match', 'identity_document')
  );

-- ★ **本人確認を飛ばして「済」にできない。**
--   アプリの判定に穴が開いたときに残る最後の砦。飛ばされたことは、
--   乗っ取られるまで誰にも分からない。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_completed_requires_verification"
  CHECK (
    "status" <> 'completed'
    OR ("verification_method" IS NOT NULL AND "verified_by_account_id" IS NOT NULL AND "verified_at" IS NOT NULL)
  );

-- ★ 本人確認は「誰が・いつ・どうやって」がそろって初めて記録になる。
--   ⚠️ PostgreSQL の CHECK は式が NULL のとき通るので、`IS TRUE` で受ける。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_verification_complete"
  CHECK (
    (("verification_method" IS NULL) = ("verified_by_account_id" IS NULL)) IS TRUE
    AND (("verification_method" IS NULL) = ("verified_at" IS NULL)) IS TRUE
  );

-- ★ 決着は「誰が・いつ」がそろう。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_settlement_complete"
  CHECK ((("settled_by_account_id" IS NULL) = ("settled_at" IS NULL)) IS TRUE);

-- ★ 決着した状態には、決着の記録がある。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_settled_has_record"
  CHECK (
    "status" NOT IN ('completed', 'rejected')
    OR ("settled_by_account_id" IS NOT NULL AND "settled_at" IS NOT NULL)
  );

-- ★ 見送るなら理由を書く。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_rejection_has_note"
  CHECK ("status" <> 'rejected' OR ("note" IS NOT NULL AND btrim("note") <> ''));

-- ★ 覚え書きの長さ。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_note_length"
  CHECK ("note" IS NULL OR char_length("note") <= 1000);

-- ★ **伏せていない宛先を保存させない**（`UD-503`）。
--   通知の送信履歴と同じ縛り。制約を迂回した書き込みを、ここで止める。
ALTER TABLE "email_change_requests"
  ADD CONSTRAINT "email_change_requests_masked_recipient"
  CHECK ("requested_masked_email" LIKE '%*%');

CREATE INDEX "email_change_requests_account_created_at_idx"
  ON "email_change_requests" ("account_id", "created_at" DESC);

-- ⚠️ **同じ方について、決着していない申請は 1 件まで。**
--    2 件並ぶと、どちらを本人確認したのか分からなくなる。
--    Prisma では条件付き索引を書けないため、ここにだけ存在する。
CREATE UNIQUE INDEX "email_change_requests_one_open_per_account"
  ON "email_change_requests" ("account_id")
  WHERE "status" IN ('requested', 'identity_verified');
