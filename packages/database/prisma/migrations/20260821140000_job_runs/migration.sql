-- 時計仕掛けの生死（実運営 指示書 P0-6）。
--
-- ⚠️ **これが無いと「止まっている」を誰も検知できない。** 発行も配送も
--    知らせも、止まれば静かに溜まるだけで、エラーは 1 件も出ない。
--    気づくのは、買った方から問い合わせが来たときになる。
--
-- ⚠️ すべて追加型。既存テーブル・既存データへの変更は無い。

CREATE TABLE "job_runs" (
    -- ⚠️ **種別を主キーにする。** 1 実行 1 行にすると無限に増え、
    --    掃除の仕組みが要る。見たいのは「最後にいつ成功したか」だけ。
    "job_key" TEXT NOT NULL,
    "last_started_at" TIMESTAMPTZ(6),
    -- ⚠️ **成功と失敗を別の列で持つ。** 1 列にすると、失敗が上書きした
    --    瞬間に「最後にいつ成功したか」が失われる——それこそが見たい値なのに。
    "last_succeeded_at" TIMESTAMPTZ(6),
    "last_failed_at" TIMESTAMPTZ(6),
    "last_outcome" TEXT,
    "last_error_code" TEXT,
    "last_picked_count" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("job_key")
);

-- ★ 結果の語彙を縛る。綴り違いの行は「知らない状態」として扱えず、
--   画面がどちらとも判定できなくなる。
ALTER TABLE "job_runs"
  ADD CONSTRAINT "job_runs_last_outcome_known"
  CHECK ("last_outcome" IS NULL OR "last_outcome" IN ('succeeded', 'failed'));

-- ★ 「成功した」と「成功した時刻」を分離させない。
ALTER TABLE "job_runs"
  ADD CONSTRAINT "job_runs_succeeded_at_present"
  CHECK ("last_outcome" <> 'succeeded' OR "last_succeeded_at" IS NOT NULL);

-- ★ 同じく失敗側。
ALTER TABLE "job_runs"
  ADD CONSTRAINT "job_runs_failed_at_present"
  CHECK ("last_outcome" <> 'failed' OR "last_failed_at" IS NOT NULL);

-- ★ 件数は負にならない。
ALTER TABLE "job_runs"
  ADD CONSTRAINT "job_runs_picked_count_non_negative"
  CHECK ("last_picked_count" IS NULL OR "last_picked_count" >= 0);
