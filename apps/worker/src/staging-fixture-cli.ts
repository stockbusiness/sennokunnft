import {
  assertStagingFixtureAllowed,
  loadEnv,
  UnsafeEnvironmentError,
  workerEnvSchema,
} from '@sengoku/config';
import { createPrismaClient, type PrismaClient } from '@sengoku/database';
import { Sha256ClaimTokenService, SystemClock } from '@sengoku/integrations';
import {
  createStagingEntitlement,
  StagingFixtureError,
  type StagingFixtureInput,
} from './staging-fixture';

/**
 * staging 動作確認用の受取権を作る CLI（PR-NW04 §8・§9）。
 *
 * ```
 * pnpm staging:create-test-entitlement --account-id=<uuid> --artwork-id=<uuid>
 * ```
 *
 * ⚠️ **本番では絶対に動かさない。**
 * `NODE_ENV != production` と `ENABLE_STAGING_FIXTURES = true` の
 * **両方**を満たしたときにだけ実行できる。片方だけでは通らない。
 * フラグ 1 本にすると、本番の環境変数へ 1 行足しただけで
 * 本番DBに偽の受取権が作れてしまう。
 */

function parseArgs(argv: readonly string[]): StagingFixtureInput {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    }
  }
  const accountId = values.get('account-id');
  const artworkId = values.get('artwork-id');
  if (accountId === undefined || artworkId === undefined) {
    throw new StagingFixtureError('usage: --account-id=<uuid> --artwork-id=<uuid>');
  }
  return { accountId, artworkId };
}

async function main(): Promise<void> {
  const env = loadEnv(workerEnvSchema);

  try {
    // ⚠️ ここで落ちたら**何もせずに終わる**。DB へは触れていない。
    assertStagingFixtureAllowed(env);
  } catch (error) {
    if (error instanceof UnsafeEnvironmentError) {
      for (const reason of error.reasons) {
        process.stderr.write(`${reason}\n`);
      }
      process.exit(1);
    }
    throw error;
  }

  let input: StagingFixtureInput;
  try {
    input = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'invalid arguments'}\n`);
    process.exit(1);
    return;
  }

  const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;
  try {
    const result = await createStagingEntitlement(
      {
        prisma,
        tokens: new Sha256ClaimTokenService(),
        clock: new SystemClock(),
        claimBaseUrl: env.CLAIM_BASE_URL.replace(/\/+$/, ''),
      },
      input,
    );
    // ⚠️ 出力は標準出力へ。ログ基盤へは流さない。
    //    Claim URL には平文のトークンが含まれる。
    process.stdout.write(
      [
        `order_id=${result.orderId}`,
        `order_line_id=${result.orderLineId}`,
        `entitlement_id=${result.entitlementId}`,
        `serial_number=${String(result.serialNumber)}`,
        `claim_url=${result.claimUrl}`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    if (error instanceof StagingFixtureError) {
      process.stderr.write(`${error.reason}\n`);
      process.exit(1);
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
