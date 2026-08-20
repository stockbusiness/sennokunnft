import { Injectable } from '@nestjs/common';
import {
  TARGET_SITE_KEY,
  decideRevocation,
  type AuditLogPort,
  type ClockPort,
  type OperationsReviewRepository,
  type RevocationPlanner,
  type RevocationReconcileRepository,
  type WalletDeliveryOutboxPort,
} from '@sengoku/domain';
import type { Logger } from '@sengoku/observability';

/**
 * 取消の知らせの取りこぼしを埋める（M3a）。
 *
 * ⚠️ **これは主たる経路ではない。** ふだんは返金と同じトランザクションで
 * 取消の知らせを積む。ここが拾うのは、生成フラグが無効だったあいだに
 * 取り消された分と、何かの拍子に積めなかった分だけ。
 *
 * ⚠️ **生成フラグに従う。** 従わせないと、フラグを無効へ戻したのに
 * 日次の時計が作り続ける。「止めたはずのものが別の入口から動く」状態を
 * 作らない。
 *
 * ⚠️ **何度実行しても増えない。** イベントIDが受取権IDから決まり、
 * 追加は `ON CONFLICT DO NOTHING` を通る。
 */

/** 1 巡ぶんの結果。⚠️ 個人情報を含めない（監視の数値として読まれる）。 */
export interface RevocationReconcileResult {
  /** 対象として拾った件数。 */
  readonly picked: number;
  /** 新しく積んだ件数。 */
  readonly created: number;
  /** すでに同じ本文があった件数（冪等成功）。 */
  readonly duplicate: number;
  /** 宛先が決まらず、運用確認へ回した件数。 */
  readonly needsReview: number;
  /** 本文が食い違った件数。 */
  readonly conflicts: number;
  /** 送らないことにした付与イベントの件数。 */
  readonly superseded: number;
  /**
   * 上限に達して見送った可能性があるか。
   *
   * ⚠️ **黙って切らない。** 上限で打ち切ったことを外へ出さないと、
   * 「全部埋まった」と読み違える。
   */
  readonly truncated: boolean;
}

const EMPTY: RevocationReconcileResult = {
  picked: 0,
  created: 0,
  duplicate: 0,
  needsReview: 0,
  conflicts: 0,
  superseded: 0,
  truncated: false,
};

/** 1 巡で埋める件数の上限。相手の復旧直後に全件を叩きつけない。 */
export const REVOCATION_RECONCILE_BATCH_SIZE = 50;

@Injectable()
export class RevocationReconcileService {
  constructor(
    private readonly reader: RevocationReconcileRepository,
    private readonly outbox: WalletDeliveryOutboxPort,
    private readonly reviews: OperationsReviewRepository,
    private readonly planRevocation: RevocationPlanner,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    private readonly logger: Logger,
  ) {}

  /**
   * 取りこぼしを埋める。
   *
   * @param dryRun 真なら**1 行も書かない**。件数だけ数える。
   */
  async run(
    limit: number = REVOCATION_RECONCILE_BATCH_SIZE,
    dryRun = false,
  ): Promise<RevocationReconcileResult> {
    const missing = await this.reader.listMissing(limit);
    if (missing.length === 0) {
      return EMPTY;
    }

    const truncated = missing.length === limit;
    if (dryRun) {
      // ⚠️ 件数だけ返す。読むだけの経路で書き込みへ入らないよう、ここで戻す。
      return { ...EMPTY, picked: missing.length, truncated };
    }

    const now = this.clock.now();
    let created = 0;
    let duplicate = 0;
    let needsReview = 0;
    let conflicts = 0;
    let superseded = 0;

    for (const row of missing) {
      const decision = decideRevocation({
        entitlementId: row.entitlementId,
        orderId: row.orderId,
        // 付与の行がある行だけを読み出しているので、ここは常に真。
        hasGrantedEvent: true,
        grantedCommonUserId: row.grantedCommonUserId,
        claimedCommonUserId: row.claimedCommonUserId,
        grantedCorrelationId: row.grantedCorrelationId,
      });

      if (decision.kind === 'revoke_only') {
        continue;
      }

      if (decision.kind === 'needs_review') {
        needsReview += 1;
        await this.reviews.open({
          subjectType: 'entitlement',
          subjectId: row.entitlementId,
          orderId: row.orderId,
          reasonCode: 'wallet_revocation_recipient_unresolved',
          detail:
            '付与は送っているが宛先の共通顧客IDを特定できないため、取消を送っていません（補完処理で検出）。',
          now,
        });
        continue;
      }

      /*
        ⚠️ **付与を止めるのが先。** 逆順にすると、取消を積んだあとに
           落ちた行は次回の対象から外れ（取消はもうある）、
           付与だけが送られ続ける。順序で自己修復させる。
      */
      superseded += await this.outbox.supersedePendingGranted({
        entitlementId: row.entitlementId,
        now,
      });

      const built = this.planRevocation({
        entitlementId: row.entitlementId,
        orderId: row.orderId,
        orderLineId: row.orderLineId,
        artworkId: row.artworkId,
        eventId: decision.eventId,
        commonUserId: decision.commonUserId,
        correlationId: decision.correlationId,
        // ⚠️ 現在時刻ではなく、返金が成立した時刻。
        occurredAt: row.occurredAt,
      });

      const outcome = await this.outbox.enqueueIdempotent({
        eventId: built.eventId,
        eventType: 'entitlement.revoked',
        entitlementId: row.entitlementId,
        targetSiteKey: TARGET_SITE_KEY,
        payload: built.payload,
        payloadHash: built.payloadHash,
        correlationId: built.correlationId,
        now,
      });

      if (outcome.kind === 'created') {
        created += 1;
      } else if (outcome.kind === 'duplicate') {
        duplicate += 1;
      } else {
        conflicts += 1;
        this.logger.error(
          {
            entitlementId: row.entitlementId,
            eventId: outcome.eventId,
            expectedPayloadHash: outcome.expectedPayloadHash,
            actualPayloadHash: outcome.actualPayloadHash,
          },
          '補完中に、同じイベントIDで本文が食い違いました',
        );
        await this.reviews.open({
          subjectType: 'entitlement',
          subjectId: row.entitlementId,
          orderId: row.orderId,
          reasonCode: 'wallet_revocation_payload_conflict',
          detail: `補完処理で、同じイベントID（${outcome.eventId}）の本文が食い違いました（期待 ${outcome.expectedPayloadHash} / 実際 ${outcome.actualPayloadHash}）。`,
          now,
        });
      }
    }

    if (truncated) {
      // ⚠️ 打ち切ったことを必ず出す。黙って切ると「全部埋まった」と読まれる。
      this.logger.warn(
        { limit, picked: missing.length },
        '上限に達したため、残りは次回に持ち越します',
      );
    }

    await this.audit.record({
      // 時計が叩く口。⚠️ 運営の誰かを紐づけない。
      actorAccountId: null,
      action: 'wallet_delivery.revocation_reconciled',
      targetType: 'wallet_delivery',
      targetId: null,
      // ⚠️ 件数だけ。受取権IDや共通顧客IDは載せない。
      summary: { picked: missing.length, created, duplicate, needsReview, conflicts, truncated },
    });

    return {
      picked: missing.length,
      created,
      duplicate,
      needsReview,
      conflicts,
      superseded,
      truncated,
    };
  }
}
