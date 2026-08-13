import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { livenessResponseSchema, readinessResponseSchema } from '@sengoku/contracts';
import { AppModule } from '../src/app.module';
import { HealthService, type DependencyProbe } from '../src/health/health.service';
import { DOMAIN_ERROR_HTTP_STATUS } from '../src/common/domain-error.filter';
import { DOMAIN_ERROR_CODES } from '@sengoku/domain';

function probe(name: string, ok: boolean): DependencyProbe {
  return { name, check: () => Promise.resolve({ ok, durationMs: 1 }) };
}

async function createApp(probes: readonly DependencyProbe[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register({ version: '0.1.0', probes })],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('HealthService', () => {
  it('liveness は外部依存を確認しない', async () => {
    let probeCalled = false;
    const service = new HealthService('0.1.0', [
      {
        name: 'database',
        check: () => {
          probeCalled = true;
          return Promise.resolve({ ok: true, durationMs: 1 });
        },
      },
    ]);

    service.liveness();
    // DB 障害でコンテナが再起動を繰り返すのを防ぐため、liveness は依存を見ない。
    expect(probeCalled).toBe(false);
  });

  it('依存がすべて正常なら readiness は ok', async () => {
    const service = new HealthService('0.1.0', [probe('database', true)]);
    const result = await service.readiness();
    expect(result.status).toBe('ok');
  });

  it('依存が1つでも落ちていれば degraded', async () => {
    const service = new HealthService('0.1.0', [probe('database', false), probe('cache', true)]);
    const result = await service.readiness();
    expect(result.status).toBe('degraded');
    expect(result.checks.find((check) => check.name === 'database')?.status).toBe('fail');
  });

  it('稼働時間を秒で返す', () => {
    let clock = 0;
    const service = new HealthService('0.1.0', [], () => clock);
    clock = 42_000;
    expect(service.liveness().uptimeSec).toBe(42);
  });
});

describe('ヘルスチェックのエンドポイント', () => {
  it('GET /healthz が 200 と契約どおりの本文を返す', async () => {
    const app = await createApp([]);
    try {
      const response = await request(app.getHttpServer()).get('/healthz').expect(200);
      expect(livenessResponseSchema.safeParse(response.body).success).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /readyz は依存が正常なら 200', async () => {
    const app = await createApp([probe('database', true)]);
    try {
      const response = await request(app.getHttpServer()).get('/readyz').expect(200);
      expect(readinessResponseSchema.safeParse(response.body).success).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /readyz は依存が落ちていれば 503', async () => {
    const app = await createApp([probe('database', false)]);
    try {
      // ロードバランサが処理できないインスタンスへ流し続けないよう、200 を返さない。
      await request(app.getHttpServer()).get('/readyz').expect(503);
    } finally {
      await app.close();
    }
  });

  it('応答に接続先などの内部情報を含めない', async () => {
    const app = await createApp([probe('database', true)]);
    try {
      const response = await request(app.getHttpServer()).get('/readyz').expect(200);
      const body = JSON.stringify(response.body);
      expect(body).not.toMatch(/postgres|postgresql|:\/\//);
    } finally {
      await app.close();
    }
  });
});

describe('ドメインエラーの HTTP 対応表（API_DESIGN §2.1）', () => {
  it('すべてのドメインエラーコードに対応が定義されている', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      expect(DOMAIN_ERROR_HTTP_STATUS[code], `${code} の対応が未定義`).toBeGreaterThan(0);
    }
  });

  it('Claim トークン不正は 404（存在の有無を漏らさない）', () => {
    // 403 にすると「そのトークンは実在する」と教えることになる。
    expect(DOMAIN_ERROR_HTTP_STATUS.CLAIM_TOKEN_INVALID).toBe(404);
  });

  it('購入者不一致は 403', () => {
    expect(DOMAIN_ERROR_HTTP_STATUS.ENTITLEMENT_OWNER_MISMATCH).toBe(403);
  });

  it('在庫不足は 409（入力の誤りではなく状態の衝突）', () => {
    expect(DOMAIN_ERROR_HTTP_STATUS.INSUFFICIENT_SUPPLY).toBe(409);
  });
});
