-- 証拠の提出期限を持つ（2026-08-22）
--
-- ⚠️ **過ぎると自動的に負ける。** チャージバックの申し立てには期限があり、
--    証拠を出さないまま過ぎると、こちらの言い分に関わらず敗訴になる。
--
-- ⚠️ **持たないと、運営は期限を Stripe の画面でしか知れない。** 気づく
--    仕組みを作る意味が半分になる——「1 件ある」だけ見せても、急ぐのか
--    どうかが分からない。

ALTER TABLE "payment_disputes"
  -- ⚠️ **NULL 可。** 決着した争いや警告には無いことがある。推測で埋めない。
  ADD COLUMN "evidence_due_at" TIMESTAMPTZ(6);

/*
  期限の近い争いを引くための索引。

  ⚠️ **決着していないものだけ。** 決着した争いの期限を見ても仕方がない。
*/
CREATE INDEX "payment_disputes_evidence_due_idx"
  ON "payment_disputes" ("evidence_due_at")
  WHERE "status" IN ('needs_response', 'under_review') AND "evidence_due_at" IS NOT NULL;
