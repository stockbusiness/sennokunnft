-- 作家さま運営（実運営 指示書 P1-2）。
--
-- ⚠️ すべて追加型。既存テーブル・既存データへの変更は無い。

-- 販売規約を、法務文書の仕組みへ相乗りさせる。
--
-- ⚠️ **同意の仕組みを作り直さない。** 版管理・施行日・再同意の判定は
--    すでにある（`UD-126`）。並行して別の仕組みを作ると、
--    「どちらの同意が有効か」が分からなくなる。
--
-- ⚠️ **買う人向けの規約とは別の種別にする。** 売る人と買う人では、
--    同意すべき内容も、同意すべき時点も違う。
ALTER TABLE "legal_document_versions"
  DROP CONSTRAINT "legal_document_versions_kind_valid";

ALTER TABLE "legal_document_versions"
  ADD CONSTRAINT "legal_document_versions_kind_valid"
  CHECK ("kind" IN ('terms', 'privacy', 'tokushoho', 'creator_terms'));

-- 同意の側は、**同意を求める種類だけ**を足す。
--
-- ⚠️ **文書の語彙（上の 4 つ）へ揃えない。** 揃えると、
--    「プライバシーポリシーにも同意を取ってある」と読める行を作れてしまい、
--    実際には取っていない同意を取ったことにできる。
--    ここに並ぶのは `CONSENT_REQUIRED_KINDS` と同じ 2 つだけ。
-- ⚠️ **販売規約を足すのは、承諾が要る取り決めだから**（P1-2）。手数料の率、
--    返金が起きたときの扱い、精算の時期——一方的に決めて従わせてよいもの
--    ではない。ただし求める相手は作品を出される方で、買うだけの方ではない。
ALTER TABLE "legal_consents"
  DROP CONSTRAINT IF EXISTS "legal_consents_kind_valid";

ALTER TABLE "legal_consents"
  ADD CONSTRAINT "legal_consents_kind_valid"
  CHECK ("kind" IN ('terms', 'creator_terms'));

-- 作家さまのプロフィール。
--
-- ⚠️ **表示名（`accounts.display_name`）とは別の表にする。** あちらは
--    一意である必要がある（なりすまし防止・`UD-102`）。こちらは紹介文や
--    画像で、一意性とは関係がない。混ぜると、紹介文を直すたびに
--    一意性の検査が走る。
CREATE TABLE "creator_profiles" (
    "account_id" UUID NOT NULL,
    -- 屋号・ショップ名。⚠️ **一意ではない**（表示名がその役目を持つ）。
    "shop_name" TEXT,
    -- 紹介文。⚠️ HTML は保存の時点で断る（アプリ側）。
    "bio" TEXT,
    -- SNS・Web サイト。⚠️ `https` のものだけ（アプリ側で検証）。
    "links" JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- 画像の保管庫の鍵。⚠️ URL ではなく鍵で持つ（保管庫を替えられるように）。
    "icon_key" TEXT,
    "cover_key" TEXT,
    -- インボイス（適格請求書発行事業者）の登録番号。
    -- ⚠️ **形だけを確かめる。** 実在は国税庁の公表サイトでしか分からず、
    --    こちらでは確かめられない。確かめていないものを「確認済み」と出さない。
    "invoice_number" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("account_id")
);

ALTER TABLE "creator_profiles"
  ADD CONSTRAINT "creator_profiles_account_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;

-- ★ インボイス登録番号の形。`T` + 13 桁。
--   ⚠️ 実在の確認ではない。取り違えた値をそのまま保存させないための縛り。
ALTER TABLE "creator_profiles"
  ADD CONSTRAINT "creator_profiles_invoice_number_format"
  CHECK ("invoice_number" IS NULL OR "invoice_number" ~ '^T[0-9]{13}$');

-- ★ 長さ。長文の置き場にしない。
ALTER TABLE "creator_profiles"
  ADD CONSTRAINT "creator_profiles_shop_name_length"
  CHECK ("shop_name" IS NULL OR char_length("shop_name") <= 60);

ALTER TABLE "creator_profiles"
  ADD CONSTRAINT "creator_profiles_bio_length"
  CHECK ("bio" IS NULL OR char_length("bio") <= 2000);

-- ★ 空文字を保存させない。⚠️ 「未設定」は NULL で表す。
--   空文字と NULL が混ざると、画面の出し分けが 2 通りになる。
ALTER TABLE "creator_profiles"
  ADD CONSTRAINT "creator_profiles_no_blank_strings"
  CHECK (
    ("shop_name" IS NULL OR btrim("shop_name") <> '')
    AND ("bio" IS NULL OR btrim("bio") <> '')
    AND ("icon_key" IS NULL OR btrim("icon_key") <> '')
    AND ("cover_key" IS NULL OR btrim("cover_key") <> '')
  );

-- ★ リンクは配列。⚠️ オブジェクトや文字列を入れさせない。
ALTER TABLE "creator_profiles"
  ADD CONSTRAINT "creator_profiles_links_is_array"
  CHECK (jsonb_typeof("links") = 'array');

-- ★ リンクの数。⚠️ 無制限にしない。
--
--   ⚠️ **自分で「配列かどうか」を確かめてから数える。** CHECK の評価順は
--      保証されないので、上の `links_is_array` が先に効くとは限らない。
--      配列でない値に `jsonb_array_length` を当てると、制約違反ではなく
--      **実行時エラー**（22023）になる——アプリからは「壊れた」ようにしか
--      見えず、何が悪いのか分からない応答になる。
ALTER TABLE "creator_profiles"
  ADD CONSTRAINT "creator_profiles_links_count"
  CHECK (jsonb_typeof("links") <> 'array' OR jsonb_array_length("links") <= 5);
