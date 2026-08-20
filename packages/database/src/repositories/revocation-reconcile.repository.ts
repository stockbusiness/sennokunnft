import type { MissingRevocation, RevocationReconcileRepository } from '@sengoku/domain';
import { Prisma } from '../../generated/client';
import type { PrismaClient } from '../../generated/client';

/**
 * 取消の知らせの取りこぼしを拾う（M3a）。
 *
 * ⚠️ **待ち行列のテーブルを作らない。** 「取り消し済みで、相手が知っていて、
 * まだ取消の知らせが無い」は記録から導ける。別の表に写すと、その表だけが
 * ずれていき、しかもずれたことに誰も気づけない。
 */
export class PrismaRevocationReconcileRepository implements RevocationReconcileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listMissing(limit: number): Promise<readonly MissingRevocation[]> {
    /*
      ⚠️ **付与の知らせがある行だけを対象にする**（`JOIN LATERAL`）。
         相手が知らない受取権の取消を送ると、相手には「知らないIDの取消」が
         届き続ける。未受取のまま取り消された分はここで自然に外れる。

      ⚠️ **`occurred_at` に現在時刻を入れない。** その注文の全額返金が
         成立した時刻を使う。いま埋めているからといって「いま取り消した」
         ことにすると、相手の記録では取消が何日も後にずれる。
    */
    const rows = await this.prisma.$queryRaw<readonly MissingRow[]>(Prisma.sql`
      SELECT e."id"                        AS "entitlement_id",
             e."order_id"                  AS "order_id",
             e."order_line_id"             AS "order_line_id",
             e."artwork_id"                AS "artwork_id",
             e."claimed_by_common_user_id" AS "claimed_by_common_user_id",
             g."payload"                   AS "granted_payload",
             g."correlation_id"            AS "granted_correlation_id",
             COALESCE(r."settled_at", e."updated_at") AS "occurred_at"
        FROM "entitlements" e
        JOIN LATERAL (
          SELECT o."payload", o."correlation_id"
            FROM "wallet_delivery_outbox" o
           WHERE o."entitlement_id" = e."id"
             AND o."event_type" = 'entitlement.granted'
           ORDER BY o."created_at" ASC
           LIMIT 1
        ) g ON TRUE
        LEFT JOIN LATERAL (
          SELECT rf."settled_at"
            FROM "refunds" rf
           WHERE rf."order_id" = e."order_id"
             AND rf."status" = 'succeeded'
             AND rf."settled_at" IS NOT NULL
           ORDER BY rf."settled_at" ASC
           LIMIT 1
        ) r ON TRUE
       WHERE e."status"::text = 'revoked'
         AND NOT EXISTS (
           SELECT 1
             FROM "wallet_delivery_outbox" x
            WHERE x."entitlement_id" = e."id"
              AND x."event_type" = 'entitlement.revoked'
         )
       ORDER BY e."updated_at" ASC
       LIMIT ${limit}
    `);

    return rows.map((row) => ({
      entitlementId: row.entitlement_id,
      orderId: row.order_id,
      orderLineId: row.order_line_id,
      artworkId: row.artwork_id,
      claimedCommonUserId: row.claimed_by_common_user_id,
      // ⚠️ **相手へ実際に伝えた値**を正とする。列を先に見ると、万一
      //    食い違っていた場合に別人の Holding を消しにいく。
      grantedCommonUserId: commonUserIdOf(row.granted_payload),
      grantedCorrelationId: row.granted_correlation_id,
      occurredAt: row.occurred_at,
    }));
  }
}

interface MissingRow {
  readonly entitlement_id: string;
  readonly order_id: string;
  readonly order_line_id: string;
  readonly artwork_id: string;
  readonly claimed_by_common_user_id: string | null;
  readonly granted_payload: string;
  readonly granted_correlation_id: string;
  readonly occurred_at: Date;
}

/**
 * 付与イベントの本文から共通顧客IDを取り出す。
 *
 * ⚠️ **読めなければ `null`。投げない。** 本文が 1 件壊れているせいで
 * 補完そのものが止まると、正常な残りまで埋まらなくなる。
 */
function commonUserIdOf(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = (parsed as { common_user_id?: unknown }).common_user_id;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
