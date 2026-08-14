import { loadEnv, workerEnvSchema } from '@sengoku/config';
import {
  createPrismaClient,
  PrismaWalletDeliveryOutboxRepository,
  type PrismaClient,
} from '@sengoku/database';
import { SystemClock } from '@sengoku/integrations';

/**
 * 配送の手動再送（PR-NW04 §20）。
 *
 * ```
 * pnpm wallet:resend --event-id=evt_xxxxx
 * ```
 *
 * 管理 UI は作らない。押し間違いで二重配送が起きうる操作を、
 * 誰でも押せる場所に置かない。
 *
 * ⚠️ **`event_id` と `payload` は変えない。**
 * 作り直すと相手の冪等キーが変わり、同じ受取権の Holding が 2 つできる。
 *
 * ⚠️ **戻せるのは `FAILED` / `DEAD` だけ。**
 * `PROCESSING` の行は送信中か、送信直後に落ちた可能性がある。
 * 届いたかどうかが分からない状態で押し直すと、
 * 相手の冪等性だけが最後の砦になる。
 */
async function main(): Promise<void> {
  const env = loadEnv(workerEnvSchema);

  const match = /^--event-id=(.+)$/.exec(
    process.argv.slice(2).find((arg) => arg.startsWith('--event-id=')) ?? '',
  );
  const eventId = match?.[1];
  if (eventId === undefined) {
    process.stderr.write('usage: --event-id=<event id>\n');
    process.exit(1);
    return;
  }

  const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;
  try {
    const outbox = new PrismaWalletDeliveryOutboxRepository(prisma);
    const row = await outbox.findByEventId(eventId);
    if (row === null) {
      process.stderr.write('not_found\n');
      process.exit(1);
      return;
    }
    const requeued = await outbox.requeue({ id: row.id, now: new SystemClock().now() });
    if (!requeued) {
      // どの状態なら戻せるのかを伝える。理由が分からないと運用が詰まる。
      process.stderr.write(`not_resendable status=${row.status} (FAILED / DEAD のみ)\n`);
      process.exit(1);
      return;
    }
    process.stdout.write(`requeued event_id=${eventId}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
