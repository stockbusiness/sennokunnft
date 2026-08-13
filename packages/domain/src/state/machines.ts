import { createStateMachine, type TransitionTable } from './transition';

/**
 * 注文の状態（DOMAIN_MODEL.md §4.1）。
 *
 * `pending → paid` の契機は**決済 Webhook のみ**。
 * 成功画面への到達で `paid` にする遷移はここに存在しない。
 */
export const ORDER_STATUSES = ['pending', 'paid', 'failed', 'expired', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const orderTable: TransitionTable<OrderStatus> = {
  pending: ['paid', 'failed', 'expired'],
  paid: ['refunded'],
  failed: [],
  expired: [],
  refunded: [],
};

export const orderStateMachine = createStateMachine(orderTable);

/**
 * 受取権の状態（DOMAIN_MODEL.md §4.2）。
 *
 * `claimed` は終端。一度受け取られた受取権は他の状態へ戻らない（INV-E2）。
 * 返金があっても `claimed` のままにするのは、
 * 発行済み資産の回収可否が未決定（UD-511）で、勝手に取り消せないため。
 */
export const ENTITLEMENT_STATUSES = ['issued', 'claimed', 'expired', 'revoked'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

const entitlementTable: TransitionTable<EntitlementStatus> = {
  issued: ['claimed', 'expired', 'revoked'],
  claimed: [],
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
