import { createStateMachine, type TransitionTable } from './transition';

/*
  注文の状態は `order/order-status.ts` へ移した（決済 Phase P0・P1）。

  ⚠️ **ここに残しておかない。** 以前は 1 本の列に
  `pending / paid / failed / expired / refunded` を詰め込んでいたが、
  「決済は成功したが付与に失敗した」のような組み合わせを表せない。
  移した先では、注文・決済・付与・返金の 4 本に分けてある。

  ⚠️ **2 つ置くと、片方だけ直される。** 使っていないほうが残っていると、
  次に触る人がどちらを直せばよいか分からない。消して 1 本にする。
*/

/**
 * 受取権の状態（DOMAIN_MODEL.md §4.2）。
 *
 * `revoked` が終端。**`claimed` は終端ではない**（`UD-104` 追補・2026-08-20 決定）。
 *
 * ⚠️ **「受け取った事実」と「いま使える権利」を分ける。**
 * 全額返金が成立した以上、権利が使えるまま残るのは認められない。
 * かといって受け取った事実は起きたことなので、記録からは消さない。
 * したがって `claimed → revoked` を許し、`claimed_at` / `claimed_by_*` /
 * Wallet の配送記録は**そのまま残す**。
 *
 * ⚠️ **`revoked` から戻る道を作らない。** 再付与が要るなら、この行を
 * 戻すのではなく**新しい受取権**を発行する。戻せるようにすると、
 * 「いま有効か」を状態列だけでは答えられなくなる。
 */
export const ENTITLEMENT_STATUSES = ['issued', 'claimed', 'expired', 'revoked'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

const entitlementTable: TransitionTable<EntitlementStatus> = {
  issued: ['claimed', 'expired', 'revoked'],
  // 全額返金でのみ取り消す。⚠️ `issued` / `expired` へは戻さない。
  claimed: ['revoked'],
  expired: [],
  revoked: [],
};

export const entitlementStateMachine = createStateMachine(entitlementTable);

/**
 * 発行ジョブの状態（DOMAIN_MODEL.md §4.3）。
 *
 * `processing → queued` があるのは再試行のため。
 * ただしこの遷移を**自動で**行ってよいのは、外部へ未送信だと確認できた場合に限る
 * （INV-M4 / LAZY_MINT_FLOW.md §3.6）。状態機械は遷移の可否だけを表し、
 * 「いつ戻してよいか」の判断はワーカーの運用ロジック側にある。
 */
export const MINT_JOB_STATUSES = [
  'queued',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type MintJobStatus = (typeof MINT_JOB_STATUSES)[number];

const mintJobTable: TransitionTable<MintJobStatus> = {
  queued: ['processing', 'cancelled'],
  processing: ['succeeded', 'failed', 'queued'],
  succeeded: [],
  failed: ['queued'],
  cancelled: [],
};

export const mintJobStateMachine = createStateMachine(mintJobTable);

/**
 * 作品の状態（DATABASE_DESIGN.md §3.2）。
 *
 * `archived` から `published` へ戻せるようにしてある。
 * 一時的に販売を止めて再開する運用は普通にありうるため。
 * 一方 `published` から `draft` へは戻さない。
 * 公開済みの作品を下書きに戻すと、参照していた出品や注文の前提が崩れる。
 */
export const ARTWORK_STATUSES = ['draft', 'published', 'archived'] as const;
export type ArtworkStatus = (typeof ARTWORK_STATUSES)[number];

const artworkTable: TransitionTable<ArtworkStatus> = {
  draft: ['published', 'archived'],
  published: ['archived'],
  archived: ['published'],
};

export const artworkStateMachine = createStateMachine(artworkTable);

/**
 * 出品の状態（DATABASE_DESIGN.md §3.3）。
 *
 * - `draft`     … 作成直後。まだ誰にも見えない
 * - `scheduled` … 販売開始を予約した。開始日時が来たら購入可能になる
 * - `active`    … 販売中
 * - `suspended` … 一時停止。編集して再開できる
 * - `ended`     … 販売終了。**終端**
 *
 * `ended` を終端にしているのは、「終了しました」と表示したものが
 * 後から復活すると購入者の信頼を損ねるため。
 * 再度売るなら新しい出品を作る（価格や期間の履歴も残る）。
 *
 * ⚠️ `scheduled` と `active` の**表示上の**切り替わりは、状態列ではなく
 * 販売開始日時と現在時刻の比較で決まる（`resolveDisplayState`）。
 * 開始時刻に列を書き換えるバッチを前提にすると、
 * バッチが遅れただけで売れなくなる。
 */
export const LISTING_STATUSES = ['draft', 'scheduled', 'active', 'suspended', 'ended'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

const listingTable: TransitionTable<ListingStatus> = {
  draft: ['scheduled', 'active', 'ended'],
  scheduled: ['active', 'suspended', 'ended'],
  active: ['suspended', 'ended'],
  suspended: ['active', 'scheduled', 'ended'],
  ended: [],
};

export const listingStateMachine = createStateMachine(listingTable);
