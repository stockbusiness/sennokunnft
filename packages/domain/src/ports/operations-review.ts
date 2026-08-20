import type { ListCursor } from '../shared/cursor';
import type {
  OpenOperationsReviewCommand,
  OperationsReviewReasonCode,
  OperationsReviewRecord,
  OperationsReviewStatus,
} from '../operations/review';

/** 一覧の絞り込み。 */
export interface OperationsReviewQuery {
  /**
   * 対応状況での絞り込み。空なら全件。
   *
   * ⚠️ **既定を「未対応だけ」にしない。** 一覧を開いた人が
   * 「0 件だから何も無い」と読み違える。絞り込みは明示的に選ばせる。
   */
  readonly statuses: readonly OperationsReviewStatus[];
  readonly reasonCodes: readonly OperationsReviewReasonCode[];
  readonly cursor: ListCursor | null;
  readonly limit: number;
}

export interface OperationsReviewPage {
  readonly items: readonly OperationsReviewRecord[];
  readonly nextCursor: ListCursor | null;
}

/** 未対応の件数。監視の閾値に使う。 */
export type OperationsReviewOpenCounts = Readonly<Record<OperationsReviewReasonCode, number>>;

/**
 * 運用確認キューの永続化。
 *
 * ⚠️ **`open` は冪等でなければならない。** 同じ返金の Webhook が
 * 2 度届いても、確認事項が 2 行に増えてはいけない。同じ対象・同じ理由なら
 * 1 行にまとめる（`(subject_type, subject_id, reason_code)` の UNIQUE）。
 *
 * ⚠️ **`open` は例外を投げてはならない。** 呼び出し元は返金の
 * トランザクションの中にいる。ここで落ちると、**返金そのものが巻き戻る**。
 */
export interface OperationsReviewRepository {
  /**
   * 確認事項を積む。すでに同じものがあれば何もしない。
   *
   * @returns 新しく積んだら `true`、すでにあったら `false`
   */
  open(command: OpenOperationsReviewCommand): Promise<boolean>;

  list(query: OperationsReviewQuery): Promise<OperationsReviewPage>;

  /**
   * 未対応の件数を理由ごとに数える。
   *
   * ⚠️ **絞り込みの影響を受けない全体の件数を返す。**
   */
  countOpen(): Promise<OperationsReviewOpenCounts>;

  /**
   * 対応済みにする。
   *
   * ⚠️ **行を消さない。** 「こういう確認が起きた」という事実は残す。
   * @returns 状態を動かせたら `true`（すでに対応済みなら `false`）
   */
  resolve(input: {
    readonly id: string;
    readonly actorAccountId: string;
    readonly note: string | null;
    readonly now: Date;
  }): Promise<boolean>;
}
