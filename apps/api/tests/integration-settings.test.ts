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
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 外部連携の設定と資格情報（管理画面・外部連携 指示書 §12・§13）。
 *
 * ⚠️ **この試験の主題は「秘密が出ないこと」と「テストなしに有効化できないこと」。**
 * 登録できたことより、登録した値がどこにも現れないことを厚く見る。
 */

let app: INestApplication;
let harness: TestHarness;

const SECRET_VALUE = 'ovew-live-9f2b1c00a4d67K9P';
const OWNER = 'owner';
const OWNER_ID = 'account-owner';

function tokenFor(subject: string): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });
}

function actorToken(role: Role, subject: string, isOwner = false): string {
  harness.accounts.seed(subject, role, { isOwner });
  return tokenFor(subject);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function ownerToken(): string {
  return actorToken('operator', OWNER, true);
}

/** 接続テストが成功した状態を作る。**画面を経由せず、直接記録する。** */
async function recordSuccessfulCheck(offsetMs = 0): Promise<void> {
  await harness.integrationRepository.recordConnectionCheck({
    id: `check-${String(offsetMs)}`,
    service: 'ovew_wallet',
    environment: 'production',
    kind: 'reachability' as const,
    succeeded: true,
    failureCode: null,
    httpStatus: 405,
    durationMs: 120,
    secretId: null,
    executedByAccountId: OWNER_ID,
    correlationId: null,
    executedAt: new Date(TEST_NOW.getTime() - offsetMs),
  });
}

/**
 * 資格情報を登録して有効にするところまで進める。
 *
 * ⚠️ **有効化そのものが接続確認の成功を要る**（PR 1 の規則）。
 * ここではその前提を整えるだけで、確認の成否はこの関数の主題ではない。
 */
async function registerAndActivateSecret(token: string): Promise<void> {
  await recordSuccessfulCheck();
  const secretId = await registerSecret(token);
  await request(app.getHttpServer())
    .post(`/api/v1/admin/integrations/secrets/${secretId}/activate`)
    .set(auth(token))
    .expect(201);
}

async function registerSecret(token: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/admin/integrations/ovew_wallet/secrets')
    .set(auth(token))
    .send({ purpose: 'hmac_secret', value: SECRET_VALUE })
    .expect(201);
  const secrets = response.body.secrets as { id: string; status: string }[];
  const pending = secrets.find((item) => item.status === 'pending');
  if (pending === undefined) throw new Error('待機中の資格情報が見つからない');
  return pending.id;
}

beforeEach(async () => {
  harness = buildHarness(
    new DevTokenVerifier({
      secret: TEST_TOKEN_SECRET,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => TEST_NOW,
    }),
  );
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

describe('手が届く範囲', () => {
  it('未認証では状態も見られない', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/integrations').expect(401);
  });

  it('buyer は状態も見られない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/integrations')
      .set(auth(actorToken('buyer', 'member')))
      .expect(403);
  });

  it('印の無い operator も状態は見られる', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/integrations')
      .set(auth(actorToken('operator', 'plain-op')))
      .expect(200);
  });

  it('auditor も状態は見られる', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/integrations')
      .set(auth(actorToken('auditor', 'viewer')))
      .expect(200);
  });

  const WRITES = [
    { method: 'patch' as const, path: '/api/v1/admin/integrations/ovew_wallet' },
    { method: 'post' as const, path: '/api/v1/admin/integrations/ovew_wallet/enable' },
    { method: 'post' as const, path: '/api/v1/admin/integrations/ovew_wallet/disable' },
    { method: 'post' as const, path: '/api/v1/admin/integrations/ovew_wallet/secrets' },
  ];

  for (const { method, path } of WRITES) {
    it(`印の無い operator は ${method.toUpperCase()} ${path} を呼べない`, async () => {
      // ⚠️ ここが通ると、運営の 1 人が乗っ取られただけで送信先ごと差し替えられる。
      await request(app.getHttpServer())
        [method](path)
        .set(auth(actorToken('operator', 'plain-op')))
        .expect(403);
    });

    it(`auditor は ${method.toUpperCase()} ${path} を呼べない`, async () => {
      await request(app.getHttpServer())
        [method](path)
        .set(auth(actorToken('auditor', 'viewer')))
        .expect(403);
    });
  }

  it('知らないサービス名は受け付けない', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/stripe')
      .set(auth(ownerToken()))
      .expect(400);
  });
});

describe('秘密が出ないこと', () => {
  it('登録しても、応答のどこにも値が現れない', async () => {
    // ⚠️ この試験が落ちたら、画面にキーが出ている。
    const token = ownerToken();
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(token))
      .send({ purpose: 'hmac_secret', value: SECRET_VALUE })
      .expect(201);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(SECRET_VALUE);
    expect(body).not.toContain('ovew-live');
    // 識別表示だけは出る。
    expect(body).toContain('7K9P');
  });

  it('一覧にも詳細にも値が現れない', async () => {
    const token = ownerToken();
    await registerSecret(token);

    for (const path of ['/api/v1/admin/integrations', '/api/v1/admin/integrations/ovew_wallet']) {
      const response = await request(app.getHttpServer()).get(path).set(auth(token)).expect(200);
      expect(JSON.stringify(response.body)).not.toContain(SECRET_VALUE);
    }
  });

  it('応答に暗号文も含まれない', async () => {
    // 暗号文でも、外へ出す理由が無い。出せば解読の的になる。
    const token = ownerToken();
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(token))
      .send({ purpose: 'hmac_secret', value: SECRET_VALUE })
      .expect(201);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('ciphertext');
    expect(body).not.toContain('nonce');
    expect(body).not.toContain('authTag');
  });

  it('監査ログに値が残らない', async () => {
    const token = ownerToken();
    await registerSecret(token);

    const entries = JSON.stringify(harness.audit.entries);
    expect(entries).not.toContain(SECRET_VALUE);
    expect(entries).not.toContain('ovew-live');
    // 何が起きたかは残る。
    expect(entries).toContain('integration.secret.register');
    expect(entries).toContain('7K9P');
  });

  it('登録済みの値を取り出す経路が無い', async () => {
    // ⚠️ 経路そのものを作らないことが担保（指示書 §6.1）。
    const token = ownerToken();
    const secretId = await registerSecret(token);

    for (const path of [
      `/api/v1/admin/integrations/secrets/${secretId}`,
      `/api/v1/admin/integrations/secrets/${secretId}/reveal`,
      '/api/v1/admin/integrations/ovew_wallet/secrets',
    ]) {
      const response = await request(app.getHttpServer()).get(path).set(auth(token));
      expect(response.status).toBe(404);
    }
  });

  it('接続先の値を監査ログに残さない', async () => {
    // ホスト名も業務上の秘密になりうる。変えたかどうかだけを残す。
    const token = ownerToken();
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://internal-wallet.example.com/api', rowVersion: 1 })
      .expect(200);

    expect(JSON.stringify(harness.audit.entries)).not.toContain('internal-wallet');
  });
});

describe('設定の更新', () => {
  it('https 以外の接続先を受け付けない', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(ownerToken()))
      .send({ endpointUrl: 'http://wallet.example.com', rowVersion: 1 })
      .expect(400);
  });

  it('知らない項目を受け付けない', async () => {
    // 綴り違いが黙って保存されると、どれが効いているのか分からなくなる。
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(ownerToken()))
      .send({ endpointUrl: 'https://wallet.example.com', apiKey: 'x', rowVersion: 1 })
      .expect(400);
  });

  it('古い版での上書きを弾く', async () => {
    const token = ownerToken();
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://first.example.com', rowVersion: 1 })
      .expect(200);

    // 古い画面が版 1 のまま送ってくる。
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://second.example.com', rowVersion: 1 })
      .expect(409);
  });

  it('接続先を変えると、それまでの成功が効かなくなる', async () => {
    // ⚠️ 別の相手に対する成功で有効化できてしまわないため。
    const token = ownerToken();
    await recordSuccessfulCheck();

    const before = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .expect(200);
    expect(before.body.checkFresh).toBe(true);

    const after = await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://moved.example.com', rowVersion: before.body.rowVersion })
      .expect(200);
    expect(after.body.checkFresh).toBe(false);
  });
});

describe('有効化', () => {
  it('接続テストなしには有効にできない', async () => {
    // ⚠️ 有効にした瞬間から本物の送信が始まる。
    const token = ownerToken();
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://wallet.example.com', keyId: 'market-1', rowVersion: 1 })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/enable')
      .set(auth(token))
      .expect(409);
  });

  it('資格情報が無ければ有効にできない', async () => {
    const token = ownerToken();
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://wallet.example.com', keyId: 'market-1', rowVersion: 1 })
      .expect(200);
    await recordSuccessfulCheck();

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/enable')
      .set(auth(token))
      .expect(409);
  });

  it('条件がそろえば有効にできる', async () => {
    const token = ownerToken();
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://wallet.example.com', keyId: 'market-1', rowVersion: 1 })
      .expect(200);

    const secretId = await registerSecret(token);
    await recordSuccessfulCheck();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/secrets/${secretId}/activate`)
      .set(auth(token))
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/enable')
      .set(auth(token))
      .expect(201);
    expect(response.body.enabled).toBe(true);
  });

  it('古い成功では有効にできない', async () => {
    const token = ownerToken();
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://wallet.example.com', keyId: 'market-1', rowVersion: 1 })
      .expect(200);
    const secretId = await registerSecret(token);
    await recordSuccessfulCheck();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/secrets/${secretId}/activate`)
      .set(auth(token))
      .expect(201);

    // 31 分前の成功だけを残す。
    harness.integrationRepository.invalidateConnectionChecks('ovew_wallet', 'production');
    await recordSuccessfulCheck(31 * 60 * 1000);

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/enable')
      .set(auth(token))
      .expect(409);
  });

  it('止めるのはいつでもできる', async () => {
    // 事故を止める操作なので、条件を付けない。
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/disable')
      .set(auth(ownerToken()))
      .expect(201);
    expect(response.body.enabled).toBe(false);
  });
});

describe('資格情報の交換', () => {
  it('登録しただけでは有効にならない', async () => {
    // ⚠️ 間違った値で連携が止まると、元の値は再表示できないため戻せない。
    const token = ownerToken();
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(token))
      .send({ purpose: 'hmac_secret', value: SECRET_VALUE })
      .expect(201);

    const secrets = response.body.secrets as { status: string }[];
    expect(secrets.every((item) => item.status === 'pending')).toBe(true);
  });

  it('接続テストなしには有効にできない', async () => {
    const token = ownerToken();
    const secretId = await registerSecret(token);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/secrets/${secretId}/activate`)
      .set(auth(token))
      .expect(409);
  });

  it('待機中は 1 件しか作れない', async () => {
    const token = ownerToken();
    await registerSecret(token);
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(token))
      .send({ purpose: 'hmac_secret', value: 'another-secret-value' })
      .expect(409);
  });

  it('入れ替えると古いほうが退役する', async () => {
    const token = ownerToken();
    const first = await registerSecret(token);
    await recordSuccessfulCheck();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/secrets/${first}/activate`)
      .set(auth(token))
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(token))
      .send({ purpose: 'hmac_secret', value: 'second-secret-value-2ABC' })
      .expect(201);
    const listed = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .expect(200);
    const second = (listed.body.secrets as { id: string; status: string }[]).find(
      (item) => item.status === 'pending',
    );
    if (second === undefined) throw new Error('待機中が無い');

    const after = await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/secrets/${second.id}/activate`)
      .set(auth(token))
      .expect(201);

    const secrets = after.body.secrets as { id: string; status: string }[];
    expect(secrets.filter((item) => item.status === 'active')).toHaveLength(1);
    expect(secrets.find((item) => item.id === first)?.status).toBe('retired');
  });

  it('待機中を捨てても、有効なものは残る', async () => {
    const token = ownerToken();
    const first = await registerSecret(token);
    await recordSuccessfulCheck();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/secrets/${first}/activate`)
      .set(auth(token))
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(token))
      .send({ purpose: 'hmac_secret', value: 'discard-me-please-9999' })
      .expect(201);
    const listed = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .expect(200);
    const pending = (listed.body.secrets as { id: string; status: string }[]).find(
      (item) => item.status === 'pending',
    );
    if (pending === undefined) throw new Error('待機中が無い');

    const after = await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/secrets/${pending.id}/discard`)
      .set(auth(token))
      .expect(201);

    const secrets = after.body.secrets as { id: string; status: string }[];
    expect(secrets.find((item) => item.id === first)?.status).toBe('active');
  });

  it('短すぎる値は受け付けない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(ownerToken()))
      .send({ purpose: 'hmac_secret', value: 'short' })
      .expect(400);
  });

  it('知らない用途は受け付けない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/secrets')
      .set(auth(ownerToken()))
      .send({ purpose: 'password', value: SECRET_VALUE })
      .expect(400);
  });
});

describe('環境の取り違え', () => {
  it('要求で環境を指定できない', async () => {
    // ⚠️ 指定できると、本番のプロセスから staging の設定を書き換えられる。
    const token = ownerToken();
    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations')
      .set(auth(token))
      .expect(200);

    expect(response.body.appEnvironment).toBe('production');
    for (const item of response.body.items as { environment: string }[]) {
      expect(item.environment).toBe('production');
    }
  });
});

/**
 * 接続確認（指示書 §4.3・要決定 06）。
 *
 * ⚠️ **この試験の主題は「何を確かめていないかが伝わること」。**
 * 到達性しか見ていないのに「テスト成功」だけを返すと、
 * 資格情報まで確かめた気にさせる。
 */
describe('接続確認', () => {
  async function configureEndpoint(token: string): Promise<void> {
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://wallet.example.com', keyId: 'market-1', rowVersion: 1 })
      .expect(200);
  }

  it('接続先を入れていなければ、試させない', async () => {
    const token = ownerToken();

    // ⚠️ 「試したが失敗した」と「接続先を入れていない」を混ぜない。
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(token))
      .expect(400);
  });

  it('届けば成功として記録し、何を確かめたかを残す', async () => {
    const token = ownerToken();
    await configureEndpoint(token);
    harness.setProbe({ kind: 'response', statusCode: 405 });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(token))
      .expect(201);

    expect(response.body.lastCheck.succeeded).toBe(true);
    // ⚠️ 到達性しか確かめていないことを、応答に残す。
    expect(response.body.lastCheck.kind).toBe('reachability');
    expect(response.body.lastCheck.httpStatus).toBe(405);
    expect(response.body.checkFresh).toBe(true);
  });

  it('5xx は届いていても失敗にする', async () => {
    const token = ownerToken();
    await configureEndpoint(token);
    harness.setProbe({ kind: 'response', statusCode: 503 });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(token))
      .expect(201);

    expect(response.body.lastCheck.succeeded).toBe(false);
    expect(response.body.lastCheck.failureCode).toBe('http_5xx');
    expect(response.body.canEnable).toBe(false);
  });

  it('接続できなければ失敗として記録する', async () => {
    const token = ownerToken();
    await configureEndpoint(token);
    harness.setProbe({ kind: 'network', code: 'ENOTFOUND' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(token))
      .expect(201);

    expect(response.body.lastCheck.succeeded).toBe(false);
    expect(response.body.lastCheck.failureCode).toBe('ENOTFOUND');
  });

  /*
    ⚠️ **失敗のあとに有効化できないこと。** PR 2 の完了条件そのもの。
  */
  it('接続確認に失敗したら、本番を有効にできない', async () => {
    const token = ownerToken();
    await configureEndpoint(token);
    await registerAndActivateSecret(token);
    harness.setProbe({ kind: 'timeout' });

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(token))
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/enable')
      .set(auth(token))
      .expect(409);
  });

  it('確認は履歴に積み上がる（失敗も残る）', async () => {
    const token = ownerToken();
    await configureEndpoint(token);

    harness.setProbe({ kind: 'timeout' });
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(token))
      .expect(201);

    harness.setProbe({ kind: 'response', statusCode: 204 });
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(token))
      .expect(201);

    // ⚠️ 成功だけを残さない。「何度も失敗したあとの 1 回の成功」が見えなくなる。
    expect(response.body.recentChecks).toHaveLength(2);
    /*
      ⚠️ **時計を止めた試験なので、2 件は同じ時刻に並ぶ。**
         同時刻のときは失敗を先に採る規則にしてある（迷ったら閉じるほう）。
         その規則が画面の並びにも効いていることを、ここで固定する。
    */
    expect(response.body.recentChecks.map((c: { succeeded: boolean }) => c.succeeded)).toEqual([
      false,
      true,
    ]);
    // 同時刻に成功と失敗が並んだら、判定は失敗のほうを見る。
    expect(response.body.lastCheck.succeeded).toBe(false);
    expect(response.body.canEnable).toBe(false);
  });

  it('閲覧者は確認を実行できない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(actorToken('auditor', 'audit-1', false)))
      .expect(403);
  });

  it('印の無い運営は確認を実行できない', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/check')
      .set(auth(actorToken('operator', 'ops-1', false)))
      .expect(403);
  });

  /*
    ⚠️ **鍵の識別子が無ければ有効化させない。** 署名ヘッダに載る値で、
       欠けていれば相手は必ず断る。有効化してから毎回断られるより、手前で止める。
  */
  it('鍵の識別子が無ければ有効にできない', async () => {
    const token = ownerToken();
    await request(app.getHttpServer())
      .patch('/api/v1/admin/integrations/ovew_wallet')
      .set(auth(token))
      .send({ endpointUrl: 'https://wallet.example.com', rowVersion: 1 })
      .expect(200);
    await registerAndActivateSecret(token);
    await recordSuccessfulCheck();

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/ovew_wallet/enable')
      .set(auth(token))
      .expect(400);
  });
});

/**
 * 画像の保管先とログイン（管理画面・外部連携 指示書 §4・§11・§14）。
 *
 * ⚠️ **この試験の主題は「保存できないこと」。**
 * これらは配備環境が正で、DB に置いても誰も読まない。
 * 保存できてしまうと、「保存できたのに効かない」を誰も説明できなくなる。
 */
describe('管理外の連携（画像の保管先・ログイン）', () => {
  for (const service of ['storage', 'auth'] as const) {
    it(`${service}: 状態は見られる`, async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/integrations/${service}`)
        .set(auth(ownerToken()))
        .expect(200);

      expect(response.body.manageable).toBe(false);
      expect(response.body.environmentSummary).not.toBeNull();
      expect(response.body.environmentSummary.complete).toBe(true);
    });

    it(`${service}: 設定は保存できない`, async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/integrations/${service}`)
        .set(auth(ownerToken()))
        .send({ endpointUrl: 'https://evil.example.com', rowVersion: 0 })
        .expect(409);
    });

    it(`${service}: 資格情報は登録できない`, async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/integrations/${service}/secrets`)
        .set(auth(ownerToken()))
        .send({ purpose: 'hmac_secret', value: 'some-secret-value' })
        .expect(409);
    });

    it(`${service}: 有効化も停止もできない`, async () => {
      const token = ownerToken();
      await request(app.getHttpServer())
        .post(`/api/v1/admin/integrations/${service}/enable`)
        .set(auth(token))
        .expect(409);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/integrations/${service}/disable`)
        .set(auth(token))
        .expect(409);
    });

    /*
      ⚠️ **DB に行を作らない。** 作ると「保存できる場所」として残る。
         読まれない値を持てる場所は、いつか誰かが埋めて、効かないことに悩む。
    */
    it(`${service}: 見ても設定の行を作らない`, async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/admin/integrations/${service}`)
        .set(auth(ownerToken()))
        .expect(200);

      expect(await harness.integrationRepository.findSettings(service, 'production')).toBeNull();
    });
  }

  it('欠けている設定の名前は出すが、値は出さない', async () => {
    harness.setEnvironmentSummary('storage', {
      provider: 'r2',
      complete: false,
      missing: ['R2_SECRET_ACCESS_KEY'],
      publicUrl: null,
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/storage')
      .set(auth(ownerToken()))
      .expect(200);

    expect(response.body.environmentSummary.missing).toEqual(['R2_SECRET_ACCESS_KEY']);
    expect(response.body.environmentSummary.complete).toBe(false);
    // 設定の名前は秘密ではない。値のほうは、そもそも渡していない。
    expect(response.body.secrets).toEqual([]);
  });

  /*
    ⚠️ **確かめられるのは公開 URL だけ。** 画像の配信元と鍵束の置き場は
       ブラウザからも見えるもので、資格情報を含まない。
  */
  it('公開 URL があれば、届くかどうかは確かめられる', async () => {
    harness.setProbe({ kind: 'response', statusCode: 200 });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/storage/check')
      .set(auth(ownerToken()))
      .expect(201);

    expect(response.body.lastCheck.succeeded).toBe(true);
    expect(response.body.lastCheck.kind).toBe('reachability');
  });

  it('公開 URL が無ければ、確かめようがないので断る', async () => {
    harness.setEnvironmentSummary('storage', {
      provider: 'local',
      complete: true,
      missing: [],
      publicUrl: null,
    });

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/storage/check')
      .set(auth(ownerToken()))
      .expect(400);
  });
});
