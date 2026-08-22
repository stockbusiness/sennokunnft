import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createDevToken, DevTokenVerifier } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  FakeAlertWebhookCipher,
  TEST_AUDIENCE,
  TEST_INTERNAL_JOB_TOKEN,
  TEST_ISSUER,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 運営への知らせ（`UD-1102` の一部）。
 *
 * ⚠️ **この組の主題は 6 つ。**
 *  1. **宛先を変えられるのはオーナーだけ**——宛先の差し替えは「異常に
 *     気づく相手を選ぶ」ことである
 *  2. 受け口の URL を**読み戻さない**（URL 自体が合言葉）
 *  3. 記録にも文面にも**個人情報も合言葉も残さない**
 *  4. 宛先を直しても**抑制が解けない**（直後に鳴り直さない）
 *  5. **1 通も届いていなければ、知らせた印を立てない**
 *  6. 送れなくても**巡回を失敗にしない**（知らせの不調が時計の停止に化けない）
 */
const NOW = new Date('2026-08-22T00:00:00.000Z');
const WEBHOOK = 'https://hooks.example.com/abc123-secret';

let app: INestApplication;
let harness: TestHarness;

function tokenFor(subject: string): string {
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
}

function actorToken(role: Role, subject: string, isOwner = false): string {
  harness.accounts.seed(subject, role, { isOwner });
  return tokenFor(subject);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function save(token: string, body: Record<string, unknown> = {}) {
  return request(app.getHttpServer())
    .put('/api/v1/admin/operations-alerts')
    .set(auth(token))
    .send({
      enabled: true,
      minSeverity: 'critical',
      repeatAfterMinutes: 240,
      emailRecipients: ['ops@example.com'],
      ...body,
    });
}

function runJob() {
  return request(app.getHttpServer())
    .post('/api/v1/internal/jobs/notify-operations-alerts')
    .set('x-internal-job-token', TEST_INTERNAL_JOB_TOKEN);
}

beforeEach(async () => {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => NOW,
    }),
  );
  harness.clock.set(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(harness)],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('誰が触れるか', () => {
  it('未認証では見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/operations-alerts').expect(401);
  });

  /*
    ⚠️ **見るのは監査担当にも開く。** 「知らせが設定されているか」は監査の
       対象そのもの。変える力とは分けて配る。
  */
  it('監査担当は見られるが、変えられない', async () => {
    const auditor = actorToken('auditor', 'auditor-alert-1');
    await request(app.getHttpServer())
      .get('/api/v1/admin/operations-alerts')
      .set(auth(auditor))
      .expect(200);
    await save(auditor, {}).expect(403);
  });

  /*
    ⚠️ **宛先を差し替えられるということは、異常に気づく相手を選べるという
       こと。** 乗っ取った側が自分だけに向ければ、運営は何も気づけない。
  */
  it('オーナーの印が無い運営は、変えられない', async () => {
    await save(actorToken('operator', 'operator-alert-1')).expect(403);
    // ⚠️ 空振りでないことを確かめる（オーナーなら通る）。
    await save(actorToken('operator', 'owner-alert-1', true)).expect(200);
  });
});

describe('設定', () => {
  it('はじめは切ってある（宛先の無い知らせを積まない）', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/operations-alerts')
      .set(auth(actorToken('operator', 'operator-alert-2')))
      .expect(200);
    expect(response.body.settings).toMatchObject({
      enabled: false,
      emailRecipients: [],
      webhookHost: null,
    });
  });

  /*
    ⚠️ **受け口の URL を読み戻さない。** URL 自体が合言葉である。
       返すのはホスト名まで。
  */
  it('受け口の URL を読み戻さない。ホスト名までしか返さない', async () => {
    const owner = actorToken('operator', 'owner-alert-2', true);
    const saved = await save(owner, { webhookUrl: WEBHOOK }).expect(200);
    expect(saved.body.settings.webhookHost).toBe('hooks.example.com');
    expect(JSON.stringify(saved.body)).not.toContain('abc123-secret');

    const read = await request(app.getHttpServer())
      .get('/api/v1/admin/operations-alerts')
      .set(auth(owner))
      .expect(200);
    expect(JSON.stringify(read.body)).not.toContain('abc123-secret');
  });

  it('https でない受け口は断る', async () => {
    const owner = actorToken('operator', 'owner-alert-3', true);
    const response = await save(owner, { webhookUrl: 'http://hooks.example.com/x' }).expect(422);
    expect(response.body.error.code).toBe('OPERATIONS_ALERT_SETTINGS_INVALID');
  });

  it('形の違う宛先は断る', async () => {
    await save(actorToken('operator', 'owner-alert-4', true), {
      emailRecipients: ['ops'],
    }).expect(422);
  });

  /*
    ⚠️ **省略は「変えない」、空文字は「外す」。** 分けずに扱うと、
       宛先だけを直したつもりが受け口ごと消える。
  */
  it('URL を省略しても、受け口は消えない', async () => {
    const owner = actorToken('operator', 'owner-alert-5', true);
    await save(owner, { webhookUrl: WEBHOOK }).expect(200);
    const again = await save(owner, { emailRecipients: ['ops2@example.com'] }).expect(200);
    expect(again.body.settings.webhookHost).toBe('hooks.example.com');
  });

  it('空文字を渡すと、受け口を外せる', async () => {
    const owner = actorToken('operator', 'owner-alert-6', true);
    await save(owner, { webhookUrl: WEBHOOK }).expect(200);
    const cleared = await save(owner, { webhookUrl: '' }).expect(200);
    expect(cleared.body.settings.webhookHost).toBeNull();
  });

  /*
    ⚠️ **記録に宛先も URL も残さない。** 監査ログは長く残り、見る人も多い。
  */
  it('記録に宛先も受け口も残さない', async () => {
    const owner = actorToken('operator', 'owner-alert-7', true);
    await save(owner, { webhookUrl: WEBHOOK }).expect(200);

    const entry = harness.audit.entries.find(
      (row) => row.action === 'operations.alert_settings_saved',
    );
    expect(entry).toMatchObject({ targetType: 'environment' });
    const recorded = JSON.stringify(entry);
    expect(recorded).not.toContain('abc123-secret');
    expect(recorded).not.toContain('hooks.example.com');
    expect(recorded).not.toContain('ops@example.com');
    // ⚠️ 残すのは数まで。
    expect(entry?.summary).toMatchObject({ recipientCount: 1, webhookChanged: true });
  });

  /*
    ⚠️ **宛先を直しただけで抑制が解けない。** 解けると、直した直後に
       もう一度鳴る。
  */
  it('宛先を直しても、知らせた記録は消えない', async () => {
    const owner = actorToken('operator', 'owner-alert-8', true);
    await save(owner, {}).expect(200);
    harness.alertSettings.rows.set('production', {
      ...harness.alertSettings.rows.get('production')!,
      lastNotifiedAt: NOW,
      lastSeverity: 'critical',
      lastFingerprint: 'x',
    });

    await save(owner, { emailRecipients: ['ops3@example.com'] }).expect(200);
    expect(harness.alertSettings.rows.get('production')?.lastNotifiedAt).toEqual(NOW);
  });
});

describe('知らせる', () => {
  async function enable(overrides: Record<string, unknown> = {}): Promise<void> {
    await save(actorToken('operator', 'owner-run', true), {
      minSeverity: 'warning',
      ...overrides,
    }).expect(200);
  }

  /** 赤になる状況をつくる。⚠️ 発行を打ち切った注文があると赤。 */
  function makeCritical(): void {
    harness.operationsMetrics.counts_ = {
      ...harness.operationsMetrics.counts_,
      issuanceFailedCount: 3,
    };
  }

  /**
   * 平常へ戻す。
   *
   * ⚠️ **数を 0 にするだけでは平常にならない。** 時計が一度も成功して
   * いなければ黄色、決済の知らせを一度も受け取っていなければ黄色になる。
   * **「直った」を試すには、そこまで戻す必要がある**——ここを手抜きすると、
   * 復旧の知らせを試したつもりで「中身が変わった」を試すことになる。
   */
  function makeNormal(): void {
    harness.operationsMetrics.counts_ = {
      ...harness.operationsMetrics.counts_,
      issuanceFailedCount: 0,
      lastWebhookReceivedAt: NOW,
    };
    for (const jobKey of ['issue-entitlements', 'deliver-entitlements', 'send-notifications']) {
      harness.operationsMetrics.jobRuns.set(jobKey, {
        lastSucceededAt: NOW,
        lastFailedAt: null,
        lastOutcome: 'succeeded',
      });
    }
  }

  it('異常があれば送る', async () => {
    await enable();
    makeCritical();

    const response = await runJob().expect(200);
    expect(response.body).toMatchObject({ outcome: 'notified', reason: 'new', emailSent: 1 });
    expect(harness.alertMailer.sent).toHaveLength(1);
    expect(harness.alertMailer.sent[0]?.to).toBe('ops@example.com');
  });

  /*
    ⚠️ **文面に個人情報を入れない。** 知らせは受信箱と外部の受け口へ
       流れていく。流れた先まで、こちらの管理は及ばない。
  */
  it('文面に注文番号もお名前も入れない', async () => {
    await enable();
    makeCritical();
    await runJob().expect(200);

    const body = harness.alertMailer.sent[0]?.body ?? '';
    expect(body).toContain('お客さまの情報は含まれていません');
    expect(body).toContain('https://example.test/admin');
    expect(body).not.toContain('SNK-');
  });

  it('外部の受け口へも送る。⚠️ URL は解いて使う', async () => {
    await enable({ webhookUrl: WEBHOOK });
    makeCritical();

    await runJob().expect(200);
    expect(harness.alertWebhook.calls).toHaveLength(1);
    expect(harness.alertWebhook.calls[0]?.url).toBe(WEBHOOK);
    // ⚠️ 受け口へ渡す形にも、項目名と件数しか入らない。
    expect(JSON.stringify(harness.alertWebhook.calls[0]?.message.payload)).not.toContain('SNK-');
  });

  /*
    ⚠️ **鳴りっぱなしにしない。** 同じ状態が続くあいだは間隔を空ける。
  */
  it('同じ状態が続くあいだは、2 回目を送らない', async () => {
    await enable();
    makeCritical();
    await runJob().expect(200);

    const second = await runJob().expect(200);
    expect(second.body).toMatchObject({ outcome: 'skipped', reason: 'too_soon' });
    expect(harness.alertMailer.sent).toHaveLength(1);
  });

  /*
    ⚠️ **直ったことを知らせる。** 鳴り止んだだけでは、直ったのか
       知らせが壊れたのかが分からない。
  */
  it('平常へ戻ったら、直ったことを知らせる', async () => {
    await enable();
    makeCritical();
    await runJob().expect(200);

    makeNormal();
    const recovered = await runJob().expect(200);
    expect(recovered.body).toMatchObject({ outcome: 'notified', reason: 'recovered' });
    expect(harness.alertMailer.sent[1]?.subject).toContain('無くなりました');
  });

  /*
    ⚠️ **1 通も届いていなければ、知らせた印を立てない。** 立てると、
       次の巡回が「もう知らせた」として黙る。届いていないのに黙るのが、
       この仕組みでいちばん困る壊れ方である。
  */
  it('1 通も届かなければ、知らせた印を立てない', async () => {
    await enable();
    makeCritical();
    harness.alertMailer.accepted = false;

    const response = await runJob().expect(200);
    expect(response.body).toMatchObject({ emailSent: 0, emailFailed: 1 });
    expect(harness.alertSettings.rows.get('production')?.lastNotifiedAt).toBeNull();

    // ⚠️ 次の巡回で、もう一度試みる（黙らない）。
    harness.alertMailer.accepted = true;
    const retry = await runJob().expect(200);
    expect(retry.body).toMatchObject({ outcome: 'notified', reason: 'new' });
  });

  /*
    ⚠️ **知らせを送れなくても、巡回を失敗にしない。** 失敗にすると、
       知らせの不調が「時計の停止」に化け、本当の停止が埋もれる。
  */
  it('送れなくても、時計の記録は成功のまま', async () => {
    await enable();
    makeCritical();
    harness.alertMailer.accepted = false;
    await runJob().expect(200);

    const beat = await harness.operationsMetrics.heartbeats(['notify-operations-alerts']);
    expect(beat[0]?.lastOutcome).toBe('succeeded');
  });

  it('切ってあれば送らない', async () => {
    await save(actorToken('operator', 'owner-off', true), { enabled: false }).expect(200);
    makeCritical();

    const response = await runJob().expect(200);
    expect(response.body).toMatchObject({ outcome: 'skipped', reason: 'disabled' });
    expect(harness.alertMailer.sent).toEqual([]);
  });

  it('合言葉が違えば叩けない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/notify-operations-alerts')
      .set('x-internal-job-token', 'wrong')
      .expect(401);
  });

  /*
    ⚠️ **別の環境の行から貼り替えても解けない。** 貼り替えられると、
       本番の異常が試験用の受け口へ流れる（＝本番の担当者が気づけない）。
  */
  it('別の環境で包まれた受け口は解けず、送らない', async () => {
    await enable();
    makeCritical();
    harness.alertSettings.rows.set('production', {
      ...harness.alertSettings.rows.get('production')!,
      emailRecipients: [],
      sealedWebhookUrl: new FakeAlertWebhookCipher().seal(WEBHOOK, 'staging'),
      webhookHost: 'hooks.example.com',
    });

    const response = await runJob().expect(200);
    expect(harness.alertWebhook.calls).toEqual([]);
    expect(response.body).toMatchObject({ webhookSent: false });
  });
});
