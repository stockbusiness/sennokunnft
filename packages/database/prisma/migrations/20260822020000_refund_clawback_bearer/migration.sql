-- 返金を誰が被るか（決定 2026-08-22）
--
-- ⚠️ **これまで、事由を見ずに全部作家さまから差し引いていた。** 精算の
--    差し戻し（`listClawbacks`）に事由の条件が無く、**こちらの不具合で
--    返金した分まで作家さまの次回の売上から引いていた**。
--
-- ⚠️ **既存の行の意味は変えない。** 事由（`reason`）に既に含まれていた
--    ことを、引ける形で書き出すだけである。金額も状態も事由も触らない。
--
-- ⚠️ **過去の精算は動かない。** `confirmed` / `paid` の明細は書き換えない。
--    効くのは、これから作る下書きの差し戻しだけである。

ALTER TABLE "refunds" ADD COLUMN "clawback_bearer" TEXT;

/*
  事由から埋める。

  ⚠️ **`provider_initiated` は運営が被る。** 事業者の画面から返された
     ——チャージバックがここに来る。場を開いている側が備える筋のもので、
     作家さまへ転嫁しない。
*/
UPDATE "refunds"
   SET "clawback_bearer" = CASE
         WHEN "reason" = 'buyer_request' THEN 'creator'
         ELSE 'platform'
       END;

ALTER TABLE "refunds" ALTER COLUMN "clawback_bearer" SET NOT NULL;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_clawback_bearer_valid"
  CHECK ("clawback_bearer" IN ('platform', 'creator'));

-- 差し戻しの対象を引くための索引。⚠️ 作家さま負担の行だけを見る。
CREATE INDEX "refunds_clawback_creator_idx"
  ON "refunds" ("order_id")
  WHERE "clawback_bearer" = 'creator' AND "status" = 'succeeded';
