-- 購入者への知らせ（実運営 指示書 P0-4）。
--
-- ⚠️ すべて追加型。既存テーブル・既存データへの変更は無い。
-- ⚠️ 宛先の平文を保存する列を作らない（UD-503）。伏せた表記と
--    照合用ハッシュだけを持ち、アドレスは送信の瞬間に認証基盤から取り直す。

-- ============================================================================
-- 1. 文面（版管理）
-- ============================================================================

CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(6),
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- ★ 版を上書きさせない。同じ種別の同じ版は 1 行だけ。
CREATE UNIQUE INDEX "notification_templates_event_version_unique"
  ON "notification_templates"("event_type", "version");

CREATE INDEX "notification_templates_event_type_status_idx"
  ON "notification_templates"("event_type", "status");

-- ★ **外部キーを張らない。** 文面はアカウントより長生きしてよい。
--   書いた人が退職して行が消えても、その文面で送った履歴は残り続ける。
--   参照を張ると、アカウント側の削除制約に文面が引きずられる
--   （運用確認キューの `order_id` と同じ考え方）。
--   ⚠️ 「誰が書いたか」は監査ログにも残る。ここは辿るための控えである。

-- ★ 送る種別は 9 つだけ。綴りの違う行を作れると、送る段で「文面が無い」に
--   なる。止まった知らせは誰にも気づかれないまま溜まるので、手前で潰す。
ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_event_type_known"
  CHECK ("event_type" IN (
    'order.placed',
    'payment.succeeded',
    'payment.failed',
    'payment.expired',
    'wallet.registration_requested',
    'entitlement.delivered',
    'wallet.delivery_stalled',
    'refund.requested',
    'refund.completed'
  ));

ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_status_known"
  CHECK ("status" IN ('draft', 'published'));

-- ★ 版は 1 から。
ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_version_positive" CHECK ("version" >= 1);

-- ★ 「公開した」と「公開した時刻」を分離させない。
--   片方だけ立っていると、いつから有効だったのかを誰も答えられない。
ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_published_at_matches_status"
  CHECK (("published_at" IS NOT NULL) = ("status" = 'published'));

-- ★ 空の文面を公開させない。⚠️ draft は書きかけを許す。
ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_published_has_content"
  CHECK (
    "status" <> 'published'
    OR (length(btrim("subject")) > 0 AND length(btrim("body")) > 0)
  );

-- ★ 件名に改行を入れさせない。ヘッダへ改行が入ると、そこから先を
--   別のヘッダとして解釈されうる。文面の都合ではなく送信の安全の話。
ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_subject_single_line"
  CHECK ("subject" !~ '[\r\n]');

-- ============================================================================
-- 2. 送信待ちと送信履歴
-- ============================================================================

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "rendered_subject" TEXT NOT NULL,
    "rendered_body" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_retry_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- ⚠️ 平文のアドレスを入れる列ではない（UD-503）。
    "masked_recipient" TEXT,
    "recipient_hash" TEXT,
    "provider_message_id" TEXT,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "skipped_reason_code" TEXT,
    "correlation_id" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- ★ 重複送信を止める最後の砦。
--   同じ Webhook が 10 回届いても、同じ知らせは 1 通しか積まれない。
--   アプリ側の存在チェックは並行実行で破れるが、この索引は破れない。
CREATE UNIQUE INDEX "notification_deliveries_event_subject_unique"
  ON "notification_deliveries"("event_type", "subject_type", "subject_id");

CREATE INDEX "notification_deliveries_status_next_retry_at_idx"
  ON "notification_deliveries"("status", "next_retry_at");

CREATE INDEX "notification_deliveries_account_id_created_at_idx"
  ON "notification_deliveries"("account_id", "created_at");

CREATE INDEX "notification_deliveries_subject_id_idx"
  ON "notification_deliveries"("subject_id");

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_event_type_known"
  CHECK ("event_type" IN (
    'order.placed',
    'payment.succeeded',
    'payment.failed',
    'payment.expired',
    'wallet.registration_requested',
    'entitlement.delivered',
    'wallet.delivery_stalled',
    'refund.requested',
    'refund.completed'
  ));

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_subject_type_known"
  CHECK ("subject_type" IN ('order', 'entitlement', 'refund'));

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_status_known"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD', 'SKIPPED'));

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_attempt_count_non_negative"
  CHECK ("attempt_count" >= 0);

-- ★ 上限は 1 回以上。0 にすると一度も送らずに DEAD になる行が作れる。
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_max_attempts_positive"
  CHECK ("max_attempts" >= 1);

-- ★ 「送った」と「送った時刻」を分離させない。
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_sent_at_matches_status"
  CHECK (("sent_at" IS NOT NULL) = ("status" = 'SENT'));

-- ★ 送らずに閉じたなら理由が要る。理由の無い SKIPPED は、
--   あとから見た人が「なぜ送っていないのか」を答えられない。
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_skipped_has_reason"
  CHECK (("skipped_reason_code" IS NOT NULL) = ("status" = 'SKIPPED'));

-- ★ 伏せた宛先に `@` より前の平文が残らないようにする、ではなく
--   **平文そのものを入れさせない**ための最低限の形式検査（UD-503）。
--   伏せ字（`*`）を必ず含む形だけを許す。
--   ⚠️ これは万全な検査ではない。列の意味を宣言し、素の代入を目立たせるためのもの。
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_recipient_is_masked"
  CHECK ("masked_recipient" IS NULL OR "masked_recipient" LIKE '%*%');

-- ★ 版は 1 から。
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_template_version_positive"
  CHECK ("template_version" >= 1);

-- ============================================================================
-- 3. 既定の文面（版 1）
-- ============================================================================
--
-- ⚠️ **コードへ書かない代わりに、ここで 1 度だけ入れる。** 以後は管理画面から
--    新しい版を作って直す。この行を書き換えない。
-- ⚠️ 文面に氏名・メールアドレスを差し込まない（UD-503）。差し込める語彙は
--    ドメイン側（NOTIFICATION_VARIABLES）で閉じてある。
-- ⚠️ Web3 用語を出さない（NFT →「作品」、Wallet →「受取用のウォレット」、
--    Mint →「発行」）。40 代以上に伝わる言葉で書く。
-- ⚠️ 「値上がり」「利益」「投資」を書かない。

INSERT INTO "notification_templates"
  ("id", "event_type", "version", "subject", "body", "status", "published_at", "updated_at")
VALUES
  (gen_random_uuid(), 'order.placed', 1,
   '【{{siteName}}】ご注文を承りました（{{orderNumber}}）',
   E'ご注文ありがとうございます。\n\n'
   'ご注文番号: {{orderNumber}}\n'
   'お支払い金額: {{totalAmount}}（税込）\n\n'
   'お支払いはこちらからお進みください。\n{{payUrl}}\n\n'
   'お手続きの期限は {{expiresAt}} です。\n'
   '期限を過ぎますとお取り置きを解かせていただきます。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'payment.succeeded', 1,
   '【{{siteName}}】お支払いを確認しました（{{orderNumber}}）',
   E'お支払いを確認いたしました。ありがとうございます。\n\n'
   'ご注文番号: {{orderNumber}}\n'
   'お支払い金額: {{totalAmount}}（税込）\n\n'
   'ご注文の内容はこちらからご確認いただけます。\n{{orderUrl}}\n\n'
   '作品のお受け取りの準備が整いましたら、あらためてご連絡いたします。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'payment.failed', 1,
   '【{{siteName}}】お支払いが完了しませんでした（{{orderNumber}}）',
   E'お支払いのお手続きが完了しませんでした。\n\n'
   'ご注文番号: {{orderNumber}}\n\n'
   'お手数ですが、こちらからもう一度お試しください。\n{{orderUrl}}\n\n'
   'カードの有効期限やご利用限度額をご確認いただくと、解決する場合がございます。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'payment.expired', 1,
   '【{{siteName}}】お支払い期限が過ぎました（{{orderNumber}}）',
   E'お支払いの期限が過ぎましたので、お取り置きを解かせていただきました。\n\n'
   'ご注文番号: {{orderNumber}}\n\n'
   'あらためてお求めいただけます。\n{{orderUrl}}\n\n'
   'なお、点数に限りがある作品は、すでに品切れとなっている場合がございます。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'wallet.registration_requested', 1,
   '【{{siteName}}】作品のお受け取りのご案内（{{orderNumber}}）',
   E'お買い上げいただいた作品をお届けする準備が整いました。\n\n'
   'ご注文番号: {{orderNumber}}\n\n'
   'お受け取りには、受取用のウォレットのご登録が必要です。\n'
   'こちらからお手続きください。\n{{walletUrl}}\n\n'
   'ご登録がお済みになりましたら、こちらから自動でお届けいたします。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'entitlement.delivered', 1,
   '【{{siteName}}】作品をお届けしました（{{orderNumber}}）',
   E'お買い上げいただいた作品のお受け取りが完了いたしました。\n\n'
   'ご注文番号: {{orderNumber}}\n'
   '作品名: {{artworkTitle}}\n'
   '番号: {{serialNumber}}\n\n'
   'お手元の作品はこちらからご覧いただけます。\n{{collectionUrl}}\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'wallet.delivery_stalled', 1,
   '【{{siteName}}】作品のお届けが遅れております（{{orderNumber}}）',
   E'お買い上げいただいた作品のお届けに時間がかかっております。\n'
   '大変申し訳ございません。\n\n'
   'ご注文番号: {{orderNumber}}\n'
   '作品名: {{artworkTitle}}\n\n'
   'お手続きは完了しておりますので、あらためてお支払いいただく必要はございません。\n'
   '担当者が確認のうえ、あらためてご連絡いたします。\n\n'
   'お急ぎの場合はこちらからお問い合わせください。\n{{contactUrl}}\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'refund.requested', 1,
   '【{{siteName}}】ご返金のお手続きを開始しました（{{orderNumber}}）',
   E'ご返金のお手続きを開始いたしました。\n\n'
   'ご注文番号: {{orderNumber}}\n\n'
   'ご返金がお手元に反映されるまで、決済会社での処理に数日から数週間かかる場合がございます。\n\n'
   'ご注文の内容はこちらからご確認いただけます。\n{{orderUrl}}\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'refund.completed', 1,
   '【{{siteName}}】ご返金が完了しました（{{orderNumber}}）',
   E'ご返金のお手続きが完了いたしました。\n\n'
   'ご注文番号: {{orderNumber}}\n'
   'ご返金金額: {{refundAmount}}\n\n'
   'お手元への反映は、ご利用の決済方法によって時期が異なります。\n'
   'カードの場合、ご利用明細に反映されるまで数日から数週間かかることがございます。\n\n'
   'ご注文の内容はこちらからご確認いただけます。\n{{orderUrl}}\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
