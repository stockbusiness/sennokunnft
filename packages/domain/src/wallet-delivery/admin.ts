import type { ListCursor } from '../shared/cursor';
import type { WalletDeliveryOutboxStatus } from './dispatch';
import type { WalletDeliveryEventType } from './event';

/**
 * 送信の運用画面が読む 1 行（管理画面・外部連携 指示書 §5）。
 *
 * ⚠️ **`payload` を持たない。** 送信本文には受取権の中身が入る。
 * 指示書 §5 は「Wallet へ送った本文全体を無条件で表示しない」と定めており、
 * 一覧の型に本文を含めてしまうと、画面側で「出さない」と決めるまでの
 * どこか 1 箇所の書き忘れで出てしまう。**型から消しておけば書き忘れようがない。**
 *
 * 同じ理由で `Authorization` ヘッダー・API キー・HMAC 署名値も持たない。
 * それらはそもそも行に保存されていないが、あとから「デバッグに便利だから」と
 * 足されないよう、ここに書き残しておく。
 *
 * 本文が正しいかを確かめたいときは `payloadHash` を突き合わせる。
 * 中身を見なくても「送ったものが変わっていないか」は分かる。
 */
export interface WalletDeliveryAdminRecord {
  readonly id: string;
  /** 相手の `Idempotency-Key` と同じ値。問い合わせのときはこれを伝える。 */
  readonly eventId: string;
  readonly eventType: WalletDeliveryEventType;
  readonly entitlementId: string;
  readonly targetSiteKey: string;
  /** `sha256:<hex>`。本文そのものは持たない。 */
  readonly payloadHash: string;
  readonly status: WalletDeliveryOutboxStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  /** 次に自動で送り直す予定の時刻。`PENDING` のときだけ意味を持つ。 */
  readonly nextRetryAt: Date;
  /** 失敗の分類コード（`timeout` / `network` / `http_503` など）。 */
  readonly lastErrorCode: string | null;
  /** 運用が読むための要約。⚠️ 応答本文そのものではない。 */
  readonly lastErrorMessage: string | null;
  /** Claim から配送まで引き継がれる相関ID。ログを辿るときに使う。 */
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deliveredAt: Date | null;
}

/** 一覧の絞り込み。 */
export interface WalletDeliveryAdminQuery {
  /**
   * 状態での絞り込み。空なら全件。
   *
   * ⚠️ **既定を「失敗だけ」にしない。** 運用画面を開いた人が
   * 「失敗が 0 件だから全部届いている」と読み違える。全件を既定にして、
   * 絞り込みは明示的に選ばせる。
   */
  readonly statuses: readonly WalletDeliveryOutboxStatus[];
  /** 完全一致で 1 件を引く。問い合わせ番号から辿るための入口。 */
  readonly eventId: string | null;
  readonly entitlementId: string | null;
  /** 続きの位置。`null` なら先頭から。 */
  readonly cursor: WalletDeliveryAdminCursor | null;
  readonly limit: number;
}

/** 続きを読む位置。並び順は「作成時刻の新しい順、同時刻なら行IDの降順」。 */
export type WalletDeliveryAdminCursor = ListCursor;

export interface WalletDeliveryAdminPage {
  readonly items: readonly WalletDeliveryAdminRecord[];
  /** 続きがあるときだけ入る。 */
  readonly nextCursor: WalletDeliveryAdminCursor | null;
}

/** 状態ごとの件数。運用画面の見出しに出す。 */
export type WalletDeliveryStatusCounts = Readonly<Record<WalletDeliveryOutboxStatus, number>>;

/** 一覧で一度に返す既定の件数。スマホで見るので多くしない。 */
export const WALLET_DELIVERY_PAGE_SIZE = 20;

/** 一覧で受け付ける上限。大きな値で丸ごと吸い出されないようにする。 */
export const WALLET_DELIVERY_MAX_PAGE_SIZE = 100;

/** 一度に再送してよい件数の上限。 */
export const WALLET_DELIVERY_MAX_BULK_RESEND = 50;

/** 1 件ぶんの再送の結果。 */
export type WalletDeliveryResendOutcome =
  /** `PENDING` へ戻した。次の巡回で送られる。 */
  | 'requeued'
  /** その行が無い。 */
  | 'not_found'
  /**
   * その状態からは戻せない（`PENDING` / `PROCESSING` / `DELIVERED`）。
   *
   * ⚠️ **これを成功として丸めない。** 押した人は「送り直した」と思うが、
   * 実際には何も起きていない。届かないまま待たれるより、断った方がよい。
   */
  | 'not_resendable';

export interface WalletDeliveryResendResult {
  readonly id: string;
  readonly outcome: WalletDeliveryResendOutcome;
}

