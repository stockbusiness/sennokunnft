import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../generated/client';
import { PrismaOperationsAlertSettingsRepository } from '../../src/repositories/operations-alert.repository';
import {
  createTestClient,
  integrationTestsAvailable,
  resetDatabase,
  violatesConstraint,
} from '../helpers/database';

/**
 * 運営への知らせの設定（`UD-1102` の一部）。
 *
 * ⚠️ **ここで見たいのは 5 つ。**
 *  1. **平文の受け口の列が無いこと**
 *  2. **環境ごとに 1 件しか持てないこと**
 *  3. 保存で**知らせた記録に触れないこと**（直した直後に鳴り直さない）
 *  4. **鳴りっぱなしを作れる間隔を DB が拒むこと**
 *  5. **包みが片方だけの行を DB が拒むこと**（設定したのに送られない、を作らない）
 */
const enabled = integrationTestsAvailable();
const suite = enabled ? describe : describe.skip;

const NOW = new Date('2026-08-22T00:00:00.000Z');

let prisma: PrismaClient;
let settings: PrismaOperationsAlertSettingsRepository;

beforeAll(() => {
  if (!enabled) return;
  prisma = createTestClient();
  settings = new PrismaOperationsAlertSettingsRepository(prisma);
});

afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  await resetDatabase(prisma);
});

function base(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'production',
    enabled: true,
    minSeverity: 'critical' as const,
    repeatAfterMinutes: 240,
    emailRecipients: ['ops@example.com'],
    now: NOW,
    ...overrides,
  };
}

const SEALED = {
  ciphertext: 'Y2lwaGVy',
  nonce: 'bm9uY2U=',
  authTag: 'dGFn',
  keyVersion: 'v1',
  lastFour: '',
};

suite('保存と読み取り', () => {
  it('未設定なら null', async () => {
    expect(await settings.find('production')).toBeNull();
  });

  it('保存して読み戻せる', async () => {
    await settings.save(base());
    expect(await settings.find('production')).toMatchObject({
      enabled: true,
      minSeverity: 'critical',
      emailRecipients: ['ops@example.com'],
      sealedWebhookUrl: null,
      // ⚠️ まだ一度も知らせていない。
      lastNotifiedAt: null,
    });
  });

  /*
    ⚠️ **環境ごとに 1 件。** 主キーが環境なので 2 件目は作れず差し替えになる。
       2 件持てると、どちらが効いているのか誰にも分からなくなる。
  */
  it('同じ環境で 2 件持てない', async () => {
    await settings.save(base());
    await settings.save(base({ enabled: false }));
    const rows = await prisma.operationsAlertSettings.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
  });

  it('環境が違えば別の設定になる', async () => {
    await settings.save(base({ emailRecipients: ['prod@example.com'] }));
    await settings.save(base({ environment: 'staging', emailRecipients: ['stg@example.com'] }));
    expect((await settings.find('production'))?.emailRecipients).toEqual(['prod@example.com']);
    expect((await settings.find('staging'))?.emailRecipients).toEqual(['stg@example.com']);
  });

  /*
    ⚠️ **保存で「知らせた記録」に触れない。** 触ると、宛先を直しただけで
       抑制が解け、直後にもう一度鳴る。
  */
  it('保存しても、知らせた記録は消えない', async () => {
    await settings.save(base());
    await settings.markNotified({
      environment: 'production',
      severity: 'critical',
      fingerprint: 'x',
      now: NOW,
    });

    await settings.save(base({ emailRecipients: ['other@example.com'] }));
    const after = await settings.find('production');
    expect(after?.lastNotifiedAt).toEqual(NOW);
    expect(after?.lastFingerprint).toBe('x');
    // ⚠️ 空振りでないことを確かめる（宛先のほうは変わっている）。
    expect(after?.emailRecipients).toEqual(['other@example.com']);
  });

  /*
    ⚠️ **知らせても、宛先や条件を書き戻さない。** 書き戻すと、送信の途中で
       人が直した内容を巻き戻す。
  */
  it('知らせても、宛先は書き換わらない', async () => {
    await settings.save(base());
    await settings.markNotified({
      environment: 'production',
      severity: 'warning',
      fingerprint: 'y',
      now: NOW,
    });
    expect((await settings.find('production'))?.emailRecipients).toEqual(['ops@example.com']);
  });

  /*
    ⚠️ **省略は「変えない」、空は「外す」。** 分けずに扱うと、宛先だけを
       直したつもりが受け口ごと消える。
  */
  it('受け口を省略しても消えない。null なら消える', async () => {
    await settings.save(base({ sealedWebhookUrl: SEALED, webhookHost: 'hooks.example.com' }));
    await settings.save(base({ enabled: false }));
    expect((await settings.find('production'))?.webhookHost).toBe('hooks.example.com');

    await settings.save(base({ sealedWebhookUrl: null, webhookHost: null }));
    expect((await settings.find('production'))?.sealedWebhookUrl).toBeNull();
  });
});

suite('DB が止めること', () => {
  /*
    ⚠️ **平文で受け口を置く列が無い。** 列があると、いつか誰かが入れる。
       URL 自体が合言葉なので、入れられた時点で漏れている。
  */
  it('平文の受け口を置く列が無い', async () => {
    const columns = await prisma.$queryRawUnsafe<readonly { column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'operations_alert_settings'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).toContain('webhook_ciphertext');
    // ⚠️ 平文を置けそうな名前が 1 つも無いこと。
    expect(names).not.toContain('webhook_url');
    expect(names.filter((name) => name.includes('plain'))).toEqual([]);
  });

  /*
    ⚠️ **鳴りっぱなしを作れる間隔を拒む。** 1 分ごとに鳴る設定を作れると、
       受け取る側が数日で見なくなる。
  */
  it('間隔が短すぎる設定を拒む', async () => {
    await expect(settings.save(base({ repeatAfterMinutes: 1 }))).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'operations_alert_settings_repeat_range'),
    );
  });

  it('間隔が長すぎる設定を拒む', async () => {
    await expect(settings.save(base({ repeatAfterMinutes: 10_000 }))).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'operations_alert_settings_repeat_range'),
    );
  });

  /*
    ⚠️ **`normal` を選べない。** 平常を知らせても意味が無く、選べると
       「毎回鳴る」設定を作れてしまう。
  */
  it('平常を知らせる設定を拒む', async () => {
    await expect(
      prisma.operationsAlertSettings.create({
        data: { environment: 'production', minSeverity: 'normal' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'operations_alert_settings_min_severity_known'),
    );
  });

  /*
    ⚠️ **包みが片方だけの行を拒む。** 解けない行は「受け口を設定したのに
       送られない」を静かに作る。
  */
  it('包みが揃っていない行を拒む', async () => {
    await expect(
      prisma.operationsAlertSettings.create({
        data: { environment: 'production', webhookCiphertext: 'x' },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'operations_alert_settings_webhook_complete'),
    );
  });

  /*
    ⚠️ **伏せた表記に URL を丸ごと入れさせない。** 入れると、包んで
       保管した意味が画面の側から失われる。
  */
  it('伏せた表記に経路つきの URL を入れられない', async () => {
    await expect(
      prisma.operationsAlertSettings.create({
        data: {
          environment: 'production',
          webhookCiphertext: 'x',
          webhookNonce: 'y',
          webhookAuthTag: 'z',
          webhookKeyVersion: 'v1',
          webhookHost: 'hooks.example.com/abc-secret',
        },
      }),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'operations_alert_settings_host_is_host'),
    );
  });

  it('宛先が多すぎる設定を拒む', async () => {
    await expect(
      settings.save(
        base({
          emailRecipients: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'],
        }),
      ),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'operations_alert_settings_recipient_count'),
    );
  });

  /*
    ⚠️ **空の宛先を混ぜない。** 1 つ混ざると送信のたびに失敗し、
       ほかの宛先まで巻き添えになりうる。
  */
  it('空の宛先を拒む', async () => {
    await expect(
      settings.save(base({ emailRecipients: ['ops@example.com', ''] })),
    ).rejects.toSatisfy((error: unknown) =>
      violatesConstraint(error, 'operations_alert_settings_recipients_not_blank'),
    );
  });

  it('知らない環境を拒む', async () => {
    await expect(settings.save(base({ environment: 'develop' }))).rejects.toSatisfy(
      (error: unknown) => violatesConstraint(error, 'operations_alert_settings_environment_known'),
    );
  });
});
