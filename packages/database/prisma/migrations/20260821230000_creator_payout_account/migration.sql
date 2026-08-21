-- 作家さまのお振込先（P1-3・`UD-124` 決定 2026-08-21）。
--
-- ⚠️ **本人確認書類は取らない。** 口座情報の確認をもって足りるとする決定。
--    書類の画像もマイナンバーも、この仕組みは持たない。
--    **持たないと決めたものは、列そのものを作らない**——列があると、
--    いつか誰かが入れる。
--
-- ⚠️ **`UD-106`（源泉徴収の要否）はこの決定で閉じていない。** 徴収が要ると
--    判明した場合、支払調書のためにマイナンバーの取り扱いが別途必要になる。
--    そのときは**別の表**として設計すること（番号法の分離保管が要る）。

CREATE TABLE "creator_payout_accounts" (
  -- ⚠️ **作家さま 1 人につき 1 件。** 主キーをアカウントIDにして、
  --    2 件目が作れないようにする。「どちらへ振り込むか」を人が選ぶ形に
  --    すると、選び間違いが送金の間違いになる。
  "creator_account_id"     UUID PRIMARY KEY
    REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "bank_name"              TEXT NOT NULL,
  "branch_name"            TEXT NOT NULL,
  -- ordinary / checking
  "account_type"           TEXT NOT NULL,
  -- 口座番号（包んだもの）。
  -- ⚠️ **平文の列を作らない。** 作れば、いつか誰かがそちらへ書く。
  "account_number_ciphertext" TEXT NOT NULL,
  "account_number_nonce"      TEXT NOT NULL,
  "account_number_auth_tag"   TEXT NOT NULL,
  "key_version"               TEXT NOT NULL,
  -- 画面用に伏せた表記（`***4567`）。⚠️ **ここから元へは戻せない。**
  "masked_account_number"  TEXT NOT NULL,
  "account_holder_kana"    TEXT NOT NULL,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 知らない種別を弾く。⚠️ 振込の依頼書に載る値なので、自由文にしない。
ALTER TABLE "creator_payout_accounts"
  ADD CONSTRAINT "creator_payout_accounts_type_known"
  CHECK ("account_type" IN ('ordinary', 'checking'));

-- 空文字で埋めさせない。
-- ⚠️ **`NOT NULL` だけでは空文字を止められない。** 空のまま登録できると、
--    画面には「登録済み」と出るのに振り込めない。
ALTER TABLE "creator_payout_accounts"
  ADD CONSTRAINT "creator_payout_accounts_no_blanks"
  CHECK (
    length(btrim("bank_name")) > 0
    AND length(btrim("branch_name")) > 0
    AND length(btrim("account_holder_kana")) > 0
    AND length(btrim("account_number_ciphertext")) > 0
    AND length(btrim("masked_account_number")) > 0
  );

-- 伏せた表記が、伏せた表記であること。
-- ⚠️ **平文をここへ入れる実装ミスを、DB の側でも止める。** アプリの
--    `maskAccountNumber` を通していれば必ず `***` で始まる。
ALTER TABLE "creator_payout_accounts"
  ADD CONSTRAINT "creator_payout_accounts_masked_is_masked"
  CHECK ("masked_account_number" LIKE '***%');

-- お振込先が変わったことの知らせ（P1-3）。
--
-- ⚠️ **お金の行き先が変わることを、ご本人へ知らせる。** 乗っ取られた側から
--    見れば、いちばん実入りのある操作である。気づけるのは本人だけ。
ALTER TABLE "notification_templates"
  DROP CONSTRAINT IF EXISTS "notification_templates_event_type_known";

ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_event_type_known"
  CHECK ("event_type" IN (
    'order.placed', 'payment.succeeded', 'payment.failed', 'payment.expired',
    'wallet.registration_requested', 'entitlement.delivered', 'wallet.delivery_stalled',
    'refund.requested', 'refund.completed', 'legal.revised', 'payout_account.changed'
  ));

ALTER TABLE "notification_deliveries"
  DROP CONSTRAINT IF EXISTS "notification_deliveries_event_type_known";

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_event_type_known"
  CHECK ("event_type" IN (
    'order.placed', 'payment.succeeded', 'payment.failed', 'payment.expired',
    'wallet.registration_requested', 'entitlement.delivered', 'wallet.delivery_stalled',
    'refund.requested', 'refund.completed', 'legal.revised', 'payout_account.changed'
  ));

ALTER TABLE "notification_deliveries"
  DROP CONSTRAINT IF EXISTS "notification_deliveries_subject_type_known";

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_subject_type_known"
  CHECK ("subject_type" IN ('order', 'entitlement', 'refund', 'legal_version', 'payout_account'));

-- 既定の文面。
--
-- ⚠️ **新しい口座の情報を載せない。** 載せると、乗っ取った側がこのメールを
--    見れば済むことになる。載せるのは「変わったこと」と「覚えが無ければ
--    ご連絡を」まで。
--
-- ⚠️ **「お心当たりがなければ」を必ず入れる。** これが無いと、ただの
--    完了通知になり、乗っ取りに気づく手がかりにならない。
INSERT INTO "notification_templates"
  ("id", "event_type", "version", "subject", "body", "status", "published_at", "updated_at")
VALUES
  (gen_random_uuid(), 'payout_account.changed', 1,
   '【{{siteName}}】お振込先の登録内容が変更されました',
   E'お振込先の登録内容が変更されましたので、お知らせいたします。\n\n'
   '変更された日時: {{changedAt}}\n\n'
   'お心当たりがない場合は、お手数ですが至急ご連絡ください。\n{{contactUrl}}\n\n'
   '※ このお知らせに、変更後の口座情報は記載しておりません。\n'
   '　ご確認は{{siteName}}にログインのうえ、お店の情報の画面からお願いいたします。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
