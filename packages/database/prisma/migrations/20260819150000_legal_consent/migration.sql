-- 規約への同意を記録する（`UD-126` 決定 2026-08-19）。
--
-- ⚠️ **同意を求めるのは利用規約だけ。** プライバシーポリシーを同じ
--    チェックへ束ねない。個人情報保護法では利用目的は原則「公表」で足り、
--    「同意」が要るのは第三者提供などの場面。束ねると、必要な同意が
--    取れていないのに取れたつもりになる。

-- この版から、利用者へもう一度同意を求めるか。
--
-- ⚠️ **既定は false。** 誤字を直しただけの改定で全員を止めると、
--    同意の画面が「とりあえず押すもの」になる。実質的な変更かどうかは
--    公開する人が決める。
ALTER TABLE "legal_document_versions"
  ADD COLUMN "requires_reconsent" BOOLEAN NOT NULL DEFAULT false;

-- ⚠️ 下書きに印は立たない。公開のときにしか決められない
--    （あとから立てられると「いつから求め始めたのか」が版から読めない）。
ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_document_versions_reconsent_published_only"
  CHECK ("status" = 'published' OR "requires_reconsent" = false);

CREATE TABLE "legal_consents" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"   UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "kind"         TEXT NOT NULL,
  -- どの版に同意したか。⚠️ 真偽値にしない。改定後に「何に同意したのか」が
  -- 分からなくなる。
  "version_id"   UUID NOT NULL REFERENCES "legal_document_versions"("id") ON DELETE RESTRICT,
  -- 比較に使う番号。⚠️ ID は順序を持たないので、別に持つ。
  "version"      INTEGER NOT NULL,
  "consented_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ⚠️ **同意を求めるのは利用規約だけ。** ほかの種類の行を作らせない。
--    作れてしまうと、「プライバシーポリシーにも同意を取ってある」と
--    読める記録が残り、実際には取っていない同意を取ったことにできる。
ALTER TABLE "legal_consents"
  ADD CONSTRAINT "legal_consents_kind_valid"
  CHECK ("kind" IN ('terms'));

-- 同じ版へ二重に押しても増やさない。
--
-- ⚠️ 画面の二度押しや再読み込みで行が増えると、いつ同意したのかが読めない。
CREATE UNIQUE INDEX "legal_consents_account_version_key"
  ON "legal_consents" ("account_id", "version_id");

CREATE INDEX "legal_consents_account_kind_version_idx"
  ON "legal_consents" ("account_id", "kind", "version" DESC);

-- 注文へ、その時点の規約の版を残す。
--
-- ⚠️ **同意の記録ではない。** 「何が表示されていたか」の記録。
--    価格・手数料率・作品名と同じスナップショット原則で、あとから
--    規約を改定しても過去の注文は動かない。
--
-- ⚠️ **NULL を許す。** 規約をまだ公開していない時期の注文があるため。
--    無いことを、無いまま残す。それらしい版を埋めると、掲げていなかった
--    事実が消える。
ALTER TABLE "orders"
  ADD COLUMN "terms_version_id" UUID REFERENCES "legal_document_versions"("id") ON DELETE RESTRICT,
  ADD COLUMN "terms_version" INTEGER;

-- 片方だけ入っている行を作らせない。
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_terms_version_pair"
  CHECK (
    ("terms_version_id" IS NULL AND "terms_version" IS NULL)
    OR ("terms_version_id" IS NOT NULL AND "terms_version" IS NOT NULL)
  );
