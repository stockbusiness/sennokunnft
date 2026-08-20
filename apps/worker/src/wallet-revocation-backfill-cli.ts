import { loadEnv, workerEnvSchema } from '@sengoku/config';
import {
  createPrismaClient,
  PrismaOperationsReviewRepository,
  PrismaRevocationReconcileRepository,
  PrismaWalletDeliveryOutboxRepository,
  type PrismaClient,
} from '@sengoku/database';
import { SystemClock, contentHash } from '@sengoku/integrations';
import {
  TARGET_SITE_KEY,
  buildRevokedEvent,
  decideRevocation,
  type RevocationPlan,
  type RevocationPlanInput,
} from '@sengoku/domain';

/**
 * 取消の知らせの取りこぼしを埋める（M3a）。
 *
 * ```
 * pnpm wallet:revocation-backfill                    # 数えるだけ（既定）
 * pnpm wallet:revocation-backfill --execute          # 実際に積む
 * pnpm wallet:revocation-backfill --execute --limit=100
 * ```
 *
 * ⚠️ **既定は数えるだけ。** `--execute` が無ければ 1 行も書かない。
 * 「実行したつもりが空振り」より、「数えたつもりが書き込んでいた」ほうが
 * ずっと厄介である。
 *
 * ⚠️ **生成フラグに従う。迂回しない。**
 * `WALLET_REVOCATION_EVENT_GENERATION_ENABLED` が無効なら、`--execute` を
 * 付けても書かない。「止めたはずのものが別の入口から動く」状態を作らない。
 * 取りこぼしを埋めたいときは、先に生成フラグを有効にする。
 *
 * ⚠️ **送信はしない。** 積むだけで、送るのは配送ワーカーの仕事であり、
 * 配送フラグに従う。
 *
 * ⚠️ **対象IDを出しすぎない。** 先頭 20 件まで。残りは件数だけ。
 * ⚠️ **個人情報を出さない。** 共通顧客IDも出さない。
 */

/** 一覧に出す識別子の上限。⚠️ 全件を流すと、ログが本来の異変を埋める。 */
const MAX_LISTED_IDS = 20;

const DEFAULT_LIMIT = 200;

async function main(): Promise<void> {
  const env = loadEnv(workerEnvSchema);
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const limit = parseLimit(args) ?? DEFAULT_LIMIT;

  if (execute && !env.WALLET_REVOCATION_EVENT_GENERATION_ENABLED) {
    process.stderr.write(
      'generation_disabled: WALLET_REVOCATION_EVENT_GENERATION_ENABLED が無効です。\n' +
        '取りこぼしを埋める前に、生成フラグを有効にしてください。\n',
    );
    process.exit(1);
    return;
  }

  const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;
  try {
    const reader = new PrismaRevocationReconcileRepository(prisma);
    const missing = await reader.listMissing(limit);

    process.stdout.write(`対象: ${String(missing.length)} 件\n`);
    for (const row of missing.slice(0, MAX_LISTED_IDS)) {
      // ⚠️ 受取権IDと注文IDまで。共通顧客IDも本文も出さない。
      process.stdout.write(`  entitlement=${row.entitlementId} order=${row.orderId}\n`);
    }
    if (missing.length > MAX_LISTED_IDS) {
      process.stdout.write(`  … ほか ${String(missing.length - MAX_LISTED_IDS)} 件\n`);
    }
    if (missing.length === limit) {
      // ⚠️ 黙って切らない。出さないと「全部埋まった」と読まれる。
      process.stdout.write(
        `⚠️ 上限（${String(limit)}）に達しました。残りがある可能性があります。\n`,
      );
    }

    if (!execute) {
      process.stdout.write('dry-run: 何も書き込んでいません（--execute で実行）\n');
      return;
    }

    const now = new SystemClock().now();
    const outbox = new PrismaWalletDeliveryOutboxRepository(prisma);
    const reviews = new PrismaOperationsReviewRepository(prisma);
    let created = 0;
    let duplicate = 0;
    let skipped = 0;
    let conflicts = 0;

    for (const row of missing) {
      const decision = decideRevocation({
        entitlementId: row.entitlementId,
        orderId: row.orderId,
        hasGrantedEvent: true,
        grantedCommonUserId: row.grantedCommonUserId,
        claimedCommonUserId: row.claimedCommonUserId,
        grantedCorrelationId: row.grantedCorrelationId,
      });
      if (decision.kind !== 'revoke_and_notify') {
        skipped += 1;
        if (decision.kind === 'needs_review') {
          await reviews.open({
            subjectType: 'entitlement',
            subjectId: row.entitlementId,
            orderId: row.orderId,
            reasonCode: 'wallet_revocation_recipient_unresolved',
            detail:
              '付与は送っているが宛先の共通顧客IDを特定できないため、取消を送っていません（補完CLIで検出）。',
            now,
          });
        }
        continue;
      }

      // ⚠️ 付与を止めるのが先。逆順にすると、積んだあとに落ちた行が
      //    次回の対象から外れ、付与だけが送られ続ける。
      await outbox.supersedePendingGranted({ entitlementId: row.entitlementId, now });

      const built = planRevocation({
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

      const outcome = await outbox.enqueueIdempotent({
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
        await reviews.open({
          subjectType: 'entitlement',
          subjectId: row.entitlementId,
          orderId: row.orderId,
          reasonCode: 'wallet_revocation_payload_conflict',
          detail: `補完CLIで、同じイベントID（${outcome.eventId}）の本文が食い違いました（期待 ${outcome.expectedPayloadHash} / 実際 ${outcome.actualPayloadHash}）。`,
          now,
        });
      }
    }

    process.stdout.write(
      `生成: ${String(created)} / 既存: ${String(duplicate)} / 見送り: ${String(skipped)} / 食い違い: ${String(conflicts)}\n`,
    );
    process.stdout.write('※ 送信は配送ワーカーが行います（配送フラグに従います）。\n');
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 取消の本文を組み立てる。
 *
 * ⚠️ **API 側（`WalletRevokePlanner`）と同じ組み立て方にする。** 別々に
 * 書くと、同じ受取権でも経路によって本文が変わり、**正常な重複が
 * 「本文の食い違い」として検知される**。
 */
function planRevocation(input: RevocationPlanInput): RevocationPlan {
  const event = buildRevokedEvent({
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    commonUserId: input.commonUserId,
    entitlementId: input.entitlementId,
    orderId: input.orderId,
    orderLineId: input.orderLineId,
    artworkId: input.artworkId,
    reasonCode: 'full_refund',
  });
  if (!event.ok) {
    throw new Error(`取消の本文を組み立てられませんでした: ${event.error.code}`);
  }
  const payload = JSON.stringify(event.value);
  return {
    eventId: event.value.event_id,
    payload,
    payloadHash: contentHash(payload),
    correlationId: input.correlationId,
  };
}

function parseLimit(args: readonly string[]): number | null {
  const raw = args.find((arg) => arg.startsWith('--limit='));
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw.slice('--limit='.length), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

main().catch((error: unknown) => {
  // ⚠️ 例外の中身をそのまま出さない。接続文字列が混ざりうる。
  process.stderr.write(`failed: ${error instanceof Error ? error.name : 'unknown'}\n`);
  process.exit(1);
});
