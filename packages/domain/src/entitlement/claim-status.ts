import type { EntitlementStatus } from '../state/machines';

/**
 * Claim API が外部（OVEW Wallet）へ公開する状態。
 *
 * ✅ **確定（`UD-1007` / 2026-08-14 回答書）。公開するのはこの 5 値のみ。**
 *
 * ⚠️ **内部状態をそのまま返さない。**
 * 内部の `EntitlementStatus` は本システムの都合で増える。
 * 増えた値がそのまま外へ出ると、相手の分岐が知らない値を受け取って壊れる。
 * ここで**明示的に写像する**ことで、内部を増やしても外の契約が動かないようにする。
 */
export const PUBLIC_CLAIM_STATUSES = [
  'PENDING',
  'DELIVERY_PENDING',
  'DELIVERED',
  'EXPIRED',
  'REVOKED',
] as const;

export type PublicClaimStatus = (typeof PUBLIC_CLAIM_STATUSES)[number];

/**
 * Wallet への配送状態。
 *
 * ⚠️ **本 PR では配送そのものを実装しない**（指示書 §15「Wallet Delivery本体の先行実装」禁止）。
 * ここで持つのは、公開状態を組み立てるために**必要な最小の記録**だけ。
 * `delivered` へ進めるのは PR-NW04 の責務。
 */
export const WALLET_DELIVERY_STATUSES = ['not_started', 'pending', 'delivered'] as const;
export type WalletDeliveryStatus = (typeof WALLET_DELIVERY_STATUSES)[number];

/**
 * 公開状態を組み立てる。
 *
 * 公開状態は「Claim が済んだか」と「Wallet へ届いたか」の **2 つの軸の合成**であり、
 * どちらか一方だけでは決まらない。
 *
 * | 内部状態  | 配送状態      | 公開状態           |
 * | --------- | ------------- | ------------------ |
 * | `issued`  | （問わない）  | `PENDING`          |
 * | `claimed` | `delivered`   | `DELIVERED`        |
 * | `claimed` | それ以外      | `DELIVERY_PENDING` |
 * | `expired` | （問わない）  | `EXPIRED`          |
 * | `revoked` | （問わない）  | `REVOKED`          |
 *
 * ⚠️ **`claimed` を無条件に `DELIVERED` としない。**
 * 受け取りを確定しただけで「届いた」と答えると、配送が失敗しても
 * 相手には成功に見える。届いていないものを届いたと言わない。
 */
export function toPublicClaimStatus(
  status: EntitlementStatus,
  delivery: WalletDeliveryStatus,
): PublicClaimStatus {
  switch (status) {
    case 'issued':
      return 'PENDING';
    case 'claimed':
      return delivery === 'delivered' ? 'DELIVERED' : 'DELIVERY_PENDING';
    case 'expired':
      return 'EXPIRED';
    case 'revoked':
      return 'REVOKED';
  }
}
