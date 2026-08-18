-- 運営が運営を増やせるようにする（`UD-803` 決定 2026-08-18）。
--
-- ⚠️ **役割は増やさない。** 「何ができるか」は今までどおり 3 つ
--    （buyer / operator / auditor）。ここで足すのは
--    **「人に権限を配れるか」という別の軸**（is_owner）。
--    4 つ目の役割にすると、operator に許した操作をすべて写す必要が生まれ、
--    写し忘れが「オーナーだけできない操作」として静かに残る。

-- 1) オーナーの印
ALTER TABLE "accounts" ADD COLUMN "is_owner" BOOLEAN NOT NULL DEFAULT false;

-- ⚠️ **オーナーは必ず operator。** 閲覧のみの人が人事を触れるのはおかしい。
--    降ろすときは、先にオーナーを外してから役割を変えることになる。
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_is_operator"
  CHECK ("is_owner" = false OR "role" = 'operator');

-- 2) スタッフの連絡先
--
-- ⚠️ **購入者のメールアドレスは今までどおり平文で持たない**（`UD-503`）。
--    ここに入るのは、オーナーが招待したときに自分で入力した
--    **スタッフの業務用アドレス**だけ。購入者の行には入らないよう
--    CHECK で縛る。「そのうち全員分入れてしまう」を防ぐのが目的。
ALTER TABLE "accounts" ADD COLUMN "staff_email" TEXT;

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_staff_email_only_for_staff"
  CHECK ("staff_email" IS NULL OR "role" IN ('operator', 'auditor'));

-- 同じアドレスが 2 人のスタッフに割り当たらないようにする。
-- ⚠️ 大文字小文字を区別しない。メールアドレスの局所部は理屈のうえでは
--    区別されうるが、実務で区別する事業者はほぼ無く、
--    区別すると「同じ人なのに別人」として二重に招待できてしまう。
CREATE UNIQUE INDEX "accounts_staff_email_key"
  ON "accounts" (lower("staff_email")) WHERE "staff_email" IS NOT NULL;

-- 3) 招待
--
-- ⚠️ **招待リンクのトークンを持たない。** 受諾は「そのアドレスで
--    ログインできたこと」で判定する。トークンを配ると、
--    転送・流出したリンクを拾った別人が権限を得られる。
--    受信箱に届く経路そのものを本人確認に使い、鍵を増やさない。
CREATE TABLE "staff_invitations" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "AccountRole" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invited_by_account_id" UUID NOT NULL,
    "accepted_by_account_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id")
);

-- ⚠️ **招待で buyer を配れないようにする。** 招待はスタッフを増やす道具で、
--    一般会員はログインすれば勝手に作られる。ここに buyer を通すと、
--    「招待で役割を下げる」という別の操作が紛れ込む。
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_role_is_staff"
  CHECK ("role" IN ('operator', 'auditor'));

ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_status_valid"
  CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired'));

-- 受諾済みなら、誰がいつ受けたかが必ず埋まっている。
-- ⚠️ 片方だけ埋まった行を許すと、「受諾されたのに誰か分からない」が生まれる。
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_accepted_is_complete"
  CHECK (
    ("status" = 'accepted')
      = ("accepted_by_account_id" IS NOT NULL AND "accepted_at" IS NOT NULL)
  );

ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_closed_is_complete"
  CHECK (("status" IN ('revoked', 'expired')) = ("closed_at" IS NOT NULL));

-- ⚠️ **同じ宛先に生きた招待を 2 通作らせない。**
--    2 通あると、片方を取り消しても、もう片方でスタッフになれる。
--    取り消したつもりが効いていない、が最も危ない形。
CREATE UNIQUE INDEX "staff_invitations_pending_email_key"
  ON "staff_invitations" (lower("email")) WHERE "status" = 'pending';

CREATE INDEX "staff_invitations_status_expires_at_idx"
  ON "staff_invitations" ("status", "expires_at");

CREATE INDEX "staff_invitations_invited_by_account_id_created_at_idx"
  ON "staff_invitations" ("invited_by_account_id", "created_at");

-- ⚠️ 招待した人・受けた人のアカウントは、招待が残っているあいだ消せない。
--    誰が誰を入れたのかが辿れなくなるため。
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_invited_by_account_id_fkey"
  FOREIGN KEY ("invited_by_account_id") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_accepted_by_account_id_fkey"
  FOREIGN KEY ("accepted_by_account_id") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4) 最初のオーナーは、この移行では作らない
--
-- ⚠️ **自動で誰かをオーナーにしない。** 既存の operator が複数いた場合に
--    全員へ人事権が渡る。誰が最上位かは、人が決めて明示的に入れる。
--    手順は docs/DEPLOYMENT_RUNBOOK.md §3-6。
