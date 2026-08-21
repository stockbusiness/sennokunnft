-- 本番販売ガード（実運営 指示書 P0-7）。
--
-- 10 条件のうち 8 つは機械が確かめられる。残る 2 つ——**通し試験が通ったこと**と
-- **責任者が承認したこと**——は、機械には確かめようがない。人が署名する行為
-- そのものを記録する。
--
-- ⚠️ **これは「試験が通った証明」ではない。** 押した人が「通した」と言っている
--    記録にすぎない。だからこそ**誰がいつ押したかを残し、書き換えられない**
--    ようにする。書き換えられるなら、記録である意味が無い。
--
-- ⚠️ すべて追加型。既存テーブルへは列を 1 本足すだけで、既定値があるため
--    旧コードはそのまま動く（`accounts.last_aal2_at`）。

CREATE TABLE "production_attestations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- e2e_sale_test / owner_approval
    "kind" TEXT NOT NULL,
    -- staging / production。⚠️ 環境をまたいで証拠を使い回させない。
    "environment" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    -- ⚠️ **どの決済世代についての記録か。** 紐づけないと、前の鍵で通した
    --    試験が新しい鍵の証拠として残り続ける。鍵が替わるのは、運営会社や
    --    入金先が変わるということである。
    "credential_id" UUID NOT NULL,
    "attested_by_account_id" UUID NOT NULL,
    -- ⚠️ **秘密を書かせない。** 画面にも注意書きを出す。
    "note" TEXT,
    "attested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "production_attestations_pkey" PRIMARY KEY ("id")
);

-- ⚠️ **世代へは外部キーを張る。** 消えた世代を指す証跡は、何の証拠でもない。
--    ただし `RESTRICT` にして、証跡のある世代を消せないようにする。
ALTER TABLE "production_attestations"
  ADD CONSTRAINT "production_attestations_credential_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "payment_credentials"("id") ON DELETE RESTRICT;

-- ⚠️ **押した人へも外部キーを張り、`RESTRICT` にする。** 誰が押したか
--    分からない記録は、責任の所在を示せない。
ALTER TABLE "production_attestations"
  ADD CONSTRAINT "production_attestations_attested_by_fkey"
  FOREIGN KEY ("attested_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT;

-- ★ 種別の語彙を縛る。
ALTER TABLE "production_attestations"
  ADD CONSTRAINT "production_attestations_kind_known"
  CHECK ("kind" IN ('e2e_sale_test', 'owner_approval'));

-- ★ 環境の語彙を縛る。
ALTER TABLE "production_attestations"
  ADD CONSTRAINT "production_attestations_environment_known"
  CHECK ("environment" IN ('staging', 'production'));

-- ★ 「不成立」には理由を書かせる。理由の無い不成立は、次に読む人の
--   手がかりにならない。
ALTER TABLE "production_attestations"
  ADD CONSTRAINT "production_attestations_failure_has_note"
  CHECK ("succeeded" IS TRUE OR ("note" IS NOT NULL AND btrim("note") <> ''));

-- ★ 覚え書きの長さ。長文の置き場にしない。
ALTER TABLE "production_attestations"
  ADD CONSTRAINT "production_attestations_note_length"
  CHECK ("note" IS NULL OR char_length("note") <= 1000);

-- 直近 1 件を引くための索引。⚠️ 「どこかに成功がある」ではなく
-- 「最新が成功か」を見るので、新しい順に並べられることが要る。
CREATE INDEX "production_attestations_kind_environment_attested_at_idx"
  ON "production_attestations" ("kind", "environment", "attested_at" DESC);

-- ⚠️ **更新と削除を DB の側でも止める。**
--    アプリに口を作らないだけでは、あとから足す人が「消せるようにしよう」と
--    考えたときに何も抵抗が無い。ここで止めておけば、消したい人は
--    まずこの規則に行き当たり、理由を読むことになる。
CREATE OR REPLACE FUNCTION "production_attestations_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '本番販売ガードの証跡は追記のみです（production_attestations_append_only）。'
    '訂正は新しい記録を足して表してください。';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "production_attestations_no_update"
  BEFORE UPDATE ON "production_attestations"
  FOR EACH ROW EXECUTE FUNCTION "production_attestations_append_only"();

CREATE TRIGGER "production_attestations_no_delete"
  BEFORE DELETE ON "production_attestations"
  FOR EACH ROW EXECUTE FUNCTION "production_attestations_append_only"();

-- 二要素で入った記録（実運営 指示書 P0-7 の 8 番目・`UD-801` の段階導入 段 1）。
--
-- ⚠️ **「入ったことがある」であって、いまの設定ではない。** 相手側の設定を
--    毎回問い合わせるのではなく、二要素で入った記録を根拠にする。外したことは
--    こちらからは分からない——だから判定の側で**期限を切る**。
--
-- ⚠️ **この列だけでは誰も拒否しない**（段 1）。拒否を入れるのは、
--    オーナーが登録を済ませたあと。順序を飛ばすと、オーナーが自分の
--    管理画面から締め出される。
ALTER TABLE "accounts" ADD COLUMN "last_aal2_at" TIMESTAMPTZ(6);

-- メール送信の接続確認（実運営 指示書 P0-7 の 6 番目）。
--
-- ⚠️ **鍵を DB へ移すためではない。** メールの鍵は配備環境の環境変数に
--    あり、管理画面からは触れない（アプリ側の `storesSecrets` が断る）。
--    足すのは**確かめた記録の置き場**だけ。本番販売の前に、送信経路が
--    生きていることを確かめる必要がある。
--
-- ⚠️ `integration_settings` と `integration_secrets` へも同じ語を通すのは、
--    3 つの表で語彙が食い違わないようにするため。置かない規則は
--    アプリ側（`storesSecrets` / `isManagedFromAdmin`）が持つ。
ALTER TABLE "integration_connection_checks"
  DROP CONSTRAINT "integration_connection_checks_service_valid",
  ADD CONSTRAINT "integration_connection_checks_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'payment', 'storage', 'auth', 'mail'));

ALTER TABLE "integration_settings"
  DROP CONSTRAINT "integration_settings_service_valid",
  ADD CONSTRAINT "integration_settings_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'payment', 'storage', 'auth', 'mail'));

ALTER TABLE "integration_secrets"
  DROP CONSTRAINT "integration_secrets_service_valid",
  ADD CONSTRAINT "integration_secrets_service_valid"
  CHECK ("service" IN ('ovew_wallet', 'payment', 'storage', 'auth', 'mail'));

-- ★ 確認の種別に「試し送り」を足す（P0-7 の 6 番目）。
--   ⚠️ **`reachability` と混ぜない。** 確かめている中身が違う。
--      `reachability` はホストへ届くことまでで、資格情報が正しいかは
--      分からない。`test_send` は資格情報で実際に受け付けられたことを示す。
--   ⚠️ **試し送りを OVEW Wallet へ広げない。** メールの試し送りが安全なのは
--      宛先が運営自身の業務用アドレスだから。Wallet の受け口は受取権を作る口で、
--      試し打ちしてよい相手ではない。
ALTER TABLE "integration_connection_checks"
  DROP CONSTRAINT "integration_connection_checks_kind_known",
  ADD CONSTRAINT "integration_connection_checks_kind_known"
  CHECK ("kind" IN ('reachability', 'test_send'));
