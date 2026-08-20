-- 全額返金で受取済み（claimed）の受取権を取り消せるようにする（UD-104 追補・2026-08-20 決定）。
--
-- 「受け取った事実」と「いま使える権利」は別の話である。
-- 全額返金が成立した以上、権利が使えるまま残るのは認められない。一方で
-- 受け取った事実は起きたことなので、記録からは消さない。したがって
-- claimed → revoked を許し、claim 情報・配送情報は**そのまま残す**。
--
-- ⚠️ 追加型。列の削除・型変更・既存データの UPDATE は一切行わない。
-- ⚠️ 制約を「消して無制限」にはしない。revoked を列挙に加えるだけで、
--    issued / expired に claim 情報・配送情報が残ることは禁止のまま。
-- ⚠️ さらに、claim 日時と claim アカウントが片方だけ埋まる状態を新たに禁止する。

-- ============================================================================
-- 事前検証
--
-- ⚠️ ADD CONSTRAINT は既存行を検証する。違反があれば途中で失敗し、
--    一部だけ張られた中途半端な状態になる。先にまとめて数え、原因ごとに出す。
--
-- ⚠️ NULL 三値論理で漏れないよう、各条件を IS NULL / IS NOT NULL で明示する。
--    `claimed_at <> ...` のような比較は NULL のとき UNKNOWN になり、
--    NOT() を通しても真にならないため、違反件数から静かに漏れる。
-- ============================================================================
DO $$
DECLARE
  v_unpaired         bigint;  -- claim 日時と claim アカウントの片方だけ null
  v_claim_bad_status bigint;  -- claim 情報があるのに claimed / revoked でない
  v_cu_bad_status    bigint;  -- common_user_id があるのに claimed / revoked でない
  v_delivery_bad     bigint;  -- 配送情報があるのに claimed / revoked でない
BEGIN
  SELECT count(*) INTO v_unpaired
    FROM "entitlements"
   WHERE ("claimed_at" IS NULL     AND "claimed_by_account_id" IS NOT NULL)
      OR ("claimed_at" IS NOT NULL AND "claimed_by_account_id" IS NULL);

  SELECT count(*) INTO v_claim_bad_status
    FROM "entitlements"
   WHERE "claimed_at" IS NOT NULL
     AND "status" NOT IN ('claimed', 'revoked');

  SELECT count(*) INTO v_cu_bad_status
    FROM "entitlements"
   WHERE "claimed_by_common_user_id" IS NOT NULL
     AND "status" NOT IN ('claimed', 'revoked');

  SELECT count(*) INTO v_delivery_bad
    FROM "entitlements"
   WHERE "wallet_delivery_status" IN ('pending', 'delivered')
     AND "status" NOT IN ('claimed', 'revoked');

  RAISE NOTICE '事前検証: 片方だけnull=% / claim情報=% / common_user_id=% / 配送情報=%',
    v_unpaired, v_claim_bad_status, v_cu_bad_status, v_delivery_bad;

  IF v_unpaired + v_claim_bad_status + v_cu_bad_status + v_delivery_bad > 0 THEN
    RAISE EXCEPTION
      '新しい制約を満たさない既存行があります（片方だけnull=%, claim情報=%, common_user_id=%, 配送情報=%）。移行を中止しました。データの是正方針を決めてから再実行してください。',
      v_unpaired, v_claim_bad_status, v_cu_bad_status, v_delivery_bad;
  END IF;
END $$;

-- ============================================================================
-- 1. 配送情報を持てる状態に revoked を加える（緩和）
--
--    ⚠️ issued / expired への禁止は維持する。「まだ誰も受け取っていないのに
--       Wallet へ配送中」という行が作れると、公開状態が DELIVERY_PENDING を
--       名乗り、受取の事実が無いまま「お届け中です」と答えることになる。
-- ============================================================================
ALTER TABLE "entitlements" DROP CONSTRAINT "entitlements_delivery_requires_claim";
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_delivery_requires_claim"
  CHECK (
    "wallet_delivery_status" NOT IN ('pending', 'delivered')
    OR "status" IN ('claimed', 'revoked')
  );

-- ============================================================================
-- 2. 受取者（common_user_id）を持てる状態に revoked を加える（緩和）
-- ============================================================================
ALTER TABLE "entitlements" DROP CONSTRAINT "entitlements_claimer_requires_claim";
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_claimer_requires_claim"
  CHECK (
    "claimed_by_common_user_id" IS NULL
    OR "status" IN ('claimed', 'revoked')
  );

-- ============================================================================
-- 3. claim 日時と claim アカウントは対で存在する（新設・強化）
--
--    ⚠️ 片方だけ埋まった行は、監査でも復旧でも判断できない。
--       「誰が受け取ったか分からないが受け取った時刻はある」という行を、
--       取消でうっかり作らないようにする。
-- ============================================================================
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_claim_fields_paired"
  CHECK (("claimed_at" IS NULL) = ("claimed_by_account_id" IS NULL));

-- ============================================================================
-- 4. claim 情報があるなら claimed か revoked（新設・強化）
--
--    ⚠️ 3 により claimed_by_account_id 側も同じ制限を受ける。
--    ⚠️ issued からの取消（claim 情報なし）は引き続き許す。
-- ============================================================================
ALTER TABLE "entitlements"
  ADD CONSTRAINT "entitlements_claim_fields_require_claim_or_revoked"
  CHECK (
    "claimed_at" IS NULL
    OR "status" IN ('claimed', 'revoked')
  );

-- ============================================================================
-- 事後検証
--
-- ADD CONSTRAINT が既存行を検証して通っている＝この時点で全行が満たす。
-- 分布だけを記録に残す（移行直後は取消済み＋受取記録ありは 0 のはず）。
-- ============================================================================
DO $$
DECLARE v_revoked_with_claim bigint;
BEGIN
  SELECT count(*) INTO v_revoked_with_claim
    FROM "entitlements"
   WHERE "status" = 'revoked' AND "claimed_at" IS NOT NULL;
  RAISE NOTICE '事後検証: 取消済みかつ受取記録あり = % 件', v_revoked_with_claim;
END $$;
