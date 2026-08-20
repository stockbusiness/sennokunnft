-- 運用確認キュー。「機械では決められなかったこと」を残す。
--
-- ⚠️ ログ出力で済ませない。ログは流れて消える。人が確認するべき事柄は、
--    未対応か対応済みかを持った行として残らないと、忙しい日に埋もれる。
--
-- ⚠️ 業務処理を止めない。ここへ積むのは「返金は成立したが、付随する判断が
--    残っている」という状況である。積めなかったからといって返金は巻き戻さない。

CREATE TABLE "operations_reviews" (
    "id" UUID NOT NULL,
    -- 何についての確認か。'order' / 'entitlement'。
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    -- 辿るための注文。⚠️ 外部キーを張らない。確認事項は業務データより
    --    長生きしてよく、注文側の削除制約に引きずられたくない。
    "order_id" UUID,
    -- なぜ確認が要るか。⚠️ 固定コードのみ（自由記述にしない）。
    "reason_code" TEXT NOT NULL,
    -- 機械が判断できなかった理由。⚠️ 個人情報・秘密値を入れない。
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_by_account_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    -- 対応の記録。⚠️ 個人情報を入れない。
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operations_reviews_pkey" PRIMARY KEY ("id")
);

-- ★ 同じ対象・同じ理由を 2 行にしない。
--   返金の Webhook は同じものが何度も届く。そのたびに確認事項が増えると、
--   「いま何件残っているか」が意味を失い、誰も見なくなる。
CREATE UNIQUE INDEX "operations_reviews_subject_reason_unique"
  ON "operations_reviews"("subject_type", "subject_id", "reason_code");

-- 未対応を古い順に拾うための索引。
CREATE INDEX "operations_reviews_status_created_at_idx"
  ON "operations_reviews"("status", "created_at");

CREATE INDEX "operations_reviews_order_id_idx"
  ON "operations_reviews"("order_id");

-- ★ 対応した人は残す。⚠️ アカウントを消しても確認の履歴は消さない。
ALTER TABLE "operations_reviews"
  ADD CONSTRAINT "operations_reviews_resolved_by_account_id_fkey"
  FOREIGN KEY ("resolved_by_account_id") REFERENCES "accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ★ 知っている値だけを対象にする。綴りの誤った理由コードが入ると、
--   件数が合わなくなり、しかも誰も気づけない。
ALTER TABLE "operations_reviews"
  ADD CONSTRAINT "operations_reviews_subject_type_known"
  CHECK ("subject_type" IN ('order', 'entitlement'));

ALTER TABLE "operations_reviews"
  ADD CONSTRAINT "operations_reviews_reason_code_known"
  CHECK ("reason_code" IN (
    'partial_refund_entitlement_unresolved',
    'wallet_revocation_recipient_unresolved',
    'wallet_revocation_payload_conflict'
  ));

ALTER TABLE "operations_reviews"
  ADD CONSTRAINT "operations_reviews_status_known"
  CHECK ("status" IN ('open', 'resolved'));

-- ★ 「対応済み」と「いつ・誰が対応したか」を分離させない。
--   状態だけ動いて記録が無いと、あとから経緯を説明できない。
ALTER TABLE "operations_reviews"
  ADD CONSTRAINT "operations_reviews_resolved_fields_match_status"
  CHECK (
    ("status" = 'resolved') = ("resolved_at" IS NOT NULL)
  );

ALTER TABLE "operations_reviews"
  ADD CONSTRAINT "operations_reviews_detail_not_blank"
  CHECK (length(btrim("detail")) > 0);
