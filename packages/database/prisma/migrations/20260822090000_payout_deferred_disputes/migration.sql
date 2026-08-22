-- 決着待ちで今回の精算から外したご注文の数と額（決定 B・2026-08-22）。
--
-- ⚠️ **合計には入らない。** 画面へ「なぜ今月は少ないのか」を出すためだけの列。
--    ここを合計に足す作りにすると、争いの最中の注文までお支払いしてしまう。
--
-- ⚠️ **既存の行は 0 で埋まる。** これまでの精算は「外す」という考え方が無く、
--    争いのある注文は載ったまま確定が止まっていた。0 は「外さなかった」の意で
--    正しい。推測で埋め直さない。
ALTER TABLE "payouts"
  ADD COLUMN "deferred_dispute_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deferred_dispute_amount" INTEGER NOT NULL DEFAULT 0;

-- ⚠️ **負の数を入れさせない。** 件数も額も「外したぶん」で、必ず 0 以上。
--    マイナスが入ると、画面が「-1 件を決着待ちのため外しました」と出す。
ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_deferred_dispute_count_not_negative"
    CHECK ("deferred_dispute_count" >= 0),
  ADD CONSTRAINT "payouts_deferred_dispute_amount_not_negative"
    CHECK ("deferred_dispute_amount" >= 0);

-- ⚠️ **「件数が 0 なら額も 0」は縛らない。** 作家さまの取り分が 0 円の
--    ご注文（手数料が全額のとき）はありうる。縛ると、その 1 件のせいで
--    **精算そのものが保存できなくなる**。締めの最中に起きると手が無い。
