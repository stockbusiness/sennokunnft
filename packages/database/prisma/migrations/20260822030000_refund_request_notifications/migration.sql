-- 返金の申請と審査の知らせ（方針整理 2026-08-22）
--
-- ⚠️ **作家さまへの事実確認が届かないと、期限が意味を持たない。** ご回答の
--    期限は営業日数で決まるのに、いまはログインしない限り依頼が来たことに
--    気づけない。気づかないまま期限が過ぎ、運営が「回答が無いので進めた」と
--    記録する——作家さまから見れば、聞かれてすらいない。

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
    'legal.revised',
    'payout_account.changed',
    'refund_request.received',
    'refund_request.rejected',
    'refund_inquiry.asked'
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
    'legal.revised',
    'payout_account.changed',
    'refund_request.received',
    'refund_request.rejected',
    'refund_inquiry.asked'
  ));

-- ⚠️ **対象は「注文」ではなく「お申し出」。** 注文を指すと、同じ注文で
--    2 度目のお申し出をいただいたときに、重複として捨てられる。
ALTER TABLE "notification_deliveries"
  DROP CONSTRAINT IF EXISTS "notification_deliveries_subject_type_known";

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_subject_type_known"
  CHECK ("subject_type" IN (
    'order',
    'entitlement',
    'refund',
    'legal_version',
    'payout_account',
    'refund_request'
  ));

-- 既定の文面。
--
-- ⚠️ **種別を足したら、文面も同時に入れる。** 種別だけ足すと、送る段に
--    なって「文面が無い」で止まる。止まった知らせは誰にも気づかれない。
INSERT INTO "notification_templates"
  ("id", "event_type", "version", "subject", "body", "status", "published_at", "updated_at")
VALUES
  /*
    ⚠️ **「ご返金します」と読めない文面にする。** お受けしたことと、
       お返しすることは別である。ここを曖昧に書くと、断ったときに
       「話が違う」になる——そしてそれは、こちらの書き方が悪い。
    ⚠️ **金額を書かない。** どれだけお返しするかは審査が決める。
  */
  (gen_random_uuid(), 'refund_request.received', 1,
   '【{{siteName}}】返金のご相談を承りました（{{orderNumber}}）',
   E'返金についてのご相談を承りました。\n\n'
   'ご注文番号: {{orderNumber}}\n\n'
   'いただいた内容を確認のうえ、あらためて担当者よりご連絡いたします。\n'
   'お受けした時点でご返金が決まるものではございませんので、ご了承ください。\n\n'
   'ご注文の内容はこちらからご確認いただけます。\n{{orderUrl}}\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  /*
    ⚠️ **黙って終わらせない。** 申し出た方から見ると、返事が来ないのと
       断られたのは違う。返事が来なければ、何度でも問い合わせが来る。
    ⚠️ **却下の理由を本文へ写さない。** 運営の記録は運営の言葉で書かれて
       いて、そのままお送りする文ではない。
  */
  (gen_random_uuid(), 'refund_request.rejected', 1,
   '【{{siteName}}】返金のご相談について（{{orderNumber}}）',
   E'先日いただきました返金のご相談につきまして、確認いたしました結果、\n'
   '今回はご返金を承れないという判断となりました。\n\n'
   'ご注文番号: {{orderNumber}}\n\n'
   'ご期待に添えず申し訳ございません。\n'
   '判断の理由についてご不明な点がございましたら、こちらからお問い合わせください。\n'
   '{{contactUrl}}\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  /*
    作家さま宛て。
    ⚠️ **金額とご購入者さまを載せない。** 事実をお答えいただくのに要らず、
       載せると「いくら返るのか」を先に知ることになって回答が歪む。
    ⚠️ **「返金してよいか」を尋ねる文にしない。** 伺うのは事実で、決めるのは
       運営である。可否を尋ねると、答えが「反対」で埋まったときに運営が
       返金しづらくなる。
    ⚠️ **期限を過ぎても受け付けると書く。** 「もう遅い」と読ませない。
  */
  (gen_random_uuid(), 'refund_inquiry.asked', 1,
   '【{{siteName}}】お心当たりを伺えますでしょうか（ご回答期限 {{dueAt}}）',
   E'お世話になっております。{{siteName}} 運営でございます。\n\n'
   'ご購入者さまから返金についてのご相談があり、事実関係を確認しております。\n'
   'つきましては、作家さまのお心当たりをお聞かせいただけますでしょうか。\n\n'
   'ご回答の期限: {{dueAt}}\n\n'
   'ご回答はこちらのページからお願いいたします。\n{{inquiryUrl}}\n\n'
   'ご返金をお受けするかどうかは運営が判断いたしますので、\n'
   'ご心配なく、事実をそのままお聞かせください。\n'
   '期限を過ぎましてもご回答はお受けいたします。\n\n'
   '{{siteName}}\n{{siteUrl}}',
   'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
