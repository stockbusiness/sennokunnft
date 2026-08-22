import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConsistencyResponse,
  DisputeAdminListResponse,
  DisputeAdminQuery,
  DisputeAdminView,
  EntitlementAdminDetailView,
  EntitlementAdminListResponse,
  EntitlementAdminQuery,
  OperationsDashboardResponse,
  RedeliverResponse,
  RetryIssuanceResponse,
} from '@sengoku/contracts';
import {
  buildConsistencyFindings,
  buildIndicators,
  disputeUrgency,
  overallSeverity,
  type ClockPort,
  type DisputeListItem,
  type DisputePort,
  type EntitlementAdminDetailRecord,
  type EntitlementAdminPort,
  type EntitlementAdminRecord,
  type OperationsMetricsPort,
  type OperationsThresholds,
} from '@sengoku/domain';
import type { Actor } from '@sengoku/auth';

import type { WalletAutoDeliveryService } from '../claim/auto-delivery.service';
import { DomainErrorException } from '../common/domain-error.filter';
import type { EntitlementIssuanceService } from '../order/issuance.service';
import type { AuditLogPort } from '@sengoku/domain';

/**
 * 運営が朝いちばんに見る画面（実運営 指示書 P0-6）。
 *
 * ⚠️ **数え上げと判定を分けてある。** リポジトリは数えるだけ、色を
 * 決めるのはドメイン。しきい値を変えるのに SQL を触らずに済む。
 *
 * ⚠️ **やり直しの口は「見る」と分けてある。** どちらも同じ画面から
 * 押すが、外部へ実際に送る操作なので、権限を分けている。
 */
@Injectable()
export class OperationsDashboardService {
  constructor(
    private readonly operations: OperationsMetricsPort,
    private readonly entitlements: EntitlementAdminPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    private readonly thresholds: OperationsThresholds,
    /** 見る対象の時計仕掛け。⚠️ 記録が無くても項目は出す。 */
    private readonly jobKeys: readonly string[],
    /**
     * 人が意図して止めている時計仕掛け（2026-08-22）。
     *
     * ⚠️ **一覧から外さない。** 外すと画面から項目ごと消え、
     * 「止めている」ではなく「そんな処理は無い」に見える。
     * 出したうえで灰色にする。
     */
    private readonly pausedJobKeys: readonly string[] = [],
    /**
     * 発行のやり直し。
     *
     * ⚠️ **`null` は「この配備では押せない」を意味する。** 口は生やし、
     * 押されたら断る。口ごと消すと、画面が配備ごとに変わる。
     */
    private readonly issuance: EntitlementIssuanceService | null = null,
    private readonly autoDelivery: WalletAutoDeliveryService | null = null,
    /**
     * 争いの一覧（2026-08-22）。
     *
     * ⚠️ **`null` は「この配備では争いを受けていない」。** 口は生やし、
     * 空の一覧を返す。口ごと消すと、画面が配備ごとに変わる。
     */
    private readonly disputes: DisputePort | null = null,
  ) {}

  async dashboard(): Promise<OperationsDashboardResponse> {
    const now = this.clock.now();
    const [counts, jobs] = await Promise.all([
      this.operations.counts(now, disputeDueSoonBefore(now, this.thresholds)),
      this.operations.heartbeats(this.jobKeys),
    ]);

    const indicators = buildIndicators({
      counts,
      jobs,
      pausedJobKeys: this.pausedJobKeys,
      thresholds: this.thresholds,
      now,
    });

    return {
      overall: overallSeverity(indicators),
      indicators: indicators.map((row) => ({
        key: row.key,
        label: row.label,
        count: row.count,
        severity: row.severity,
        action: row.action,
      })),
      lastWebhookReceivedAt: counts.lastWebhookReceivedAt?.toISOString() ?? null,
      generatedAt: now.toISOString(),
    };
  }

  async consistency(): Promise<ConsistencyResponse> {
    const now = this.clock.now();
    const counts = await this.operations.consistency();
    const findings = buildConsistencyFindings(counts);
    return {
      overall: overallSeverity(findings),
      findings: findings.map((row) => ({
        key: row.key,
        label: row.label,
        count: row.count,
        sampleIds: [...row.sampleIds],
        severity: row.severity,
        action: row.action,
      })),
      generatedAt: now.toISOString(),
    };
  }

  /**
   * カード会社との争いの一覧（2026-08-22）。
   *
   * ⚠️ **読むだけ。** 状態を進める口はここに作らない。証拠の提出も取り下げも
   * 決済事業者の画面で行う。こちらに口を作ると、**事業者の記録とこちらの
   * 記録が食い違う**——正はあちらにある。
   */
  async listDisputes(query: DisputeAdminQuery): Promise<DisputeAdminListResponse> {
    const now = this.clock.now();
    const dueSoonDays = this.thresholds.disputeDueSoonDays;
    if (this.disputes === null) {
      // ⚠️ 空で返す。「無い」と「繋いでいない」を画面で区別する必要はない。
      return { items: [], hasMore: false, dueSoonDays };
    }
    const page = await this.disputes.list({ state: query.state, limit: query.limit });
    const dueSoonBefore = new Date(now.getTime() + dueSoonDays * 24 * 60 * 60 * 1000);
    return {
      items: page.items.map((row) => toDisputeView(row, now, dueSoonBefore)),
      hasMore: page.hasMore,
      dueSoonDays,
    };
  }

  async listEntitlements(query: EntitlementAdminQuery): Promise<EntitlementAdminListResponse> {
    const page = await this.entitlements.list(query);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async findEntitlement(id: string): Promise<EntitlementAdminDetailView> {
    const found = await this.entitlements.findById(id);
    if (found === null) {
      throw new NotFoundException();
    }
    return toDetailView(found);
  }

  /**
   * 発行をやり直す。
   *
   * ⚠️ **何度押しても増えない。** 足りない枚数だけを作る形で、
   * `UNIQUE(order_line_id, unit_index)` が最終防壁になっている。
   *
   * ⚠️ **押した人を記録する。** お金を受け取った注文に対して、
   * 外部にも影響しうる処理を人が起こす操作である。
   */
  async retryIssuance(actor: Actor, orderId: string): Promise<RetryIssuanceResponse> {
    if (this.issuance === null) {
      throw new DomainErrorException('ISSUANCE_UNAVAILABLE');
    }
    const result = await this.issuance.runForOrder(orderId);
    await this.audit.record({
      actorAccountId: actor.accountId,
      action: 'operations.retry_issuance',
      targetType: 'order',
      targetId: orderId,
      summary: { issuedCount: result?.entitlementIds.length ?? 0 },
    });
    return {
      issuedCount: result?.entitlementIds.length ?? 0,
      // ⚠️ 「何も起きなかった」を成功として黙らせない。
      alreadyComplete: result === null || result.entitlementIds.length === 0,
    };
  }

  /**
   * その方ぶんを、まとめて送り直す。
   *
   * ⚠️ **「受け取り済みで未配送」だけを拾う。** 未受取の分はウォレットの
   * 登録がまだで、送る先が無い。まとめて送ろうとすると毎回そこで失敗する。
   */
  async redeliverForAccount(actor: Actor, accountId: string): Promise<RedeliverResponse> {
    if (this.autoDelivery === null) {
      throw new DomainErrorException('WALLET_DELIVERY_UNAVAILABLE');
    }
    const ids = await this.entitlements.listUndeliveredForAccount(accountId, REDELIVER_LIMIT);
    if (ids.length === 0) {
      return { pickedCount: 0, deliveredCount: 0, skippedCount: 0, failedCount: 0 };
    }
    const result = await this.autoDelivery.runForEntitlements(ids);
    await this.audit.record({
      actorAccountId: actor.accountId,
      action: 'operations.redeliver',
      targetType: 'account',
      targetId: accountId,
      // ⚠️ 受取権の識別子を並べない。件数まで。
      summary: {
        pickedCount: ids.length,
        deliveredCount: result.delivered,
        failedCount: result.failed,
      },
    });
    return {
      pickedCount: ids.length,
      deliveredCount: result.delivered,
      skippedCount: result.skipped,
      failedCount: result.failed,
    };
  }
}

/**
 * 1 回の再配送で拾う上限。
 *
 * ⚠️ **無制限にしない。** 何百枚も持っている方のボタンを押した運営が、
 * 応答を何分も待つことになる。残りは次に押せばよい。
 */
const REDELIVER_LIMIT = 50;

function toView(row: EntitlementAdminRecord): EntitlementAdminListResponse['items'][number] {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    artworkId: row.artworkId,
    artworkTitle: row.artworkTitle,
    serialNo: row.serialNo,
    status: row.status,
    walletDeliveryStatus: row.walletDeliveryStatus,
    claimedByCommonUserId: row.claimedByCommonUserId,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    walletDeliveredAt: row.walletDeliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetailView(row: EntitlementAdminDetailRecord): EntitlementAdminDetailView {
  return {
    ...toView(row),
    orderLineId: row.orderLineId,
    accountId: row.accountId,
    deliveries: row.deliveries.map((delivery) => ({
      id: delivery.id,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastErrorCode: delivery.lastErrorCode,
      deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
      createdAt: delivery.createdAt.toISOString(),
    })),
  };
}

/**
 * 「期限が近い」の境目。
 *
 * ⚠️ **設定から引く。** 定数にすると、変えるたびにデプロイが要る。
 */
function disputeDueSoonBefore(now: Date, thresholds: OperationsThresholds): Date {
  return new Date(now.getTime() + thresholds.disputeDueSoonDays * 86_400_000);
}

/**
 * 争いを画面の形へ写す。
 *
 * ⚠️ **買った方の情報は写さない**（`UD-503`）。写す元にも項目が無い。
 * ⚠️ **返金は「あるか」だけ。** 中身は注文の画面で見る。ここに額を出すと、
 * 争われている額・注文の総額・返した額が並び、どれが何か分からなくなる。
 */
function toDisputeView(row: DisputeListItem, now: Date, dueSoonBefore: Date): DisputeAdminView {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    artworkTitleSnapshot: row.artworkTitleSnapshot,
    provider: row.provider,
    disputeRef: row.disputeRef,
    status: row.status,
    reason: row.reason,
    urgency: disputeUrgency(row, now, dueSoonBefore),
    amount: row.amount,
    orderTotalAmount: row.orderTotalAmount,
    currency: row.currency,
    openedAt: row.openedAt.toISOString(),
    evidenceDueAt: row.evidenceDueAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    hasRefund: row.refundId !== null,
  };
}
