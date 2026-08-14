import type { ClockPort } from '../ports/index';
import type { WalletDeliveryOutboxPort, WalletDeliveryRecord } from '../ports/wallet-delivery';
import { decideDelivery, type DeliveryDecision } from './dispatch';
import type { WalletDeliverySenderPort } from '../ports/wallet-delivery';

/**
 * 配送待ち行列を 1 巡ぶん処理する。
 *
 * ⚠️ **1 巡で扱う件数に上限を置く。**
 * 上限が無いと、相手が復旧した直後に溜まっていた全件を一気に送りつけ、
 * 復旧しかけた相手をもう一度落とす。
 *
 * ⚠️ **この関数は時計を持たない。** 現在時刻は `clock` から取る。
 * 実装が自分で `new Date()` を読むと、テストで時間を進められず、
 * バックオフの検証ができなくなる。
 */

export interface WalletDeliveryDependencies {
  readonly outbox: WalletDeliveryOutboxPort;
  readonly sender: WalletDeliverySenderPort;
  readonly clock: ClockPort;
}

/** 1 行ぶんの処理結果。⚠️ 本文や個人情報を含めない（ログへ出るため）。 */
export interface WalletDeliveryOutcome {
  readonly id: string;
  readonly eventId: string;
  readonly decision: DeliveryDecision;
}

/**
 * `PROCESSING` を取り残しとみなすまでの時間。
 *
 * 送信の待ち上限（既定 10 秒）よりずっと長くしてある。
 * 短くすると、まだ応答を待っている行を別のワーカーが二重に送る。
 */
export const STALE_PROCESSING_MS = 15 * 60_000;

export async function sweepWalletDeliveries(
  deps: WalletDeliveryDependencies,
  limit: number,
): Promise<WalletDeliveryOutcome[]> {
  const startedAt = deps.clock.now();
  // 送信中にプロセスが落ちた行を先に戻す。放っておくと誰も拾わない。
  await deps.outbox.reclaimStale({
    staleBefore: new Date(startedAt.getTime() - STALE_PROCESSING_MS),
    now: startedAt,
  });

  const claimed = await deps.outbox.claimBatch({ limit, now: deps.clock.now() });
  const outcomes: WalletDeliveryOutcome[] = [];

  for (const record of claimed) {
    outcomes.push(await deliverOne(deps, record));
  }
  return outcomes;
}

/**
 * 1 行を送り、結果を書き戻す。
 *
 * ⚠️ **送信中に投げられた例外を、そのまま外へ出さない。**
 * 出すと、その行は `PROCESSING` のまま残り、次の巡回で拾われない。
 * 「送ったのか送っていないのか分からない行」が静かに溜まる。
 * 送信の失敗はすべて `DeliveryAttemptOutcome` として扱い、必ず書き戻す。
 */
async function deliverOne(
  deps: WalletDeliveryDependencies,
  record: WalletDeliveryRecord,
): Promise<WalletDeliveryOutcome> {
  const outcome = await deps.sender
    .send({
      eventId: record.eventId,
      correlationId: record.correlationId,
      payload: record.payload,
    })
    // アダプタが想定外の例外を投げた場合も、通信失敗として扱う。
    .catch((): { readonly kind: 'network' } => ({ kind: 'network' }));

  const decision = decideDelivery(outcome, {
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
  });

  const now = deps.clock.now();
  if (decision.next === 'DELIVERED') {
    await deps.outbox.markDelivered({ id: record.id, now });
  } else {
    await deps.outbox.recordFailure({
      id: record.id,
      status: decision.next,
      nextRetryAt:
        decision.next === 'PENDING' ? new Date(now.getTime() + decision.retryAfterMs) : now,
      errorCode: decision.errorCode,
      // ⚠️ 応答本文を入れない。分類コードだけで運用が判断できるようにする。
      errorMessage: null,
      now,
    });
  }

  return { id: record.id, eventId: record.eventId, decision };
}
