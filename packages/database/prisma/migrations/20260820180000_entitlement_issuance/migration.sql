-- 受取権の発行（P0-1）
--
-- 決済が済んだ注文を受取権（Entitlement）に変える経路を開く。
-- これまで受取権を作っていたのは試験と staging の Fixture だけで、
-- 本番の経路が存在しなかった。Claim も Wallet 配送も返金時の失効も、
-- 作ってあるのに一度も動いていない状態だった。

-- --------------------------------------------------------------------------
-- 冪等の鍵
-- --------------------------------------------------------------------------
-- ⚠️ **同じ Webhook が何度届いても増えないことを、DB に守らせる。**
--    アプリ側の「もう作ったか」の判定だけに頼ると、同時に 2 本走った時に
--    両方が「まだ」と読んで両方作る。判定と作成のあいだに隙間があるため。
--
-- ⚠️ **`serial_no` では代われない。** あちらは作品の中の通し番号で、
--    「この注文明細の何枚目か」を表さない。再開したときに何枚目まで
--    できているかを数えられるのは、この列のほうである。
ALTER TABLE "entitlements" ADD COLUMN "unit_index" INTEGER;

-- 既存の行に番号を振る。
-- ⚠️ **`serial_no` の順に振る。** 作った順を復元できる唯一の手がかりで、
--    ここを恣意的に振ると、あとから「何枚目か」の意味が失われる。
UPDATE "entitlements" AS e
SET "unit_index" = numbered.idx
FROM (
  SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "order_line_id" ORDER BY "serial_no") - 1) AS idx
  FROM "entitlements"
) AS numbered
WHERE e."id" = numbered."id";

ALTER TABLE "entitlements" ALTER COLUMN "unit_index" SET NOT NULL;

ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_unit_index_non_negative" CHECK ("unit_index" >= 0);

-- ⚠️ **ここが二重発行の最終防壁。**
CREATE UNIQUE INDEX "entitlements_line_unit_unique"
  ON "entitlements" ("order_line_id", "unit_index");

-- --------------------------------------------------------------------------
-- 発行の再試行
-- --------------------------------------------------------------------------
-- ⚠️ **発行の待ち行列を別の表にしていない。** 「決済が済んでいるのに受取権が
--    足りない注文」は、注文と受取権から必ず導ける。行を足す方式にすると、
--    「行の入れ忘れ」「行だけ残る」という**実物と食い違う壊れ方**が新しく
--    増える。導出なら、取りこぼしても次の掃き出しで必ず拾い直せる。
--
--    ここに置くのは「何回試したか」だけで、「何をすべきか」ではない。
--    列が消えても、作るべき受取権の数は変わらない。
ALTER TABLE "orders" ADD COLUMN "issuance_attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "issuance_next_attempt_at" TIMESTAMPTZ;
-- ⚠️ **応答本文をそのまま入れない。** 外部の文面には個人情報が混ざりうる。
--    入れるのは、こちらで決めた短い符号だけ。
ALTER TABLE "orders" ADD COLUMN "issuance_last_error" TEXT;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_issuance_attempt_non_negative"
  CHECK ("issuance_attempt_count" >= 0);

-- 掃き出しの取り出し用。
-- ⚠️ 決済が済んだ注文だけを見る部分索引にする。大半の行（未決済・発行済み）を
--    索引に載せても、走査が重くなるだけで拾う先は増えない。
CREATE INDEX "orders_issuance_pending_idx"
  ON "orders" ("issuance_next_attempt_at", "paid_at")
  WHERE "payment_status" = 'succeeded' AND "fulfillment_status" <> 'fulfilled';
