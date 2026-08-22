import type { RefundReason } from '../order/refund';
import type { EntitlementStatus, MintJobStatus } from '../state/machines';

/**
 * 返金の申請と審査（方針整理 2026-08-22）。
 *
 * **これまで、返金は運営が注文の画面から直に実行するだけだった。** 誰が
 * 申し出て、誰が調べ、誰が承認したのかが残らない。ここでは
 * **申請 → 審査 → 可否 → 実行**を、記録の残る手続きとして扱う。
 *
 * ⚠️ **最終的な可否は運営が決める。** 作家さまへ確認するのは事実確認で
 * あって、決定権ではない。**作家さまが答えなくても運営だけで進められる**
 * ——答えない方がいるという理由で、購入者への返金が止まってはいけない。
 *
 * ⚠️ **作家さまが返金を実行できる口を作らない。** 販売代金を預かっている
 * のは運営で、決済事業者へ投げられるのも運営だけである。
 *
 * ⚠️ **ここに時計も設定も持たない。** 期限もしきい値も呼び出し元が渡す。
 * 持たせると、境目を試験で再現できなくなる。
 */

/**
 * 申請の状態。
 *
 * ⚠️ **`executed` は「決済事業者が受け付けた」であって「入金された」では
 * ない。** 銀行振込の返金は日をまたぐ。ここを混ぜると、返っていないのに
 * 返した扱いの申請ができる。
 */
export const REFUND_REQUEST_STATUSES = [
  /** 申し出を受け付けた。まだ誰も見ていない。 */
  'submitted',
  /** 作家さまへ事実確認を依頼した。⚠️ 期限が来れば運営だけで進める。 */
  'creator_review',
  /** 運営が調べ終えた。⚠️ まだ承認ではない。 */
  'reviewed',
  /** 承認待ち。⚠️ 二重承認が要る額のとき、ここで**別の人**を待つ。 */
  'approval_pending',
  /** 承認済み。まだ返金は投げていない。 */
  'approved',
  /** 返さないと決めた。⚠️ 理由が必ず残る。 */
  'rejected',
  /** 決済事業者へ投げている最中。⚠️ **ここで二重に投げない。** */
  'executing',
  /** 投げ終えた。⚠️ 入金の完了ではない。 */
  'executed',
  /** 投げたが届かなかった。⚠️ **再実行できる。** */
  'execution_failed',
] as const;
export type RefundRequestStatus = (typeof REFUND_REQUEST_STATUSES)[number];

/** 終わった申請。⚠️ ここから先へ動かさない。 */
const TERMINAL_STATUSES: readonly RefundRequestStatus[] = ['rejected', 'executed'];

export function isTerminalRefundRequest(status: RefundRequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * 返金の理由。
 *
 * ⚠️ **既存の `RefundReason`（3 値）を置き換えない。** あちらは決済事業者へ
 * 渡す粗い符号で、こちらは**運営が選ぶ細かい理由**である。混ぜると、
 * 事業者の語彙がこちらの判断へ流れ込む。
 */
export const REFUND_REQUEST_REASONS = [
  /* --- 1. 運営だけで判断する --- */
  /** 二重決済。 */
  'duplicate_payment',
  /** 決済金額の誤り。 */
  'wrong_amount',
  /** システム障害。 */
  'system_failure',
  /** NFT（受取権）の発行失敗。 */
  'issuance_failed',
  /** 誤った受取権・権利の付与。 */
  'wrong_grant',
  /** カードの不正利用。 */
  'fraudulent_use',
  /** 決済事業者によるチャージバック。⚠️ もう引かれている。 */
  'chargeback',

  /* --- 2. 作家さまへ確認する --- */
  /** 作品説明と提供内容が異なる。 */
  'not_as_described',
  /** 作家さまが作品・特典を提供できない。 */
  'creator_cannot_deliver',
  /** 著作権その他の権利侵害の疑い。 */
  'rights_infringement',
  /** 作品固有の品質・内容に関する問題。 */
  'quality_issue',

  /* --- 3. 原則として返金対象外 --- */
  /** 購入者都合によるキャンセル。 */
  'buyer_change_of_mind',
  /** 外部ウォレットへ移転した後。 */
  'after_transfer',
  /** 受領・使用した後。 */
  'after_use',
  /** 第三者へ譲渡された後。 */
  'after_resale',
] as const;
export type RefundRequestReason = (typeof REFUND_REQUEST_REASONS)[number];

/** 理由の区分。⚠️ 理由から機械的に決まる（人が選び直せない）。 */
export const REFUND_CATEGORIES = ['operator_only', 'creator_confirmation', 'excluded'] as const;
export type RefundCategory = (typeof REFUND_CATEGORIES)[number];

const CATEGORY_BY_REASON: Readonly<Record<RefundRequestReason, RefundCategory>> = {
  duplicate_payment: 'operator_only',
  wrong_amount: 'operator_only',
  system_failure: 'operator_only',
  issuance_failed: 'operator_only',
  wrong_grant: 'operator_only',
  fraudulent_use: 'operator_only',
  chargeback: 'operator_only',

  not_as_described: 'creator_confirmation',
  creator_cannot_deliver: 'creator_confirmation',
  rights_infringement: 'creator_confirmation',
  quality_issue: 'creator_confirmation',

  buyer_change_of_mind: 'excluded',
  after_transfer: 'excluded',
  after_use: 'excluded',
  after_resale: 'excluded',
};

/**
 * 理由から区分を決める。
 *
 * ⚠️ **人に選ばせない。** 選べると、作家さまへの確認が要る理由を
 * 「運営だけ」にして飛ばせてしまう。理由を選べば区分は決まる。
 */
export function categoryOf(reason: RefundRequestReason): RefundCategory {
  return CATEGORY_BY_REASON[reason];
}

/**
 * 作家さまへの確認が要るか。
 *
 * ⚠️ **要否は区分だけで決まる。** 金額でも購入者でもない。事実を知って
 * いるのが作家さまだけ、という理由で確認するのだから。
 */
export function needsCreatorConfirmation(reason: RefundRequestReason): boolean {
  return categoryOf(reason) === 'creator_confirmation';
}

/**
 * 原則として返金しない理由か。
 *
 * ⚠️ **「申請できない」ではない。** 申請は受け付け、既定では却下する。
 * ただし**権利侵害や重大な障害では、運営が例外として承認できる**
 * （`approveAsException`）。受け付けないと、申し出そのものが記録に残らない。
 */
export function isExcludedByDefault(reason: RefundRequestReason): boolean {
  return categoryOf(reason) === 'excluded';
}

/**
 * 購入者が自分で選べる事由。
 *
 * ⚠️ **区分では絞れない。** 「運営だけで判断する」区分にも、購入者が
 * 気づいて言えること（二重に引き落とされた、金額が違う）が入っている。
 * 絞るのは**購入者には分からないこと**の 3 つだけ:
 *
 *   - `chargeback` ……決済事業者から届く事実であって、人が申し出る事由ではない
 *   - `wrong_grant` ……何が正しく渡るはずだったかは、運営にしか分からない
 *   - `fraudulent_use` ……不正利用と決めるのは運営の判断で、申し出の事由ではない
 *
 * ⚠️ **原則対象外（`excluded`）を外していない。** 気が変わった、という
 * 申し出も受け付ける。受け付けないと、その申し出が記録に残らない——
 * どれだけ来ているかが分からないまま、規約だけが正しいことになる。
 */
export const BUYER_SELECTABLE_REFUND_REASONS: readonly RefundRequestReason[] =
  REFUND_REQUEST_REASONS.filter(
    (reason) => reason !== 'chargeback' && reason !== 'wrong_grant' && reason !== 'fraudulent_use',
  );

/**
 * この返金を、誰が被るか（決定 2026-08-22）。
 *
 * ⚠️ **これまで、事由を見ずに全部作家さまから差し引いていた。** 精算の
 * 差し戻し（`listClawbacks`）に事由の条件が無く、**こちらの不具合で返金した
 * 分まで作家さまの次回の売上から引いていた**。ここはその手当てである。
 *
 * ⚠️ **「払ったあとの返金」はほとんどが作家さまの落ち度ではない。** 精算は
 * 返金の窓が閉じてから確定する（`canConfirmPayout`）ので、ご購入者都合の
 * 返金は精算に載る前に決着している。あとから来るのは、こちらの落ち度・
 * チャージバック・運営が例外として通したもの——どれも作家さまのせいではない。
 */
export type ClawbackBearer = 'platform' | 'creator';

export function clawbackBearerFor(input: {
  readonly reason: RefundRequestReason;
  /** 原則対象外を、運営が例外として通したか。 */
  readonly approvedAsException: boolean;
}): ClawbackBearer {
  /*
    ⚠️ **例外として通したなら運営が被る。** 規約では原則お受けしない事由を、
       運営の判断でお返しした——作家さまは何も間違えていない。ここを
       作家さま負担にすると、運営の親切の代金を作家さまが払うことになる。
  */
  if (input.approvedAsException) {
    return 'platform';
  }

  return PLATFORM_BORNE_REASONS.includes(input.reason) ? 'platform' : 'creator';
}

/**
 * 運営が被る事由。
 *
 * ⚠️ **こちらの落ち度は、作家さまへ回さない。** 作家さまはお渡ししている。
 * ⚠️ **決済のリスクも運営が備える。** チャージバックと不正利用は、場を
 * 開いている側が引き受けるもので、手数料がその対価である。
 * ⚠️ **ここに無い事由は作家さまが負う。** 事由を足したときに、既定で
 * 作家さま負担へ倒れる——**足し忘れたら作家さまが払う**、という向きなので、
 * 新しい事由を足すときは必ずこの表を見直すこと。
 */
const PLATFORM_BORNE_REASONS: readonly RefundRequestReason[] = [
  // こちらの落ち度。
  'duplicate_payment',
  'wrong_amount',
  'system_failure',
  'issuance_failed',
  'wrong_grant',
  // 決済のリスク。
  'chargeback',
  'fraudulent_use',
];

/**
 * 決済事業者へ渡す 3 値から、負担者を割り出す。
 *
 * ⚠️ **申請を通らない返金のため。** 運営が注文の画面から直接返した返金には
 * 15 事由が無く、`refunds.reason` の 3 値しか残っていない。
 * ⚠️ **`provider_initiated` は運営が被る。** 事業者の画面から返された
 * ——チャージバックがここに来る。
 */
export function clawbackBearerForRefundReason(reason: RefundReason): ClawbackBearer {
  return reason === 'buyer_request' ? 'creator' : 'platform';
}

export function isBuyerSelectableReason(reason: RefundRequestReason): boolean {
  return BUYER_SELECTABLE_REFUND_REASONS.includes(reason);
}

/* --- 権利の扱い --------------------------------------------------------- */

/**
 * 返金にともなって、受取権をどうするか。
 *
 * ⚠️ **一部返金では、運営が承認のときに指定する。** 機械には決められない
 * ——どのシリアルを取り消すべきかは、返金の中身によって変わる。
 */
export const ENTITLEMENT_DISPOSITIONS = ['revoke', 'keep'] as const;
export type EntitlementDisposition = (typeof ENTITLEMENT_DISPOSITIONS)[number];

/**
 * 受取権の状態から、既定の扱いを提案する。
 *
 * ⚠️ **提案であって決定ではない。** 承認の画面で運営が上書きできる。
 * ⚠️ **`claimed` の既定は `keep`。** 受け取ったものは回収できない
 * （`UD-104` 追補）。取り消すなら、運営が例外として指定する。
 */
export function suggestDisposition(input: {
  readonly entitlementStatus: EntitlementStatus | null;
  readonly mintStatus: MintJobStatus | null;
  readonly isFullRefund: boolean;
}): EntitlementDisposition {
  // ⚠️ 一部返金の既定は「維持」。返した額だけでは、どれを取り消すか決まらない。
  if (!input.isFullRefund) {
    return 'keep';
  }
  /*
    ⚠️ **外部へ送信済みの可能性があるものは維持。** 発行処理中・発行済みは
       回収できない。取り消したことにすると、記録と実物が食い違う。
  */
  if (input.mintStatus === 'processing' || input.mintStatus === 'succeeded') {
    return 'keep';
  }
  // ⚠️ 受け取り済みは既定で維持（例外指定でのみ取り消す）。
  if (input.entitlementStatus === 'claimed') {
    return 'keep';
  }
  return 'revoke';
}

/* --- 二重承認 ------------------------------------------------------------ */

/**
 * 二重承認が要るか。
 *
 * ⚠️ **しきい値が `null` なら、二重承認は使わない。** 0 を「常に要る」の
 * 意味に使わない——設定を消し忘れたのか、全件に課したいのかが読めなくなる。
 */
export function requiresDualApproval(input: {
  readonly amount: number;
  readonly thresholdAmount: number | null;
}): boolean {
  return input.thresholdAmount !== null && input.amount >= input.thresholdAmount;
}

/**
 * 承認してよいか。
 *
 * ⚠️ **二重承認の要は「別の人であること」。** 同じ人が申請して承認できる
 * なら、承認の欄が 1 つ増えただけで、歯止めにならない。
 */
export type ApprovalDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'same_person' | 'not_reviewed' | 'already_settled' };

export function canApprove(input: {
  readonly status: RefundRequestStatus;
  readonly requestedByAccountId: string | null;
  readonly approverAccountId: string;
  readonly dualApprovalRequired: boolean;
}): ApprovalDecision {
  if (isTerminalRefundRequest(input.status)) {
    return { ok: false, reason: 'already_settled' };
  }
  /*
    ⚠️ **調べ終える前に承認させない。** 承認だけ先に押せると、
       作家さまへの確認も調査も飛ばした承認ができる。
  */
  if (input.status !== 'reviewed' && input.status !== 'approval_pending') {
    return { ok: false, reason: 'not_reviewed' };
  }
  if (
    input.dualApprovalRequired &&
    input.requestedByAccountId !== null &&
    input.requestedByAccountId === input.approverAccountId
  ) {
    return { ok: false, reason: 'same_person' };
  }
  return { ok: true };
}

/* --- 作家さまへの確認の期限 ---------------------------------------------- */

/**
 * 営業日を足す。
 *
 * ⚠️ **祝日を見ていない。** 祝日の表を持っていないためで、**連休のある月は
 * 実際より短くなる**。運用でそのことを承知して使うこと。表を持つと決めた
 * ときは、ここへ渡す形にする（この関数に埋め込まない）。
 *
 * ⚠️ **JST で数える。** 実行環境の地方時に依らない。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function addBusinessDays(from: Date, days: number): Date {
  let remaining = days;
  let cursor = from.getTime();
  while (remaining > 0) {
    cursor += 24 * 60 * 60 * 1000;
    const weekday = new Date(cursor + JST_OFFSET_MS).getUTCDay();
    // 0 = 日曜、6 = 土曜。
    if (weekday !== 0 && weekday !== 6) {
      remaining -= 1;
    }
  }
  return new Date(cursor);
}

/**
 * 作家さまの回答期限が過ぎたか。
 *
 * ⚠️ **過ぎても申請は止まらない。** 運営だけで進められる、というのが
 * この期限の意味である。「答えないと返金できない」にすると、答えない
 * 作家さまがいるだけで購入者が待たされる。
 */
export function creatorInquiryExpired(input: {
  readonly dueAt: Date;
  readonly answeredAt: Date | null;
  readonly now: Date;
}): boolean {
  return input.answeredAt === null && input.now.getTime() > input.dueAt.getTime();
}

/* --- 金額 ---------------------------------------------------------------- */

/**
 * 返金してよい額か。
 *
 * ⚠️ **残額を超えない。** 超えると、受け取った額より多く返すことになる。
 * ⚠️ **0 円の返金を作らない。** 記録だけが残り、何も起きない行になる。
 */
export type RefundAmountCheck =
  | { readonly ok: true; readonly isFullRefund: boolean }
  | { readonly ok: false; readonly reason: 'not_positive' | 'exceeds_remaining' };

export function checkRefundAmount(input: {
  readonly amount: number;
  readonly orderTotal: number;
  readonly alreadyRefunded: number;
}): RefundAmountCheck {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, reason: 'not_positive' };
  }
  const remaining = input.orderTotal - input.alreadyRefunded;
  if (input.amount > remaining) {
    return { ok: false, reason: 'exceeds_remaining' };
  }
  return { ok: true, isFullRefund: input.alreadyRefunded + input.amount >= input.orderTotal };
}
