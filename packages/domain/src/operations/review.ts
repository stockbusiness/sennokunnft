/**
 * 運用確認キュー。
 *
 * 「機械では決められなかったこと」を**記録として残し、必ず拾い直せる**ようにする。
 *
 * ⚠️ **ログ出力で済ませない。** ログは流れて消える。人が確認するべき事柄は、
 * 未対応か対応済みかを持った行として残らないと、忙しい日にそのまま埋もれる。
 *
 * ⚠️ **業務処理を止めない。** ここへ積むのは「返金は成立したが、
 * 付随する判断が残っている」という状況である。積めなかったからといって
 * 返金を巻き戻すことはしない。
 */

/** 何についての確認か。 */
export const OPERATIONS_REVIEW_SUBJECT_TYPES = ['order', 'entitlement'] as const;
export type OperationsReviewSubjectType = (typeof OPERATIONS_REVIEW_SUBJECT_TYPES)[number];

/**
 * なぜ確認が要るのか。⚠️ **固定コードのみ。自由記述にしない。**
 *
 * 自由記述にすると、同じ事象が人によって別の文言で積まれ、
 * 「いま何件残っているか」を数えられなくなる。
 */
export const OPERATIONS_REVIEW_REASON_CODES = [
  /**
   * 一部返金だが、どの受取権・どのシリアルを取り消すべきか確定できない。
   *
   * 数量や明細を指定して返金する経路がまだ無いため、金額だけでは
   * 対象を特定できない。**推測で取り消さない**（2026-08-20 決定）。
   */
  'partial_refund_entitlement_unresolved',
  /**
   * 全額返金で取り消したが、Wallet へ送る宛先（共通顧客ID）が記録から取れない。
   *
   * 付与は送っているのに宛先が分からない＝記録の食い違い。
   * **推測で誰かの Holding を消さない。**
   */
  'wallet_revocation_recipient_unresolved',
  /**
   * 同じイベントIDで、以前と異なる本文を作ろうとした。
   *
   * 冪等キーが同じなのに中身が違う＝どちらが相手に保存されたのか
   * こちらからは分からない。**無言で成功にしない。**
   */
  'wallet_revocation_payload_conflict',
] as const;
export type OperationsReviewReasonCode = (typeof OPERATIONS_REVIEW_REASON_CODES)[number];

/** 対応状況。 */
export const OPERATIONS_REVIEW_STATUSES = ['open', 'resolved'] as const;
export type OperationsReviewStatus = (typeof OPERATIONS_REVIEW_STATUSES)[number];

/** 一覧で一度に返す既定の件数。 */
export const OPERATIONS_REVIEW_PAGE_SIZE = 20;

/** 一覧で受け付ける上限。 */
export const OPERATIONS_REVIEW_MAX_PAGE_SIZE = 100;

/**
 * 積むときの入力。
 *
 * ⚠️ **`detail` に個人情報を入れない。** ここは監視にも管理画面にも出る。
 * 入れてよいのは業務上の識別子と、機械が判断できなかった理由まで。
 */
export interface OpenOperationsReviewCommand {
  readonly subjectType: OperationsReviewSubjectType;
  readonly subjectId: string;
  /** 辿るための注文。⚠️ 対象が注文そのものなら `subjectId` と同じ値。 */
  readonly orderId: string | null;
  readonly reasonCode: OperationsReviewReasonCode;
  /** 機械が判断できなかった理由。⚠️ 個人情報・秘密値を入れない。 */
  readonly detail: string;
  readonly now: Date;
}

/** 画面と監視が読む 1 行。 */
export interface OperationsReviewRecord {
  readonly id: string;
  readonly subjectType: OperationsReviewSubjectType;
  readonly subjectId: string;
  readonly orderId: string | null;
  readonly reasonCode: OperationsReviewReasonCode;
  readonly detail: string;
  readonly status: OperationsReviewStatus;
  /** 対応した運営スタッフ。⚠️ 氏名ではなくアカウントIDで持つ。 */
  readonly resolvedByAccountId: string | null;
  readonly resolvedAt: Date | null;
  /** 対応の記録。⚠️ 個人情報を入れない。 */
  readonly resolutionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
