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
 * ⚠️ **「管理 UI は作らない」という当初の判断は取り下げた（2026-08-18）。**
 * 管理画面（`/admin/wallet-deliveries`）から同じ操作ができる。
 * 取り下げた理由は次のとおり:
 *  - 押せるのは `wallet_delivery.retry` を持つ運営だけで、「誰でも」ではない
 *  - 戻せるのは `FAILED` / `DEAD` だけ。`PROCESSING` は画面にもボタンを出さない
 *  - `event_id` と本文を作り直さないので、相手から見れば同じイベントの再送
 *  - 誰がいつ押したかは監査ログに残る（戻せなかったときも残す）
 * 逆に、この CLI しか無い状態のほうが危うかった。復旧のたびに
 * DB へ届く経路を持つ人が必要になり、権限を絞る意味が薄れる。
 *
 * この CLI は残す。管理画面が開けないとき（配備の事故・認証の不調）の
 * 逃げ道として要る。
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
