-- 作品に「登録した人」を持たせる（UD-102 決定変更 2026-08-18）。
--
-- ⚠️ **いきなり NOT NULL で足さない。** 既存の作品には持ち主が入っておらず、
--    既存行があるテーブルに NOT NULL の列は足せない。
--    「足す → 埋める → 締める」の 3 段で進める。

-- 1) まず NULL 許容で足す
ALTER TABLE "artworks" ADD COLUMN "creator_account_id" UUID;

-- 2) 既存の作品を運営名義に寄せる
--
-- ⚠️ **持ち主が決められないなら、黙って進めずに止める。**
--    適当なアカウントを当てると、他人の作品として扱われる行が
--    静かに生まれる。移行が落ちるほうが、気付けるぶん安全。
DO $$
DECLARE
  fallback_id UUID;
  orphan_count INT;
BEGIN
  SELECT count(*) INTO orphan_count FROM "artworks";
  IF orphan_count = 0 THEN
    RETURN;
  END IF;

  -- 最初に作られた運営アカウントに寄せる（複数いても結果が揺れないよう順序を固定）
  SELECT id INTO fallback_id
  FROM "accounts"
  WHERE role = 'operator' AND status = 'active'
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

  IF fallback_id IS NULL THEN
    RAISE EXCEPTION
      '既存の作品が % 件ありますが、寄せ先の operator アカウントがありません。'
      '先に運営アカウントを作ってから、この移行を流してください。', orphan_count;
  END IF;

  UPDATE "artworks" SET "creator_account_id" = fallback_id WHERE "creator_account_id" IS NULL;
END $$;

-- 3) 締める
ALTER TABLE "artworks" ALTER COLUMN "creator_account_id" SET NOT NULL;

-- ⚠️ ON DELETE を CASCADE にしない。アカウントを消したときに売れた作品まで
--    消えると、注文の履歴と食い違う。RESTRICT にして
--    「作品を持ったままのアカウントは消せない」を DB に守らせる。
ALTER TABLE "artworks"
  ADD CONSTRAINT "artworks_creator_account_id_fkey"
  FOREIGN KEY ("creator_account_id") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 出品者が「自分の作品」を引くための索引
CREATE INDEX "artworks_creator_account_id_created_at_idx"
  ON "artworks"("creator_account_id", "created_at");
