-- 法務文書（利用規約・プライバシーポリシー・特定商取引法に基づく表記）を
-- 版で持つ。
--
-- ⚠️ **上書きしない表として作る。** 公開した版を書き換えられると、
--    「その注文の時点でどう書いてあったか」が示せなくなる。直すときは
--    新しい版を足す。ここは CHECK と部分一意索引で縛り、
--    アプリの if 文だけに頼らない。

CREATE TABLE "legal_document_versions" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"                    TEXT NOT NULL,
  -- 種類ごとの連番。⚠️ 表全体で通し番号にしない。「規約 第3版」と
  -- 言えなくなる。
  "version"                 INTEGER NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'draft',
  "title"                   TEXT NOT NULL,
  -- 規約・プライバシーポリシーの本文。特商法は項目で持つので NULL。
  "body_text"               TEXT,
  -- 特商法の 12 項目。⚠️ 自由文 1 枚にしない。欠けを機械が見つけられる
  -- ようにするため、項目のまま持つ。
  "tokushoho"               JSONB,
  -- 施行日。⚠️ 未来の日付を入れられる（公開の予約）。
  "effective_from"          TIMESTAMPTZ(6),
  "published_at"            TIMESTAMPTZ(6),
  "created_by_account_id"   UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "published_by_account_id" UUID REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ(6) NOT NULL
);

ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_document_versions_kind_valid"
  CHECK ("kind" IN ('terms', 'privacy', 'tokushoho'));

ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_document_versions_status_valid"
  CHECK ("status" IN ('draft', 'published'));

ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_document_versions_version_positive"
  CHECK ("version" >= 1);

-- 公開した版は、施行日・公開日時・公開した人が必ず揃っている。
--
-- ⚠️ **揃っていない「公開済み」を作らせない。** 施行日が無い公開済みの
--    行があると、`effectiveVersion` がそれを飛ばして古い版を出す。
--    画面には「公開済み」と出ているのに、利用者には古い文が見える、
--    という気づきにくい食い違いになる。
ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_document_versions_published_complete"
  CHECK (
    ("status" = 'draft'
      AND "effective_from" IS NULL
      AND "published_at" IS NULL
      AND "published_by_account_id" IS NULL)
    OR
    ("status" = 'published'
      AND "effective_from" IS NOT NULL
      AND "published_at" IS NOT NULL
      AND "published_by_account_id" IS NOT NULL)
  );

-- 本文と項目は、種類に応じてどちらか一方だけを持つ。
--
-- ⚠️ 両方入っていると、どちらが表示されるのかが実装依存になる。
ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_document_versions_body_shape"
  CHECK (
    ("kind" = 'tokushoho' AND "body_text" IS NULL)
    OR ("kind" <> 'tokushoho' AND "tokushoho" IS NULL)
  );

CREATE UNIQUE INDEX "legal_document_versions_kind_version_key"
  ON "legal_document_versions" ("kind", "version");

-- 下書きは種類ごとに 1 つだけ。
--
-- ⚠️ **部分一意索引でしか書けない。** Prisma のスキーマでは表せないので、
--    この表を作り直すときは、この索引を必ず持っていくこと。
--    2 つ下書きがあると、どちらを直しているのか操作する人に分からない。
CREATE UNIQUE INDEX "legal_document_versions_one_draft_per_kind"
  ON "legal_document_versions" ("kind")
  WHERE "status" = 'draft';

-- 同じ種類で施行日が重ならないようにする。
--
-- ⚠️ 同じ瞬間に 2 つ施行されると、どちらが有効かが並び順まかせになる。
CREATE UNIQUE INDEX "legal_document_versions_effective_from_key"
  ON "legal_document_versions" ("kind", "effective_from")
  WHERE "status" = 'published';

CREATE INDEX "legal_document_versions_kind_created_at_idx"
  ON "legal_document_versions" ("kind", "created_at" DESC);
