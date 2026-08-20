import type { WalletDeliveryStatus } from '../entitlement/claim-status';
import type { EntitlementStatus } from '../state/machines';

/**
 * 買った方が自分の受け取ったものを見る口（P0-3）。
 *
 * ⚠️ **管理側の読み取りモデルと分ける。** あちらは運営が全員分を見るための
 * もので、購入者・金額・手数料まで載る。ここへ流用すると、画面に出さない
 * つもりの値が応答には載っている状態になる。
 */

/** 1 枚の受け取り。⚠️ 金額も手数料も載せない。買った方の関心事ではない。 */
export interface CollectibleView {
  readonly entitlementId: string;
  readonly artworkId: string;
  /** 作品ページへ戻る導線に使う。 */
  readonly artworkSlug: string;
  /**
   * 作品名。
   *
   * ⚠️ **注文時点の名前**（`order_lines.artwork_title_snapshot`）。作家さまが
   * 改題しても、お買い上げの記録は当時の表示のまま残る。マスタを引き直すと、
   * お客さまが受け取った控えと画面が食い違う。
   */
  readonly artworkTitle: string;
  /** 出品者のお名前（注文時点）。⚠️ 未登録の時期に買われた分は `null`。 */
  readonly creatorName: string | null;
  /**
   * 画像。
   *
   * ⚠️ **これだけは現在の作品のものを使う。** 画像はスナップショットを
   * 取っていない（列が無い）。差し替えられれば表示も変わる——本文の
   * ハッシュを固めている Wallet 側とは違う扱いになる点に注意。
   */
  readonly imageKey: string | null;
  readonly serialNo: number;
  readonly acquiredAt: Date;
  readonly status: EntitlementStatus;
  readonly deliveryStatus: WalletDeliveryStatus;
  /** 問い合わせのときに読み上げる番号。 */
  readonly orderNumber: string;
  readonly orderId: string;
}

export interface CollectibleListPage {
  readonly items: readonly CollectibleView[];
  readonly nextCursor: string | null;
}

export interface CollectibleRepository {
  /**
   * ご自分の受け取ったものを新しい順に返す。
   *
   * ⚠️ **誰の分かを必ず絞る。** 呼び出し元が絞る形にすると、絞り忘れが
   * そのまま全員分の流出になる。ここで受け取ったアカウント以外の行を
   * 返さないことを、この口の責務にする。
   */
  listForAccount(input: {
    readonly accountId: string;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): Promise<CollectibleListPage>;
}
