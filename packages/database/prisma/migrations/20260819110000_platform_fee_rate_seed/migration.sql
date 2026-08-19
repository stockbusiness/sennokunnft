-- 手数料率の初期値を DB へ入れる（2026-08-19 決定）。
--
-- ⚠️ **一度限りの移行処理。** 起動のたびに環境変数から読み直す作りには
--    しない。読み直すと、DB と環境変数のどちらが効いているのか分からない
--    「二重管理」になる。ずれに気づくのは請求の段階になる。
--
-- ⚠️ **既に値が入っている行は触らない。** 後から流し直しても、
--    運営が決めた率を上書きしない。
--
-- ⚠️ `updated_at` は既定値を持たない（Prisma が書き込み時に入れる列）。
--    生の INSERT では明示しないと NOT NULL 違反で落ちる。

INSERT INTO "integration_settings" (
  "id", "service", "environment", "endpoint_url",
  "platform_fee_rate_bps", "enabled", "updated_at"
)
VALUES
  (gen_random_uuid(), 'payment', 'staging',    'https://api.stripe.com', 2000, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'payment', 'production', 'https://api.stripe.com', 2000, false, CURRENT_TIMESTAMP)
ON CONFLICT ("service", "environment") DO UPDATE
  SET "platform_fee_rate_bps" = 2000,
      "updated_at" = CURRENT_TIMESTAMP
  -- 0（＝未設定）のままの行にだけ入れる。
  WHERE "integration_settings"."platform_fee_rate_bps" = 0;

-- ⚠️ **`enabled` は false のまま。** 率が入っただけでは売れない。
--    鍵の設定と接続確認を経て、運営が明示的に有効化する。
