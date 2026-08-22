-- 承認のときに選んだ負担者を残す（決定 2026-08-22）
--
-- ⚠️ **事由から決まる値は、あくまで既定にする。** 実務では表に当てはまらない
--    ことが起きる。決めるのは運営で、仕組みはその判断を**記録する**側に回る。
--
-- ⚠️ **選び直したことが分かるようにする。** 既定と違う値を選んだという事実は、
--    あとから「なぜこの作家さまが負担したのか」を説明するときに要る。
--    値だけ残しても、それが既定だったのか判断だったのかが読めない。

ALTER TABLE "refund_requests"
  -- ⚠️ **NULL 可。** 承認するまで決まらない。申し出た時点では分からない。
  ADD COLUMN "clawback_bearer" TEXT;

ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_clawback_bearer_valid"
  CHECK ("clawback_bearer" IS NULL OR "clawback_bearer" IN ('platform', 'creator'));

-- 既定と違う値を選んだか。
--
-- ⚠️ **真偽で持つ。** 「そのとき何が既定だったか」は事由から引き直せるが、
--    事由の表を将来変えると引き直せなくなる。**判断したという事実**は
--    表とは別に残す。
ALTER TABLE "refund_requests"
  ADD COLUMN "clawback_bearer_overridden" BOOLEAN NOT NULL DEFAULT false;

-- ⚠️ **負担者が決まっていない承認済みを作らせない。** 決まらないまま実行へ
--    進むと、事由から引き直すことになり、承認で選んだ意味が消える。
ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_approved_has_bearer"
  CHECK (
    "status" NOT IN ('approved', 'executing', 'executed', 'execution_failed')
    OR "clawback_bearer" IS NOT NULL
  );
