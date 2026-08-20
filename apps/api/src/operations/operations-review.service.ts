import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  OperationsReviewListResponse,
  OperationsReviewView,
  ResolveOperationsReviewRequest,
} from '@sengoku/contracts';
import {
  OPERATIONS_REVIEW_MAX_PAGE_SIZE,
  OPERATIONS_REVIEW_PAGE_SIZE,
  OPERATIONS_REVIEW_REASON_CODES,
  OPERATIONS_REVIEW_STATUSES,
  decodeListCursor,
  encodeListCursor,
  type AuditLogPort,
  type ClockPort,
  type OperationsReviewReasonCode,
  type OperationsReviewRecord,
  type OperationsReviewRepository,
  type OperationsReviewStatus,
} from '@sengoku/domain';
import type { Actor } from '@sengoku/auth';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 運用確認キューの読み書き（M3a）。
 *
 * ⚠️ **ここに「積む」口は無い。** 積むのは業務処理の側で、しかも
 * 業務の更新と同じトランザクションで行う。管理画面から手で足せると、
 * 「本当に起きた確認事項」と「誰かが作った行」が混ざる。
 */
@Injectable()
export class OperationsReviewService {
  constructor(
    private readonly reviews: OperationsReviewRepository,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
  ) {}

  async list(query: {
    readonly status?: readonly string[] | undefined;
    readonly reasonCode?: readonly string[] | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<OperationsReviewListResponse> {
    const page = await this.reviews.list({
      statuses: parseStatuses(query.status),
      reasonCodes: parseReasonCodes(query.reasonCode),
      cursor: query.cursor === undefined ? null : decodeListCursor(query.cursor),
      limit: clampLimit(query.limit),
    });
    // ⚠️ 絞り込みの影響を受けない全体の件数。「0 件だから何も無い」を防ぐ。
    const openCounts = await this.reviews.countOpen();
    return {
      items: page.items.map(toView),
      nextCursor: page.nextCursor === null ? null : encodeListCursor(page.nextCursor),
      openCounts,
    };
  }

  async resolve(
    actor: Actor,
    id: string,
    body: ResolveOperationsReviewRequest,
  ): Promise<{ readonly resolved: boolean }> {
    const actorAccountId = actor.accountId;
    if (actorAccountId === null) {
      /*
        認可ガードを通っている以上ここへは来ない。
        ⚠️ **それでも `!` で潰さない。** 「誰が対応したか」が残らない印を
           付けられる状態を、型の上でも作らない。
      */
      throw new ForbiddenException();
    }
    const now = this.clock.now();
    const resolved = await this.reviews.resolve({
      id,
      actorAccountId,
      note: body.note,
      now,
    });
    if (!resolved) {
      // すでに対応済み。⚠️ 「誰が対応したか」を後から書き換えさせない。
      throw new DomainErrorException('OPERATIONS_REVIEW_NOT_OPEN');
    }
    await this.audit.record({
      actorAccountId,
      action: 'operations_review.resolved',
      targetType: 'operations_review',
      targetId: id,
      // ⚠️ 対応の記録そのものは載せない。行に残っている。
      summary: { reviewId: id },
    });
    return { resolved: true };
  }
}

function toView(record: OperationsReviewRecord): OperationsReviewView {
  return {
    id: record.id,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    orderId: record.orderId,
    reasonCode: record.reasonCode,
    detail: record.detail,
    status: record.status,
    resolvedByAccountId: record.resolvedByAccountId,
    resolvedAt: record.resolvedAt === null ? null : record.resolvedAt.toISOString(),
    resolutionNote: record.resolutionNote,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * 絞り込みを読む。
 *
 * ⚠️ **知らない値は黙って捨てる。** 弾いて 400 にすると、画面が古い値を
 * 送っただけで一覧そのものが開けなくなる。捨てれば絞り込みが効かないだけ。
 */
function parseStatuses(raw: readonly string[] | undefined): readonly OperationsReviewStatus[] {
  if (raw === undefined) {
    return [];
  }
  return raw.filter((value): value is OperationsReviewStatus =>
    OPERATIONS_REVIEW_STATUSES.includes(value as OperationsReviewStatus),
  );
}

function parseReasonCodes(
  raw: readonly string[] | undefined,
): readonly OperationsReviewReasonCode[] {
  if (raw === undefined) {
    return [];
  }
  return raw.filter((value): value is OperationsReviewReasonCode =>
    OPERATIONS_REVIEW_REASON_CODES.includes(value as OperationsReviewReasonCode),
  );
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isSafeInteger(raw) || raw < 1) {
    return OPERATIONS_REVIEW_PAGE_SIZE;
  }
  return Math.min(raw, OPERATIONS_REVIEW_MAX_PAGE_SIZE);
}
