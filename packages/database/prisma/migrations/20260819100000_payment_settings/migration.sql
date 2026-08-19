-- 決済の設定を管理画面から変えられるようにする。
--
-- ⚠️ 追加のみ。既存の行と列は触らない。環境変数で動いている配備を
--    そのまま動かし続けるため（DB に接続先が入るまでは環境変数が正）。

ALTER TABLE "integration_settings"
  ADD COLUMN "checkout_success_url" TEXT,
  ADD COLUMN "checkout_cancel_url" TEXT,
  -- ⚠️ 既定は 0。0 は「手数料無料」ではなく「販売設定が未完了」の意味で、
  --    この値のままでは支払い口を作らせない。既存行が黙って
  --    「手数料無料で販売可能」になるのを避けるため、あえて 0 で入れる。
  ADD COLUMN "platform_fee_rate_bps" INTEGER NOT NULL DEFAULT 0;

-- 率は 0〜100%。桁を間違えた値（20 のつもりの 200000 など）を保存させない。
ALTER TABLE "integration_settings"
  ADD CONSTRAINT "integration_settings_fee_rate_range"
  CHECK ("platform_fee_rate_bps" >= 0 AND "platform_fee_rate_bps" <= 10000);

-- サービス名の許容値へ `payment` を足す。
--
-- ⚠️ **3 つの表すべてに同じ CHECK がある。** 設定・資格情報・接続確認。
--    1 つでも外すと、そこだけ `payment` の行を作れず、
--    「画面は出るのに保存で落ちる」になる。
--
-- ⚠️ `integration_secrets` にも足すのは、**決済の鍵を置くためではない**。
--    決済の鍵は配備環境の Secret 管理に置く（2026-08-19 決定）。
--    ここは、将来この判断が変わったときに DDL とアプリの規則が
--    食い違わないようにするためで、置かない規則はアプリ側
--    （`storesSecrets`）が持つ。
ALTER TABLE "integration_settings"
  DROP CONSTRAINT "integration_settings_service_valid",
  ADD CONSTRAINT "integration_settings_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'payment', 'storage', 'auth'));

ALTER TABLE "integration_secrets"
  DROP CONSTRAINT "integration_secrets_service_valid",
  ADD CONSTRAINT "integration_secrets_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'payment', 'storage', 'auth'));

ALTER TABLE "integration_connection_checks"
  DROP CONSTRAINT "integration_connection_checks_service_valid",
  ADD CONSTRAINT "integration_connection_checks_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'payment', 'storage', 'auth'));
