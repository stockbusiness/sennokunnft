-- 「非公開なのに販売中の出品がある」状態を、作品側からも作れないようにする。
--
-- これまで不変条件は出品側のトリガだけで守られていた。
-- そのため「非公開の作品に有効な出品を作る」ことはできない一方で、
-- 「有効な出品がある作品を非公開にする」ことはできてしまい、
-- トリガが防ごうとしていた状態そのものが別の入口から成立していた。
--
-- 制約は「作れないこと」だけでなく「残らないこと」まで見ないと守れない。

-- 1. 既に成立してしまっている行を先に直す。
--    トリガは既存行を検証しないため、これを飛ばすと
--    「制約はあるのに違反した行がある」状態が残る。
UPDATE "listings"
   SET "status" = 'ended', "updated_at" = NOW()
 WHERE "status" IN ('active', 'scheduled')
   AND "artwork_id" IN (SELECT "id" FROM "artworks" WHERE "status" <> 'published');

-- 2. 以後は作品側でも拒否する。
CREATE OR REPLACE FUNCTION "artworks_no_effective_listings_when_unpublished"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'published' THEN
    -- 部分ユニーク索引 listings_one_effective_per_artwork により、
    -- ここで見つかる行は高々 1 件。全件走査にはならない。
    IF EXISTS (
      SELECT 1 FROM "listings"
       WHERE "artwork_id" = NEW."id"
         AND "status" IN ('active', 'scheduled')
    ) THEN
      RAISE EXCEPTION
        'artworks_no_effective_listings_when_unpublished: artwork % still has an effective listing',
        NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "artworks_no_effective_listings_when_unpublished_trigger"
  BEFORE UPDATE ON "artworks"
  FOR EACH ROW EXECUTE FUNCTION "artworks_no_effective_listings_when_unpublished"();
