import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SealedSecret, SecretCipherPort, SecretScope } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';
import { PrismaIntegrationRepository } from '../../src/repositories/integration.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 外部連携の設定と資格情報を、実 PostgreSQL に対して確かめる。
 *
 * ⚠️ **ここを Fake で済ませない。** 確かめたいのは
 * 「有効な資格情報が 2 件にならない」「秘密の平文が行に残らない」で、
 * 前者を保証しているのは部分UNIQUE、後者は列の設計そのもの。
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

let prisma: PrismaClient;
let repo: PrismaIntegrationRepository;

const NOW = new Date('2026-08-18T12:00:00.000Z');
const SECRET = 'ovew-live-9f2b1c00a4d67K9P';

/**
 * 試験用の暗号。
 *
 * ⚠️ **`@sengoku/integrations` の実装を借りない。** `database` は
 * `integrations` に依存しない層で、依存させると層が壊れる（`check:deps`）。
 * ここで確かめたいのは DB の制約と「行に平文が残らないこと」なので、
 * 本物と同じ AES-256-GCM を試験の中で組み立てれば足りる。
 * 暗号そのものの性質は `integrations` 側の試験で見ている。
 */
class TestCipher implements SecretCipherPort {
  constructor(private readonly key: Buffer) {}

  seal(plaintext: string, scope: SecretScope): SealedSecret {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${scope.service}:${scope.environment}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: 'v1',
      lastFour: plaintext.length >= 8 ? plaintext.slice(-4) : '',
    };
  }

  open(sealed: SealedSecret, scope: SecretScope): string | null {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(sealed.nonce, 'base64'),
      );
      decipher.setAAD(Buffer.from(`${scope.service}:${scope.environment}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}

beforeAll(async () => {
  if (!enabled) return;
  prisma = createTestClient();
  await prisma.$connect();
  repo = new PrismaIntegrationRepository(prisma, new TestCipher(randomBytes(32)));
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await prisma.account.create({
    data: { id, authProvider: 'fake', authSubject: id, role: 'operator', isOwner: true },
  });
  return id;
}

function newSecret(owner: string, overrides: Partial<{ purpose: 'api_key' | 'hmac_secret' }> = {}) {
  return {
    id: randomUUID(),
    service: 'ovew_wallet' as const,
    environment: 'production' as const,
    purpose: overrides.purpose ?? ('hmac_secret' as const),
    plaintext: SECRET,
    createdByAccountId: owner,
  };
}

suite('設定の制約', () => {
  it('サービスと環境の組は 1 つだけ', async () => {
    await repo.ensureSettings(randomUUID(), 'ovew_wallet', 'production');
    await expect(
      prisma.integrationSetting.create({
        data: { service: 'ovew_wallet', environment: 'production' },
      }),
      // ⚠️ Prisma は複合ユニークを索引名ではなく列名で返す。
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'service'));
  });

  it('知らないサービス名は保存できない', async () => {
    await expect(
      prisma.integrationSetting.create({ data: { service: 'stripe', environment: 'production' } }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'integration_settings_service_valid'));
  });

  it('極端な待ち時間は保存できない', async () => {
    await expect(
      prisma.integrationSetting.create({
        data: { service: 'auth', environment: 'production', timeoutMs: 600_000 },
      }),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'integration_settings_timeout_range'));
  });

  it('同じ組を 2 回作っても 1 件のまま（初回の既定値を壊さない）', async () => {
    const first = await repo.ensureSettings(randomUUID(), 'ovew_wallet', 'production');
    const owner = await seedAccount();
    await repo.saveSettings(
      { ...first, endpointUrl: 'https://wallet.example.com', timeoutMs: 20_000 },
      first.rowVersion,
      owner,
    );

    const again = await repo.ensureSettings(randomUUID(), 'ovew_wallet', 'production');
    expect(again.endpointUrl).toBe('https://wallet.example.com');
    expect(again.timeoutMs).toBe(20_000);
  });
});

suite('楽観ロック', () => {
  it('読んだときの版と一致すれば書ける', async () => {
    const owner = await seedAccount();
    const settings = await repo.ensureSettings(randomUUID(), 'ovew_wallet', 'production');
    const saved = await repo.saveSettings(
      { ...settings, endpointUrl: 'https://a.example.com' },
      settings.rowVersion,
      owner,
    );
    expect(saved).not.toBeNull();
    expect(saved?.rowVersion).toBe(settings.rowVersion + 1);
  });

  it('古い画面からの上書きを弾く', async () => {
    // ⚠️ ここが通ると、先に保存した人の変更が黙って消える。
    const owner = await seedAccount();
    const settings = await repo.ensureSettings(randomUUID(), 'ovew_wallet', 'production');

    await repo.saveSettings(
      { ...settings, endpointUrl: 'https://first.example.com' },
      settings.rowVersion,
      owner,
    );
    const stale = await repo.saveSettings(
      { ...settings, endpointUrl: 'https://second.example.com' },
      settings.rowVersion,
      owner,
    );

    expect(stale).toBeNull();
    const current = await repo.findSettings('ovew_wallet', 'production');
    expect(current?.endpointUrl).toBe('https://first.example.com');
  });
});

suite('資格情報', () => {
  it('平文が行に残らない', async () => {
    // ⚠️ この試験が落ちたら、DB を取られた時点で資格情報も取られる。
    const owner = await seedAccount();
    await repo.createSecret(newSecret(owner));

    const rows = await prisma.$queryRaw<
      { ciphertext: string; last_four: string }[]
    >`SELECT ciphertext, last_four FROM integration_secrets`;
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.ciphertext).not.toContain(SECRET);
    expect(row?.ciphertext).not.toContain('ovew-live');
    // 識別表示は末尾 4 文字だけ。
    expect(row?.last_four).toBe('7K9P');
  });

  it('返す形に暗号文が含まれない', async () => {
    const owner = await seedAccount();
    const created = await repo.createSecret(newSecret(owner));
    expect(created).not.toBeNull();
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(Object.keys(created ?? {})).not.toContain('ciphertext');
  });

  it('待機中は用途ごとに 1 件だけ', async () => {
    const owner = await seedAccount();
    expect(await repo.createSecret(newSecret(owner))).not.toBeNull();
    // 2 通目が作れると、どちらを有効化するのか決まらない。
    expect(await repo.createSecret(newSecret(owner))).toBeNull();
  });

  it('用途が違えば別に持てる', async () => {
    const owner = await seedAccount();
    expect(await repo.createSecret(newSecret(owner, { purpose: 'hmac_secret' }))).not.toBeNull();
    expect(await repo.createSecret(newSecret(owner, { purpose: 'api_key' }))).not.toBeNull();
  });

  it('有効なものは用途ごとに 1 件だけ（DB が担保する）', async () => {
    const owner = await seedAccount();
    const first = await repo.createSecret(newSecret(owner));
    if (first === null) throw new Error('作れなかった');
    await repo.activateSecret({ ...first, status: 'active', activatedAt: NOW }, null);

    const second = await repo.createSecret(newSecret(owner));
    if (second === null) throw new Error('作れなかった');
    // 古いほうを退役させずに有効化しようとすると、DB が拒否する。
    await expect(
      repo.activateSecret({ ...second, status: 'active', activatedAt: NOW }, null),
    ).rejects.toSatisfy((error) => violatesConstraint(error, 'service'));
  });

  it('入れ替えは 1 トランザクションで、片方だけ残らない', async () => {
    const owner = await seedAccount();
    const first = await repo.createSecret(newSecret(owner));
    if (first === null) throw new Error('作れなかった');
    await repo.activateSecret({ ...first, status: 'active', activatedAt: NOW }, null);

    const second = await repo.createSecret(newSecret(owner));
    if (second === null) throw new Error('作れなかった');
    await repo.activateSecret(
      { ...second, status: 'active', activatedAt: NOW },
      { ...first, status: 'retired', retiredAt: NOW },
    );

    const actives = await prisma.integrationSecret.count({ where: { status: 'active' } });
    expect(actives).toBe(1);
    const stillActive = await repo.findSecretByStatus(
      'ovew_wallet',
      'production',
      'hmac_secret',
      'active',
    );
    expect(stillActive?.id).toBe(second.id);
  });

  it('識別表示に 5 文字以上は入らない', async () => {
    const owner = await seedAccount();
    await expect(
      prisma.integrationSecret.create({
        data: {
          service: 'ovew_wallet',
          environment: 'production',
          purpose: 'api_key',
          ciphertext: 'x',
          nonce: 'x',
          authTag: 'x',
          keyVersion: 'v1',
          lastFour: 'TOOLONG',
          createdByAccountId: owner,
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'integration_secrets_last_four_short'),
    );
  });
});

suite('送信アダプタ向けの取り出し', () => {
  it('有効なものだけを開ける', async () => {
    const owner = await seedAccount();
    const created = await repo.createSecret(newSecret(owner));
    if (created === null) throw new Error('作れなかった');

    // 待機中は取り出せない。
    expect(await repo.revealForAdapter('ovew_wallet', 'production', 'hmac_secret')).toBeNull();

    await repo.activateSecret({ ...created, status: 'active', activatedAt: NOW }, null);
    expect(await repo.revealForAdapter('ovew_wallet', 'production', 'hmac_secret')).toBe(SECRET);
  });

  it('別の環境の行へ貼り替えても開けない', async () => {
    // ⚠️ DB を触れる人にだけできる攻撃。結び付け情報がこれを塞ぐ。
    const owner = await seedAccount();
    const created = await repo.createSecret(newSecret(owner));
    if (created === null) throw new Error('作れなかった');
    await repo.activateSecret({ ...created, status: 'active', activatedAt: NOW }, null);

    await prisma.integrationSecret.update({
      where: { id: created.id },
      data: { environment: 'staging' },
    });

    expect(await repo.revealForAdapter('ovew_wallet', 'staging', 'hmac_secret')).toBeNull();
  });

  it('暗号文を書き換えたら開けない', async () => {
    const owner = await seedAccount();
    const created = await repo.createSecret(newSecret(owner));
    if (created === null) throw new Error('作れなかった');
    await repo.activateSecret({ ...created, status: 'active', activatedAt: NOW }, null);

    const row = await prisma.integrationSecret.findUniqueOrThrow({ where: { id: created.id } });
    const bytes = Buffer.from(row.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    await prisma.integrationSecret.update({
      where: { id: created.id },
      data: { ciphertext: bytes.toString('base64') },
    });

    expect(await repo.revealForAdapter('ovew_wallet', 'production', 'hmac_secret')).toBeNull();
  });

  it('鍵を失うと開けない（再表示せず、作り直す方針）', async () => {
    const owner = await seedAccount();
    const created = await repo.createSecret(newSecret(owner));
    if (created === null) throw new Error('作れなかった');
    await repo.activateSecret({ ...created, status: 'active', activatedAt: NOW }, null);

    const withOtherKey = new PrismaIntegrationRepository(prisma, new TestCipher(randomBytes(32)));
    expect(
      await withOtherKey.revealForAdapter('ovew_wallet', 'production', 'hmac_secret'),
    ).toBeNull();
  });
});

suite('接続テストの記録', () => {
  async function record(succeeded: boolean, executedAt: Date, owner: string): Promise<void> {
    await repo.recordConnectionCheck({
      id: randomUUID(),
      service: 'ovew_wallet',
      environment: 'production',
      kind: 'reachability' as const,
      succeeded,
      failureCode: succeeded ? null : 'TIMEOUT',
      httpStatus: succeeded ? 405 : null,
      durationMs: 120,
      secretId: null,
      executedByAccountId: owner,
      correlationId: randomUUID(),
      executedAt,
    });
  }

  it('直近のものを引ける', async () => {
    const owner = await seedAccount();
    await record(false, new Date(NOW.getTime() - 60_000), owner);
    await record(true, NOW, owner);

    const latest = await repo.findLatestConnectionCheck('ovew_wallet', 'production');
    expect(latest?.succeeded).toBe(true);
  });

  /*
    ⚠️ **知らない種別を入れさせない。** 種別を増やすときは要決定 06
       （安全なテスト手段が確認できたか）の再確認とセットにしたい。
       制約を直さないと入らないことが、その確認を促す仕掛けになる。
  */
  it('知らない確認の種別は保存できない', async () => {
    await expect(
      prisma.integrationConnectionCheck.create({
        data: {
          service: 'ovew_wallet',
          environment: 'production',
          kind: 'test_event',
          succeeded: true,
          durationMs: 1,
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'integration_connection_checks_kind_known'),
    );
  });

  it('HTTP の状態コードでない値は保存できない', async () => {
    await expect(
      prisma.integrationConnectionCheck.create({
        data: {
          service: 'ovew_wallet',
          environment: 'production',
          kind: 'reachability',
          succeeded: true,
          httpStatus: 999,
          durationMs: 1,
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'integration_connection_checks_http_status_range'),
    );
  });

  it('成功に失敗の分類は付けられない', async () => {
    await expect(
      prisma.integrationConnectionCheck.create({
        data: {
          service: 'ovew_wallet',
          environment: 'production',
          kind: 'reachability',
          succeeded: true,
          failureCode: 'TIMEOUT',
          durationMs: 1,
        },
      }),
    ).rejects.toSatisfy((error) =>
      violatesConstraint(error, 'integration_connection_checks_failure_only_when_failed'),
    );
  });

  it('接続先を変えると、それまでの成功が効かなくなる', async () => {
    // ⚠️ 別の相手に対する成功で有効化できてしまわないため。
    const owner = await seedAccount();
    await record(true, NOW, owner);
    await repo.invalidateConnectionChecks('ovew_wallet', 'production', NOW);

    const latest = await repo.findLatestConnectionCheck('ovew_wallet', 'production');
    expect(latest?.succeeded).toBe(false);
    // 消さずに残す。いつ何を試したかを辿れるようにするため。
    expect(latest?.failureCode).toBe('SETTINGS_CHANGED');
  });
});
