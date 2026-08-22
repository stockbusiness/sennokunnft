-- 運営への知らせ（`UD-1102` の一部・実装 2026-08-22）
--
-- **記録はあるが、気づく仕組みが無かった。** 運営の状況（P0-6）は作ったが、
-- 誰かが見に行かない限り、時計が止まっていても分からない。
--
-- ⚠️ **環境ごとに 1 件。** staging と production で宛先が違う。1 件に
--    まとめると、試したつもりの知らせが本番の担当者へ飛ぶ。

CREATE TABLE "operations_alert_settings" (
  -- ⚠️ 主キーが環境。2 件持てない形にしてある。
  "environment"          TEXT PRIMARY KEY,
  "enabled"              BOOLEAN NOT NULL DEFAULT FALSE,
  -- warning / critical。⚠️ normal は選べない（平常を知らせても意味が無い）。
  "min_severity"         TEXT NOT NULL DEFAULT 'critical',
  -- 同じ状態が続くときに、次に知らせるまでの間隔（分）。
  -- ⚠️ **短くしない。** 短いと、直すのに半日かかる異常で何十通も届く。
  "repeat_after_minutes" INTEGER NOT NULL DEFAULT 240,
  -- 運営の業務用アドレス。⚠️ **お客さまのアドレスを入れる場所ではない。**
  "email_recipients"     TEXT[] NOT NULL DEFAULT '{}',
  -- 外部の受け口（Slack 等）。⚠️ **URL 自体が合言葉なので包んで持つ。**
  --    平文の列は無い。
  "webhook_ciphertext"   TEXT,
  "webhook_nonce"        TEXT,
  "webhook_auth_tag"     TEXT,
  "webhook_key_version"  TEXT,
  -- 画面用。⚠️ ホスト名まで。経路（合言葉）は出さない。
  "webhook_host"         TEXT,
  -- 抑制の判断材料。⚠️ 設定を保存しても、ここには触らない。
  "last_notified_at"     TIMESTAMPTZ(6),
  "last_severity"        TEXT,
  "last_fingerprint"     TEXT,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ⚠️ **環境の語彙を閉じる。** 自由文にすると、綴りを間違えた行が
--    「どの環境からも読まれない設定」として静かに残る。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_environment_known"
  CHECK ("environment" IN ('staging', 'production'));

-- ⚠️ **`normal` を選べないようにする。** 平常を知らせても意味が無く、
--    選べると「毎回鳴る」設定を作れてしまう。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_min_severity_known"
  CHECK ("min_severity" IN ('warning', 'critical'));

-- ⚠️ **記録した色は 3 段のどれか。** 復旧の判定がこの値に依っている。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_last_severity_known"
  CHECK ("last_severity" IS NULL OR "last_severity" IN ('normal', 'warning', 'critical'));

-- ⚠️ **間隔に下限を置く。** 置かないと 1 分ごとに鳴らす設定を作れてしまい、
--    受け取る側が数日で見なくなる。上限は 1 日（超えると知らせの意味が薄い）。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_repeat_range"
  CHECK ("repeat_after_minutes" BETWEEN 15 AND 1440);

-- ⚠️ **包みは 4 つそろっているか、丸ごと無いか。** 片方だけ入った行は
--    解けず、「受け口を設定したのに送られない」を静かに作る。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_webhook_complete"
  CHECK (
    ("webhook_ciphertext" IS NULL AND "webhook_nonce" IS NULL
      AND "webhook_auth_tag" IS NULL AND "webhook_key_version" IS NULL
      AND "webhook_host" IS NULL)
    OR
    ("webhook_ciphertext" IS NOT NULL AND "webhook_nonce" IS NOT NULL
      AND "webhook_auth_tag" IS NOT NULL AND "webhook_key_version" IS NOT NULL
      AND "webhook_host" IS NOT NULL)
  );

-- ⚠️ **伏せた表記に URL を丸ごと入れさせない。** ホスト名までである。
--    入れると、包んで保管した意味が画面の側から失われる。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_host_is_host"
  CHECK ("webhook_host" IS NULL OR ("webhook_host" NOT LIKE '%/%' AND "webhook_host" NOT LIKE '%:%'));

-- ⚠️ **宛先の数に上限を置く。** 増やしすぎると、誰も自分ごとと思わなくなる。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_recipient_count"
  CHECK (array_length("email_recipients", 1) IS NULL OR array_length("email_recipients", 1) <= 5);

-- ⚠️ **空の宛先を混ぜない。** 空文字が 1 つ混ざると、送信のたびに
--    「宛先が無い」で失敗し、ほかの宛先まで巻き添えになりうる。
ALTER TABLE "operations_alert_settings"
  ADD CONSTRAINT "operations_alert_settings_recipients_not_blank"
  CHECK (NOT ('' = ANY("email_recipients")));
