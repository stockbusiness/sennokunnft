-- 作家さまの表示名（決定 2026-08-20。屋号・ペンネーム可・重複不可）
--
-- ⚠️ **重複は「見た目」で止める。** 生の文字列に UNIQUE を張ると、全角と
--    半角、大文字と小文字、空白の有無を変えるだけで、同じに見える別の名前を
--    名乗れる。買う人には見分けが付かないので、実質のなりすましになる。
--    正規化した鍵（display_name_key）に UNIQUE を張る。

-- 重複判定の鍵。⚠️ 生成はアプリ側（domain の displayNameKey）。
-- ⚠️ **DB の関数で作らない。** PostgreSQL の lower() は NFKC 正規化を
--    しないので、アプリ側と結果がずれる。ずれた鍵で UNIQUE を張ると、
--    アプリが通した名前を DB が弾く（あるいはその逆）ことになる。
ALTER TABLE "accounts" ADD COLUMN "display_name_key" TEXT;

-- ⚠️ 表示名を付けていないアカウント（購入者のほとんど）は対象外。
--    部分索引にしないと、NULL 以外が 1 件しか持てない…わけではないが、
--    索引が無駄に大きくなる。
CREATE UNIQUE INDEX "accounts_display_name_key_unique"
  ON "accounts" ("display_name_key")
  WHERE "display_name_key" IS NOT NULL;

-- 既にある表示名を落とす。
--
-- ⚠️ **これが無いと、この移行そのものが失敗する。** 下の CHECK は既存の行も
--    検査するため、鍵の無い表示名が 1 行でも残っていると ALTER が通らない。
--
-- ⚠️ **鍵を SQL で作って埋めない。** PostgreSQL には NFKC 正規化が無く、
--    lower() だけではアプリ側の鍵と一致しない。ずれた鍵を埋めると、
--    見た目の同じ名前をあとから通してしまう —— **間違った鍵は、鍵が無いより悪い。**
--
-- ⚠️ **消しているのは開発用のシードが入れた値だけ。** この列はこれまで
--    どの画面にも API にも出ておらず、書いていたのは `prisma/seed.ts` のみ。
--    シードを流し直せば戻る。
UPDATE "accounts" SET "display_name" = NULL WHERE "display_name" IS NOT NULL;

-- ⚠️ **表示名と鍵は、どちらか片方だけでは意味を持たない。**
--    片方だけ入った行は、重複判定をすり抜けるか、表示できないかのどちらか。
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_display_name_paired"
  CHECK (("display_name" IS NULL) = ("display_name_key" IS NULL));

-- --------------------------------------------------------------------------
-- 注文へのスナップショット
-- --------------------------------------------------------------------------
-- ⚠️ **注文の記録は「そのとき何が表示されていたか」。** 作品名・価格・
--    手数料率と同じ原則（スナップショット原則）。作家さまが改名しても、
--    過去のご注文の表示は変わらない。
--
-- ⚠️ **NULL を許す。** この列より前の注文があるため。埋まっていない行は
--    画面側で「（表示名の登録前）」として扱う。推測で埋めない。
ALTER TABLE "order_lines" ADD COLUMN "creator_name_snapshot" TEXT;
