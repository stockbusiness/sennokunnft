import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ResendWalletDeliveriesRequest,
  ResendWalletDeliveriesResponse,
  WalletDeliveryListResponse,
  WalletDeliveryView,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  WALLET_DELIVERY_MAX_PAGE_SIZE,
  WALLET_DELIVERY_PAGE_SIZE,
  canManuallyResend,
  decodeListCursor,
  encodeListCursor,
  type AuditLogPort,
  type ClockPort,
  type WalletDeliveryAdminPort,
  type WalletDeliveryAdminRecord,
  type WalletDeliveryOutboxPort,
  type WalletDeliveryOutboxStatus,
  type WalletDeliveryResendResult,
} from '@sengoku/domain';

/**
 * 送信の運用（管理画面・外部連携 指示書 §5・§20）。
 *
 * ⚠️ **本文をこの層から出さない。** 読む口（`WalletDeliveryAdminPort`）が
 * そもそも本文を返さないので、ここで気をつける必要は無い——という状態を
 * 保つこと。「調査のために本文も欲しい」と言われても、別の口を生やさない。
 *
 * ⚠️ **`event_id` と本文を作り直さない。** 再送は行の状態を戻すだけ。
 * 作り直すと相手の冪等キーが変わり、同じ受取権の Holding が 2 つできる。
 */
@Injectable()
export class WalletDeliveryAdminService {
  constructor(
    private readonly deliveries: WalletDeliveryAdminPort,
    private readonly outbox: Pick<WalletDeliveryOutboxPort, 'requeue'>,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
  ) {}

  async list(query: {
    readonly statuses?: readonly string[];
    readonly eventId?: string;
    readonly entitlementId?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<WalletDeliveryListResponse> {
    const limit = clampLimit(query.limit);
    const [page, counts] = await Promise.all([
      this.deliveries.list({
        statuses: parseStatuses(query.statuses),
        eventId: emptyToNull(query.eventId),
        entitlementId: emptyToNull(query.entitlementId),
        cursor: query.cursor === undefined ? null : decodeListCursor(query.cursor),
        limit,
      }),
      // ⚠️ 絞り込みと無関係な全体の件数。ここで絞ると「失敗 0 件」の嘘が出る。
      this.deliveries.countByStatus(),
    ]);

    return {
      items: page.items.map(toView),
      counts,
      nextCursor: page.nextCursor === null ? null : encodeListCursor(page.nextCursor),
    };
  }

  async detail(id: string): Promise<WalletDeliveryView> {
    const record = await this.deliveries.findById(id);
    if (record === null) {
      throw new NotFoundException();
    }
    return toView(record);
  }

  /**
   * 手で送り直す。
   *
   * ⚠️ **1 件ずつの結果を返す。** まとめて「成功しました」と返すと、
   * 戻せなかった行があっても押した人には分からない。運用画面で
   * いちばん困るのは「押したのに何も起きていないことに気づけない」こと。
   *
   * ⚠️ **戻せなかったものも監査ログへ残す。** 押した事実は残す価値がある。
   * 「誰も触っていないはずなのに状態が変わった」を調べるときに要る。
   */
  async resend(
    actor: Actor,
    request: ResendWalletDeliveriesRequest,
  ): Promise<ResendWalletDeliveriesResponse> {
    const now = this.clock.now();
    const results: WalletDeliveryResendResult[] = [];

    for (const id of dedupe(request.ids)) {
      const record = await this.deliveries.findById(id);
      if (record === null) {
        results.push({ id, outcome: 'not_found' });
        continue;
      }
      /*
        ⚠️ **ここの判定を最終判断にしない。** 読んでから書くまでのあいだに
           ワーカーが同じ行を掴みうる。実際に戻せたかどうかは、状態を
           条件に含めた UPDATE（`requeue`）の結果だけが知っている。
      */
      const requeued = await this.outbox.requeue({ id, now });
      results.push({ id, outcome: requeued ? 'requeued' : 'not_resendable' });

      await this.audit.record({
        actorAccountId: actor.accountId,
        action: 'wallet_delivery.resend',
        targetType: 'wallet_delivery_outbox',
        targetId: id,
        // ⚠️ 本文もハッシュも入れない。何をしたかが分かればよい。
        summary: {
          eventId: record.eventId,
          statusBefore: record.status,
          requeued,
        },
      });
    }

    return { results };
  }
}

function toView(record: WalletDeliveryAdminRecord): WalletDeliveryView {
  return {
    id: record.id,
    eventId: record.eventId,
    eventType: record.eventType,
    entitlementId: record.entitlementId,
    targetSiteKey: record.targetSiteKey,
    payloadHash: record.payloadHash,
    status: record.status,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    nextRetryAt: record.nextRetryAt.toISOString(),
    lastErrorCode: record.lastErrorCode,
    lastErrorMessage: record.lastErrorMessage,
    correlationId: record.correlationId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deliveredAt: record.deliveredAt === null ? null : record.deliveredAt.toISOString(),
    canResend: canManuallyResend(record.status),
  };
}

const KNOWN_STATUSES: readonly WalletDeliveryOutboxStatus[] = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'DEAD',
];

/**
 * 状態の絞り込みを読む。
 *
 * ⚠️ **知らない値は黙って捨てる。** 弾いて 400 にすると、画面が
 * 古い状態名を送っただけで一覧そのものが開けなくなる。捨てれば、
 * 絞り込みが効かないだけで済む。
 */
function parseStatuses(raw: readonly string[] | undefined): readonly WalletDeliveryOutboxStatus[] {
  if (raw === undefined) {
    return [];
  }
  return raw.filter((value): value is WalletDeliveryOutboxStatus =>
    KNOWN_STATUSES.includes(value as WalletDeliveryOutboxStatus),
  );
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isSafeInteger(raw) || raw < 1) {
    return WALLET_DELIVERY_PAGE_SIZE;
  }
  return Math.min(raw, WALLET_DELIVERY_MAX_PAGE_SIZE);
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** 同じ行を 2 回押されても、監査ログに 2 行残らないようにする。 */
function dedupe(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}
