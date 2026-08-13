import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkDatabaseConnection,
  ENTITLEMENT_CLAIM_SQL,
  IDEMPOTENCY_CONSTRAINTS,
  MINT_JOB_ACQUIRE_SQL,
  type PrismaClientLike,
} from '../src/index';

const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

/**
 * 指定した model の本体だけを取り出す。
 *
 * スキーマ全体に対して正規表現を当てると、`[\s\S]*?` が別の model まで
 * またいで一致してしまい、検査の意味がなくなる。
 */
function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (match?.[1] === undefined) {
    throw new Error(`model ${name} がスキーマに見つかりません`);
  }
  return match[1];
}

/**
 * スキーマの「事故を防ぐための制約」が消えていないことを検査する。
 *
 * 実DBを起動しなくても検証できる範囲に絞っている（実制約の動作検証は Phase 2 の結合テスト）。
 * リファクタリング中に UNIQUE を1つ落とすだけで多重発行が起きうるため、
 * ここで気付けるようにしておく。
 */
describe('スキーマの不変条件（DATABASE_DESIGN §4）', () => {
  it('1受取権につき発行ジョブは1件（UNIQUE entitlement_id on mint_jobs）', () => {
    expect(modelBlock('MintJob')).toMatch(/entitlementId\s+String\s+@unique/);
  });

  it('1受取権につきトークンは1件（UNIQUE entitlement_id on nft_tokens）', () => {
    // これが「1つの受取権から複数Mintできない」ことの最終的な担保。
    expect(modelBlock('NftToken')).toMatch(/entitlementId\s+String\s+@unique/);
  });

  it('発行ジョブの冪等キーが一意', () => {
    expect(modelBlock('MintJob')).toMatch(/idempotencyKey\s+String\s+@unique/);
  });

  it('Webhook イベントが (provider, eventId) で一意', () => {
    expect(modelBlock('WebhookEvent')).toContain('@@unique([provider, eventId])');
  });

  it('注文が (accountId, idempotencyKey) で一意', () => {
    expect(modelBlock('Order')).toContain('@@unique([accountId, idempotencyKey])');
  });

  it('受取権のシリアル番号が作品内で一意', () => {
    expect(modelBlock('Entitlement')).toContain('@@unique([artworkId, serialNo])');
  });

  it('Claim トークンはハッシュで保存され、平文の列を持たない', () => {
    expect(schema).toContain('claimTokenHash');
    expect(schema).not.toMatch(/^\s*claimToken\s+String/m);
  });

  it('Webhook の本文そのものを保存する列を持たない', () => {
    // 本文には個人情報・カード関連情報が含まれうるため、ダイジェストのみ保持する。
    const webhookEvent = modelBlock('WebhookEvent');
    expect(webhookEvent).toContain('payloadDigest');
    expect(webhookEvent).not.toMatch(/\n\s*payload\s+Json/);
  });

  it('金額の列が整数型（浮動小数点を使わない）', () => {
    expect(schema).toMatch(/priceAmount\s+Int/);
    expect(schema).toMatch(/totalAmount\s+Int/);
    expect(schema).toMatch(/unitPriceAmount\s+Int/);
    expect(schema).not.toMatch(/(price|amount|total)\w*\s+(Float|Decimal)/i);
  });

  it('日時が TIMESTAMPTZ（タイムゾーン付き）', () => {
    expect(schema).toContain('@db.Timestamptz(6)');
    expect(schema).not.toContain('@db.Timestamp(');
  });

  it('チェーン系の識別子が不透明な文字列（UD-501 を先取りしない）', () => {
    expect(schema).toMatch(/chainRef\s+String/);
    expect(schema).toMatch(/contractRef\s+String/);
    expect(schema).toMatch(/ownerRef\s+String/);
  });
});

describe('冪等性を担保する SQL', () => {
  it('Claim は条件付き UPDATE で行う（SELECT してから UPDATE しない）', () => {
    expect(ENTITLEMENT_CLAIM_SQL).toContain("status = 'issued'");
    expect(ENTITLEMENT_CLAIM_SQL).toContain('expires_at IS NULL OR expires_at > now()');
    expect(ENTITLEMENT_CLAIM_SQL.startsWith('UPDATE')).toBe(true);
  });

  it('発行ジョブの取得が SKIP LOCKED を使う（複数ワーカーの競合回避）', () => {
    expect(MINT_JOB_ACQUIRE_SQL).toContain('FOR UPDATE SKIP LOCKED');
    expect(MINT_JOB_ACQUIRE_SQL).toContain("status = 'queued'");
    expect(MINT_JOB_ACQUIRE_SQL).toContain('attempt_count = attempt_count + 1');
  });

  it('制約一覧に多重Mintを防ぐものが含まれる', () => {
    const nftTokenConstraint = IDEMPOTENCY_CONSTRAINTS.find(
      (item) => item.table === 'nft_tokens' && item.constraint.includes('entitlement_id'),
    );
    expect(nftTokenConstraint).toBeDefined();
  });

  it('制約一覧にオーバーセルを防ぐ CHECK が含まれる', () => {
    const overselling = IDEMPOTENCY_CONSTRAINTS.find((item) => item.constraint.startsWith('CHECK'));
    expect(overselling?.table).toBe('artworks');
  });
});

describe('checkDatabaseConnection', () => {
  function fakeClient(behavior: 'ok' | 'fail'): PrismaClientLike {
    return {
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
      $queryRawUnsafe: () =>
        behavior === 'ok'
          ? Promise.resolve([{ '?column?': 1 }] as never)
          : Promise.reject(new Error('connection to db.internal.example.com refused')),
    };
  }

  it('接続できれば ok を返す', async () => {
    const result = await checkDatabaseConnection(fakeClient('ok'));
    expect(result.ok).toBe(true);
  });

  it('接続できなければ ok=false を返し、例外を投げない', async () => {
    const result = await checkDatabaseConnection(fakeClient('fail'));
    expect(result.ok).toBe(false);
  });

  it('結果に接続先の情報を含めない（偵察に使わせない）', async () => {
    const result = await checkDatabaseConnection(fakeClient('fail'));
    expect(JSON.stringify(result)).not.toContain('db.internal.example.com');
  });

  it('所要時間を計測する', async () => {
    let clock = 1000;
    const result = await checkDatabaseConnection(fakeClient('ok'), () => {
      const value = clock;
      clock += 7;
      return value;
    });
    expect(result.durationMs).toBe(7);
  });
});
