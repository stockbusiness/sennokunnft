import { loadEnv, workerEnvSchema } from '@sengoku/config';
import {
  createPrismaClient,
  PrismaPaymentCredentialRepository,
  type PrismaClient,
} from '@sengoku/database';
import { AeadSecretBox, parseEncryptionKeys, probeStripeAccount } from '@sengoku/integrations';
import { acceptingGeneration, activateGeneration, isErr } from '@sengoku/domain';

/**
 * 決済資格情報の世代を、DB へ直接つないで操作する（`UD-118` §8）。
 *
 * ```
 * pnpm payment:credential -- --list
 * pnpm payment:credential -- --import          # 環境変数の鍵を世代として取り込む
 * pnpm payment:credential -- --activate=<id>
 * ```
 *
 * ⚠️ **これが無いと、鍵を DB へ移した瞬間に「詰む経路」ができる。**
 * ログインが壊れている・オーナーが全員不在、という場面で決済を復旧できない。
 *
 * ⚠️ **実行には配備環境の暗号鍵が要る。** つまり**配備環境を触れる人**に
 * しかできない。管理画面より弱い経路にはなっていない。
 *
 * ⚠️ **監査ログへ「CLI から実行された」ことを残す。** 誰がやったか
 * 分からない変更を残さない。
 *
 * ⚠️ **平時は管理画面を使う。** ここは逃げ道であって、通常の運用経路では
 * ない。CLI が常用されると、権限を絞った意味が薄れる。
 */

interface Options {
  readonly list: boolean;
  readonly import: boolean;
  readonly activateId: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const activate = argv.find((arg) => arg.startsWith('--activate='));
  return {
    list: argv.includes('--list'),
    import: argv.includes('--import'),
    activateId: activate === undefined ? null : activate.slice('--activate='.length),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = loadEnv(workerEnvSchema);

  if (env.INTEGRATION_ENCRYPTION_KEYS === undefined) {
    console.error('✗ INTEGRATION_ENCRYPTION_KEYS が未設定です。');
    process.exit(1);
  }
  const keys = parseEncryptionKeys(env.INTEGRATION_ENCRYPTION_KEYS);
  const version = env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION;
  if (keys[version] === undefined) {
    console.error(
      `✗ INTEGRATION_ENCRYPTION_ACTIVE_VERSION（${version}）に対応する鍵がありません。`,
    );
    process.exit(1);
  }

  const prisma = (await createPrismaClient({ databaseUrl: env.DATABASE_URL })) as PrismaClient;
  const cipher = new AeadSecretBox({ keys, activeKeyVersion: version });
  const repo = new PrismaPaymentCredentialRepository(prisma, cipher);
  const provider = env.PAYMENT_PROVIDER;
  const environment = env.APP_ENV === 'production' ? 'production' : 'staging';

  try {
    if (options.import) {
      await importFromEnvironment(repo, prisma, cipher, { provider, environment, env });
    }
    if (options.activateId !== null) {
      await activate(repo, prisma, options.activateId, { provider, environment });
    }
    if (options.list || (!options.import && options.activateId === null)) {
      await list(repo, provider, environment);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function list(
  repo: PrismaPaymentCredentialRepository,
  provider: string,
  environment: 'staging' | 'production',
): Promise<void> {
  const rows = await repo.list(provider, environment);
  if (rows.length === 0) {
    console.log('（世代がまだありません）');
    return;
  }
  for (const row of rows) {
    // ⚠️ 鍵は出さない。末尾 4 文字も出さない（2026-08-19 決定）。
    console.log(
      [
        `第${String(row.generation)}世代`,
        row.id,
        row.status,
        row.acceptsNewPayments ? '受付中' : '受付なし',
        row.accountRef ?? '（未確認）',
        row.label ?? '',
      ].join('\t'),
    );
  }
}

/**
 * 配備環境の鍵を世代として取り込む（`UD-118` §3.3・§11-2）。
 *
 * ⚠️ **一度限りの移行。** 起動のたびに環境変数から読み直す作りにはしない。
 * 読み直すと、DB と環境変数で違う鍵が使われる二重管理になる。
 * 手数料率で同じ判断をしている（`UD-115`）。
 *
 * ⚠️ **すでに世代があれば何もしない。** 二重に取り込むと、同じ鍵の世代が
 * 2 つできて、どちらが受付なのか分からなくなる。
 */
async function importFromEnvironment(
  repo: PrismaPaymentCredentialRepository,
  prisma: PrismaClient,
  cipher: AeadSecretBox,
  context: {
    provider: string;
    environment: 'staging' | 'production';
    env: {
      STRIPE_SECRET_KEY?: string;
      STRIPE_WEBHOOK_SECRET?: string;
      STRIPE_API_VERSION?: string;
    };
  },
): Promise<void> {
  const existing = await repo.list(context.provider, context.environment);
  if (existing.length > 0) {
    console.log('✓ すでに世代があります。取り込みは行いません。');
    return;
  }

  const secretKey = context.env.STRIPE_SECRET_KEY ?? '';
  const webhookSecret = context.env.STRIPE_WEBHOOK_SECRET ?? '';
  if (secretKey === '' || webhookSecret === '') {
    console.error('✗ 環境変数に鍵がありません（STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET）。');
    process.exit(1);
  }

  const actor = await systemActorId(prisma);
  const scope = { service: 'payment' as const, environment: context.environment };
  const registered = await repo.register({
    provider: context.provider,
    environment: context.environment,
    label: '配備環境から取り込み',
    apiVersion: context.env.STRIPE_API_VERSION ?? null,
    secretKey: cipher.seal(secretKey, scope),
    webhookSecret: cipher.seal(webhookSecret, scope),
    registeredByAccountId: actor,
  });

  console.log(`✓ 第${String(registered.generation)}世代として取り込みました（${registered.id}）。`);
  console.log('  ⚠️ 続けて接続確認と有効化が要ります（--activate）。');
  await audit(prisma, actor, 'payment_credential.imported_via_cli', registered.id, {
    generation: registered.generation,
    environment: context.environment,
  });
}

async function activate(
  repo: PrismaPaymentCredentialRepository,
  prisma: PrismaClient,
  id: string,
  context: { provider: string; environment: 'staging' | 'production' },
): Promise<void> {
  const opened = await repo.open(id);
  if (opened === null) {
    console.error('✗ その世代が見つかりません。');
    process.exit(1);
  }

  // ⚠️ 画面と同じ順序。接続確認を通らずに有効化しない。
  const probe = await probeStripeAccount(opened.secretKey, opened.apiVersion);
  await repo.recordCheck({
    id,
    succeeded: probe.ok,
    accountRef: probe.ok ? probe.accountRef : null,
    checkedAt: new Date(),
  });
  if (!probe.ok) {
    console.error('✗ 接続確認に失敗しました。鍵をご確認ください。');
    process.exit(1);
  }

  const generations = await repo.list(context.provider, context.environment);
  const target = generations.find((row) => row.id === id);
  if (target === undefined) {
    console.error('✗ その世代が見つかりません。');
    process.exit(1);
  }
  const decided = activateGeneration({
    target: { ...target, lastCheckSucceeded: true, accountRef: probe.accountRef },
    currentlyAccepting: acceptingGeneration(generations),
    now: new Date(),
  });
  if (isErr(decided)) {
    console.error(`✗ 有効化できません（${decided.error.code}）。`);
    process.exit(1);
  }

  const actor = await systemActorId(prisma);
  const activated = await repo.activate({
    id,
    steppedDownId: decided.value.steppedDown?.id ?? null,
    activatedByAccountId: actor,
    activatedAt: new Date(),
  });
  if (activated === null) {
    console.error('✗ 有効化できませんでした。受付世代が変わっている可能性があります。');
    process.exit(1);
  }

  console.log(`✓ 第${String(activated.generation)}世代を有効化しました（${probe.accountRef}）。`);
  await audit(prisma, actor, 'payment_credential.activated_via_cli', id, {
    generation: activated.generation,
    accountRef: probe.accountRef,
    steppedDownGeneration: decided.value.steppedDown?.generation ?? null,
  });
}

/**
 * CLI 実行を記録するためのアカウント。
 *
 * ⚠️ **「誰か分からない」を残さない。** オーナーの中でいちばん古い行を
 * 使い、監査ログの `action` に `_via_cli` を付けて経路を区別する。
 */
async function systemActorId(prisma: PrismaClient): Promise<string> {
  const owner = await prisma.account.findFirst({
    where: { isOwner: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (owner === null) {
    console.error('✗ オーナーのアカウントが見つかりません。');
    process.exit(1);
  }
  return owner.id;
}

async function audit(
  prisma: PrismaClient,
  actorAccountId: string,
  action: string,
  targetId: string,
  summary: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorAccountId,
      action,
      targetType: 'payment_credential',
      targetId,
      // ⚠️ 鍵そのもの・先頭・末尾を残さない。
      summary: { ...summary, via: 'cli' },
    },
  });
}

main().catch((error: unknown) => {
  // ⚠️ 例外の本文をそのまま出さない。鍵が混ざりうる。
  console.error('✗ 実行に失敗しました。', error instanceof Error ? error.name : 'unknown');
  process.exit(1);
});
