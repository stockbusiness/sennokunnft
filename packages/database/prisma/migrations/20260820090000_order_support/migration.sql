-- 注文の検索と問い合わせ対応（UD-121）
--
-- ⚠️ 状態を変える列も表もここでは足さない。増えるのは
--    「対応の記録」と「探すための索引」だけ。
--    金額の書換え・paid への手動変更・物理削除は引き続き作らない（§9.3）。

-- --------------------------------------------------------------------------
-- 1. 対応メモ
-- --------------------------------------------------------------------------
-- ⚠️ **追記のみの表として扱う。** UPDATE / DELETE の口をアプリに作らない。
--    書き換えられる記録は、揉めたときに何の役にも立たない。
CREATE TABLE "order_notes" (
  "id"                 UUID PRIMARY KEY,
  "order_id"           UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  -- 書いた運営スタッフ。⚠️ 氏名やメールではなくアカウントIDで持つ。
  -- ⚠️ ON DELETE RESTRICT。書いた人の行が消えても、記録は残さねばならない。
  "author_account_id"  UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "body"               TEXT NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ⚠️ 空のメモを残さない。空行が並ぶと、対応したのかしていないのかが
--    読み取れなくなる。
ALTER TABLE "order_notes"
  ADD CONSTRAINT "order_notes_body_not_blank"
  CHECK (btrim("body") <> '');

-- ⚠️ 上限は `ORDER_NOTE_MAX_LENGTH`（ドメイン）と同じ 2000。
--    アプリ側の検査が抜けても、ここで止まる。
ALTER TABLE "order_notes"
  ADD CONSTRAINT "order_notes_body_length"
  CHECK (char_length("body") <= 2000);

-- 経過へ差し込むために、注文ごとに古い順で引く。
CREATE INDEX "order_notes_order_id_created_at_idx"
  ON "order_notes" ("order_id", "created_at");

-- --------------------------------------------------------------------------
-- 2. 探すための索引
-- --------------------------------------------------------------------------
-- 「このアドレスの方の注文はどれか」を引く（UD-121）。
-- ⚠️ 平文は保存していない（UD-503）。ここに入るのは鍵付きの照合値だけ。
-- ⚠️ 部分索引にしてある。照合値は未設定の行が多く、NULL を索引に
--    抱えても引く役には立たない。
CREATE INDEX "accounts_email_hash_idx"
  ON "accounts" ("email_hash")
  WHERE "email_hash" IS NOT NULL;

-- 「先週このくらいの金額で買った」から辿る。
CREATE INDEX "orders_created_at_idx" ON "orders" ("created_at" DESC);
CREATE INDEX "orders_total_amount_idx" ON "orders" ("total_amount");

-- ⚠️ **注文番号の末尾一致と、作品名の部分一致には索引を張っていない。**
--    どちらも `LIKE '%...'` になり、通常の B-Tree では絞り込めない。
--    効かない索引を置くと、書き込みだけ重くなったうえに
--    「索引があるから速いはず」という誤った安心が残る。
--    ⚠️ 件数が増えて遅くなったら、`pg_trgm` 拡張 + GIN 索引で対応する。
--    そのときに初めて拡張を入れる（使わない拡張を先に入れない）。
