-- 押さえのずれを直した記録（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）
--
-- ⚠️ **この表は「直した」の記録ではなく、「直す前がどうだったか」の記録である。**
--    前後の値だけを監査ログへ書く形も考えたが、**「12 → 9」だけでは後から
--    何ひとつ辿れない。**どの注文が・いくつ押さえ・いくつ発行済みだったかを
--    丸ごと焼き付けて初めて原因を追える。整合性チェックの「直さない。数える
--    だけ」を一部ひるがえすにあたって、これが最低限の引き換えである。
--
-- ⚠️ **`cause_state = 'unknown'` の行は、閉じられるまで積み残しとして残る。**
--    修復すると整合性チェックは 0 件へ戻るが、この数は残る——**直したことで
--    赤が消えるのを許さない**ためにある。2026-08-23 に見つかった返金の
--    二重解放は、修復の口が先にあったら押して終わりにしていた可能性が高い。
--
-- ⚠️ **書き換えない。追記だけ。** 直したこと自体を後から無かったことに
--    できると、この表を持つ意味が消える。閉じるときも `resolved_*` を
--    埋めるだけで、`before` / `after` / `snapshot` には触らない。

CREATE TABLE "reserved_count_repairs" (
  "id"                     UUID PRIMARY KEY,
  -- ⚠️ ON DELETE を CASCADE にしない。作品を消したときに、
  --    直した記録まで消えると「なぜ直したか」が追えなくなる。
  "artwork_id"             UUID NOT NULL REFERENCES "artworks"("id") ON DELETE RESTRICT,
  -- 直した時点の作品名。⚠️ **スナップショット原則。**あとで改題されても、
  --    記録が指すのは直したときの名前である。
  "artwork_title_snapshot" TEXT NOT NULL,
  "before_count"           INTEGER NOT NULL,
  "after_count"            INTEGER NOT NULL,
  -- `before_count - after_count`。⚠️ 符号を保つ（多かったのか足りなかったのか）。
  "difference"             INTEGER NOT NULL,
  "direction"              TEXT NOT NULL,
  -- 押した人が書いた理由。⚠️ 空では押せない（ドメイン側で 10 文字以上）。
  "reason"                 TEXT NOT NULL,
  -- `identified`（原因が分かっている）/ `unknown`（分からないまま急いだ）。
  "cause_state"            TEXT NOT NULL,
  /*
    ⚠️ **直す前の内訳。** ここが本体である。注文の識別子・注文番号・状態・
       お取り置き・発行済みを並べた配列を入れる。
    ⚠️ **氏名・メール・住所を入れない**（`UD-503`）。運営が広く開く画面に
       出るもので、入れたものはそのまま目に触れる。
  */
  "snapshot"               JSONB NOT NULL,
  "repaired_by_account_id" UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "repaired_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- 原因を突き止めて閉じたとき。⚠️ 閉じるまでは NULL のまま積み残しに出る。
  "resolved_at"            TIMESTAMPTZ(6),
  "resolved_by_account_id" UUID REFERENCES "accounts"("id") ON DELETE RESTRICT,
  -- 何が分かったのか。⚠️ 書けないなら、まだ閉じるときではない。
  "resolution_note"        TEXT
);

-- ⚠️ **語彙を閉じる。** 綴りを間違えた行が、どちらでもない状態として
--    永久に積み残しへ出続ける（あるいは永久に出ない）。
ALTER TABLE "reserved_count_repairs"
  ADD CONSTRAINT "reserved_count_repairs_direction_known"
  CHECK ("direction" IN ('over', 'under'));

ALTER TABLE "reserved_count_repairs"
  ADD CONSTRAINT "reserved_count_repairs_cause_state_known"
  CHECK ("cause_state" IN ('identified', 'unknown'));

-- ⚠️ **直した先が負になる修復を記録させない。** `artworks` 側にも
--    `reserved_count >= 0` の制約があるが、こちらにも置く。記録だけが
--    通ってしまうと、書けなかった修復が書けたことになる。
ALTER TABLE "reserved_count_repairs"
  ADD CONSTRAINT "reserved_count_repairs_counts_non_negative"
  CHECK ("before_count" >= 0 AND "after_count" >= 0);

-- ⚠️ **差が 0 の記録を作らせない。** 何も直していない行が積み残しに
--    並ぶと、読む人が「直したのに直っていない」と誤解する。
ALTER TABLE "reserved_count_repairs"
  ADD CONSTRAINT "reserved_count_repairs_difference_matches"
  CHECK ("difference" = "before_count" - "after_count" AND "difference" <> 0);

/*
  ⚠️ **向きと差の符号を食い違わせない。** `over` は減らす向き（差が正）、
     `under` は増やす向き（差が負）。片方だけ書き換えた実装が入ったとき、
     画面の文言と実際の操作が逆になる。
*/
ALTER TABLE "reserved_count_repairs"
  ADD CONSTRAINT "reserved_count_repairs_direction_matches_sign"
  CHECK (
    ("direction" = 'over' AND "difference" > 0)
    OR ("direction" = 'under' AND "difference" < 0)
  );

/*
  ⚠️ **閉じるなら、誰が・いつ・何を書いたかが全部そろっていること。**
     どれか一つだけ埋まった行は、閉じたのか閉じていないのか判定できない。
  ⚠️ **原因が分かったうえで直したものは閉じられない。** はじめから積み残し
     ではないので、閉じる操作の対象にすると「解決済み」の数が二重になる。
*/
ALTER TABLE "reserved_count_repairs"
  ADD CONSTRAINT "reserved_count_repairs_resolution_complete"
  CHECK (
    ("resolved_at" IS NULL AND "resolved_by_account_id" IS NULL AND "resolution_note" IS NULL)
    OR (
      "resolved_at" IS NOT NULL
      AND "resolved_by_account_id" IS NOT NULL
      AND "resolution_note" IS NOT NULL
      AND "cause_state" = 'unknown'
    )
  );

-- 作品ごとの履歴を引く。⚠️ 同じ作品で何度も直しているなら、それ自体が合図。
CREATE INDEX "reserved_count_repairs_artwork_idx"
  ON "reserved_count_repairs" ("artwork_id", "repaired_at" DESC);

/*
  ⚠️ **積み残しを引くための部分索引。** 全件走査させない。
     閉じた行が増えても、積み残しの一覧は軽いままであること。
*/
CREATE INDEX "reserved_count_repairs_pending_idx"
  ON "reserved_count_repairs" ("repaired_at" DESC)
  WHERE "cause_state" = 'unknown' AND "resolved_at" IS NULL;
