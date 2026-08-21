-- 法務文書の改定通知（`UD-127`）。
--
-- ⚠️ **「次のログインで同意していただく」だけでは足りない。** 再同意の印は
--    次にログインするまで効かない。ログインしない方には、**約束の中身が
--    変わることが一度も伝わらないまま**、変わったことになる。

-- 知らせの語彙を広げる。
--
-- ⚠️ **知らない値を弾く CHECK は残したまま広げる。** 外すと、綴りを
--    間違えた種別が黙って積まれ、文面が見つからず送られないまま溜まる。
--    止まった知らせは誰にも気づかれない。
ALTER TABLE "notification_templates"
  DROP CONSTRAINT IF EXISTS "notification_templates_event_type_known";

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
    'refund.completed',
    'legal.revised'
  ));

ALTER TABLE "notification_deliveries"
  DROP CONSTRAINT IF EXISTS "notification_deliveries_event_type_known";

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
    'refund.completed',
    'legal.revised'
  ));

-- ⚠️ **対象は「文書」ではなく「版」。** 文書を指すと改定のたびに同じ鍵に
--    なり、2 回目以降が重複として捨てられる。版で分ければ改定ごとに 1 通届く。
ALTER TABLE "notification_deliveries"
  DROP CONSTRAINT IF EXISTS "notification_deliveries_subject_type_known";

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_subject_type_known"
  CHECK ("subject_type" IN ('order', 'entitlement', 'refund', 'legal_version'));

-- 積み終えた印。
--
-- ⚠️ **公開は取り消せない。** 積むのは公開のあとなので、そのあいだに
--    落ちると誰にも届かない。掃き寄せ（cron）が拾い直せるよう、
--    「積み終えたか」を版そのものに持たせる。
-- ⚠️ **途中で落ちても印は立たない。** 積み直しは安全である——同じ
--    （種別・版・アカウント）の組は積む側の UNIQUE が重複として弾く。
ALTER TABLE "legal_document_versions"
  ADD COLUMN "notices_enqueued_at" TIMESTAMPTZ(6);

-- ⚠️ **下書きには立たない。** 公開していない版の知らせを積んだことに
--    なっていたら、それはこちらの不具合である。気づけるようにする。
ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_versions_notices_only_when_published"
  CHECK ("notices_enqueued_at" IS NULL OR "published_at" IS NOT NULL);

-- 掃き寄せが「まだ積んでいない版」を引くための索引。
--
-- ⚠️ **部分索引にする。** 積み終えた版が溜まっても、掃き寄せの当たりは
--    増えない。Prisma では条件付き索引を書けないため、ここにだけ在る。
CREATE INDEX "legal_versions_pending_notices_idx"
  ON "legal_document_versions" ("published_at")
  WHERE "notices_enqueued_at" IS NULL
    AND "requires_reconsent" IS TRUE
    AND "published_at" IS NOT NULL;

-- 「その文書の、古い版に同意した人」を引くための索引。
--
-- ⚠️ **`version` まで入れる。** 種別だけだと、改定のたびに同意の全行を
--    読むことになる。会員が増えるほど、公開のたびに重くなる。
CREATE INDEX "legal_consents_kind_version_account_idx"
  ON "legal_consents" ("kind", "version", "account_id");

-- 重複送信を止める鍵へ、宛先を足す。
--
-- ⚠️ **これまでの鍵は「1 つの対象につき 1 通」だった。** 注文・受取権・返金は
--    どれも宛先が 1 人なので、それで足りていた。**改定の知らせは 1 つの版を
--    大勢へ送る**ので、この鍵のままだと **1 人目しか積まれない**。
--
-- ⚠️ **緩めているように見えるが、意味は変わらない。** 止めたいのは
--    「同じ知らせが同じ人へ 2 通届くこと」であって、「1 つの対象について
--    2 人へ届くこと」ではない。鍵が言いたかったことを、そのまま書き直す。
--
-- ⚠️ **既存の種別で行が増えることはない。** 注文も受取権も返金も宛先は
--    1 人なので、`account_id` を足しても同じ組み合わせにしかならない。
DROP INDEX IF EXISTS "notification_deliveries_event_subject_unique";

CREATE UNIQUE INDEX "notification_deliveries_event_subject_account_unique"
  ON "notification_deliveries"("event_type", "subject_type", "subject_id", "account_id");

-- 既定の文面。
--
-- ⚠️ **文面が無いと積まれない**（`NotificationService` は既定へ落とさない）。
--    種別だけ足して文面を忘れると、**知らせは静かに積まれないまま**になる。
--
-- ⚠️ **本文そのものを載せない。** 規約は長く、メールへ写すと版が 2 か所に
--    増える。食い違ったとき、どちらが約束なのか誰にも言えなくなる。
--    **読みに行く先**を渡す。
--
-- ⚠️ **「ご確認ください」で終わらせない。** 何もしなくてよいのか、
--    何かする必要があるのかを書く。書かないと問い合わせになる。
INSERT INTO "notification_templates"
  ("id", "event_type", "version", "subject", "body", "status", "published_at", "updated_at")
VALUES
  (gen_random_uuid(), 'legal.revised', 1,
   '【{{siteName}}】{{documentName}}を改めさせていただきます',
   E'いつも{{siteName}}をご利用いただきありがとうございます。\n\n'
   '{{documentName}}を改めさせていただくことになりましたので、お知らせいたします。\n\n'
   '適用開始日: {{effectiveFrom}}\n'
   '改定後の内容: {{legalUrl}}\n\n'
   'お手数ですが、次回ログインされた際に、あらためてご同意のお手続きをお願いいたします。\n'
   'それまでのあいだ、お手元でのお手続きは特にございません。\n\n'
   'ご不明な点がございましたら、お気軽にお問い合わせください。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
