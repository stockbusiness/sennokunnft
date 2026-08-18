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
 * 運営スタッフの招待と権限（`UD-803`）。
 *
 * ⚠️ **この試験の主題は「取れないこと」と「締め出されないこと」。**
 * ここは壊れると全部取られる場所なので、
 * 「招待できた」より「他人の招待を横取りできない」を厚く見る。
 */

let app: INestApplication;
let harness: TestHarness;

interface TokenOptions {
  readonly email?: string;
  readonly emailVerified?: boolean;
}

function tokenFor(subject: string, options: TokenOptions = {}): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
    ...(options.email === undefined ? {} : { email: options.email }),
    ...(options.emailVerified === undefined ? {} : { email_verified: options.emailVerified }),
  });
}

/** そのロール・印を持つ人としてのトークン。 */
function actorToken(
  role: Role,
  subject: string,
  options: TokenOptions & { isOwner?: boolean } = {},
): string {
  harness.accounts.seed(subject, role, { isOwner: options.isOwner ?? false });
  return tokenFor(subject, options);
}

const OWNER = 'owner';
const OWNER_ID = 'account-owner';
const STAFF = 'staff';
const STAFF_ID = 'account-staff';

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
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

describe('スタッフ画面に手が届く範囲', () => {
  const PATHS = [
    { method: 'get' as const, path: '/api/v1/admin/staff' },
    { method: 'post' as const, path: '/api/v1/admin/staff/invitations' },
    { method: 'patch' as const, path: `/api/v1/admin/staff/${STAFF_ID}` },
  ];

  for (const { method, path } of PATHS) {
    it(`未認証では ${method.toUpperCase()} ${path} を呼べない`, async () => {
      await request(app.getHttpServer())[method](path).expect(401);
    });

    it(`印の無い operator は ${method.toUpperCase()} ${path} を呼べない`, async () => {
      // ⚠️ ここが通ると、運営の 1 人が乗っ取られただけで全権限を配り直される。
      const token = actorToken('operator', 'plain-op');
      await request(app.getHttpServer())[method](path).set(auth(token)).expect(403);
    });

    it(`buyer は ${method.toUpperCase()} ${path} を呼べない`, async () => {
      const token = actorToken('buyer', 'member');
      await request(app.getHttpServer())[method](path).set(auth(token)).expect(403);
    });

    it(`auditor は ${method.toUpperCase()} ${path} を呼べない`, async () => {
      const token = actorToken('auditor', 'viewer');
      await request(app.getHttpServer())[method](path).set(auth(token)).expect(403);
    });
  }

  it('停止中のオーナーは呼べない', async () => {
    harness.accounts.seed('gone', 'operator', { isOwner: true, status: 'suspended' });
    await request(app.getHttpServer())
      .get('/api/v1/admin/staff')
      .set(auth(tokenFor('gone')))
      .expect(403);
  });
});

describe('スタッフを招待する', () => {
  it('オーナーは招待を作れる', async () => {
    const token = actorToken('operator', OWNER, { isOwner: true });

    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ email: ' New.Staff@Example.com ', role: 'auditor' })
      .expect(201);

    // 宛先はそろえて保存する。そろえないと二重招待できてしまう。
    expect(response.body.email).toBe('new.staff@example.com');
    expect(response.body.role).toBe('auditor');
    expect(response.body.isOpen).toBe(true);
  });

  it('同じ宛先に生きた招待を 2 通は作れない', async () => {
    // 2 通あると、片方を取り消してももう片方で入れる。
    const token = actorToken('operator', OWNER, { isOwner: true });
    const body = { email: 'dup@example.com', role: 'operator' };

    await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ ...body, email: 'DUP@Example.com' })
      .expect(409);
  });

  it('すでにスタッフの人は招待できない（死んだ招待を残さない）', async () => {
    // 送っても、開いた時点で「もうスタッフです」と断られるだけ。
    // 一覧には「お返事待ち」として残り続け、送った側は待ち続けることになる。
    const token = actorToken('operator', OWNER, { isOwner: true });
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ email: 'already@example.com', role: 'operator' })
      .expect(201);

    const joiner = actorToken('buyer', 'already', {
      email: 'already@example.com',
      emailVerified: true,
    });
    await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(joiner))
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ email: 'Already@Example.com', role: 'auditor' })
      .expect(409);
  });

  it('招待で buyer は配れない', async () => {
    const token = actorToken('operator', OWNER, { isOwner: true });
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ email: 'x@example.com', role: 'buyer' })
      .expect(400);
  });

  it('招待したことが監査ログに残る', async () => {
    const token = actorToken('operator', OWNER, { isOwner: true });
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ email: 'trace@example.com', role: 'operator' })
      .expect(201);

    const entry = harness.audit.entries.find((item) => item.action === 'staff.invite');
    expect(entry?.actorAccountId).toBe(OWNER_ID);
    expect(JSON.stringify(entry?.summary)).toContain('trace@example.com');
  });

  it('取り消した招待は、取り消し済みとして残る', async () => {
    const token = actorToken('operator', OWNER, { isOwner: true });
    const created = await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ email: 'revoke@example.com', role: 'operator' })
      .expect(201);

    const revoked = await request(app.getHttpServer())
      .delete(`/api/v1/admin/staff/invitations/${created.body.id}`)
      .set(auth(token))
      .expect(200);

    expect(revoked.body.status).toBe('revoked');
    expect(revoked.body.isOpen).toBe(false);
  });
});

describe('招待を受け取る', () => {
  async function inviteAs(email: string, role = 'operator'): Promise<void> {
    const token = actorToken('operator', OWNER, { isOwner: true });
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(token))
      .send({ email, role })
      .expect(201);
  }

  it('招待された宛先でログインするとスタッフになる', async () => {
    await inviteAs('invited@example.com');
    const token = actorToken('buyer', 'invited', {
      email: 'invited@example.com',
      emailVerified: true,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(token))
      .expect(201);

    expect(response.body).toEqual({ accepted: true, role: 'operator' });
    // 実際に権限が付いていること（付かなければ受諾の意味が無い）。
    await request(app.getHttpServer()).get('/api/v1/admin/artworks').set(auth(token)).expect(200);
  });

  it('招待で人事権（オーナー）は渡らない', async () => {
    await inviteAs('invited@example.com');
    const token = actorToken('buyer', 'invited', {
      email: 'invited@example.com',
      emailVerified: true,
    });
    await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(token))
      .expect(201);

    await request(app.getHttpServer()).get('/api/v1/admin/staff').set(auth(token)).expect(403);
  });

  it('別の宛先の人は受け取れない', async () => {
    // ⚠️ ここが通ると、他人宛の招待で権限を取れる。
    await inviteAs('invited@example.com');
    const token = actorToken('buyer', 'stranger', {
      email: 'stranger@example.com',
      emailVerified: true,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(token))
      .expect(201);

    expect(response.body).toEqual({ accepted: false, role: null });
    await request(app.getHttpServer()).get('/api/v1/admin/artworks').set(auth(token)).expect(403);
  });

  it('確認されていないアドレスでは受け取れない', async () => {
    // ⚠️ 未確認のアドレスを信じると、宛先を名乗るだけで権限を取れる。
    await inviteAs('invited@example.com');
    const token = actorToken('buyer', 'liar', {
      email: 'invited@example.com',
      emailVerified: false,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(token))
      .expect(201);

    expect(response.body.accepted).toBe(false);
  });

  it('取り消された招待は受け取れない', async () => {
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    const created = await request(app.getHttpServer())
      .post('/api/v1/admin/staff/invitations')
      .set(auth(ownerToken))
      .send({ email: 'revoked@example.com', role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/staff/invitations/${created.body.id}`)
      .set(auth(ownerToken))
      .expect(200);

    const token = actorToken('buyer', 'late', {
      email: 'revoked@example.com',
      emailVerified: true,
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(token))
      .expect(201);
    expect(response.body.accepted).toBe(false);
  });

  it('同じ招待は二度使えない', async () => {
    await inviteAs('once@example.com');
    const first = actorToken('buyer', 'first', {
      email: 'once@example.com',
      emailVerified: true,
    });
    await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(first))
      .expect(201);

    const second = actorToken('buyer', 'second', {
      email: 'once@example.com',
      emailVerified: true,
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(second))
      .expect(201);
    expect(response.body.accepted).toBe(false);
  });

  it('待っている招待が無くても失敗にしない（普通のログインで毎回呼ぶため）', async () => {
    const token = actorToken('buyer', 'nobody', {
      email: 'nobody@example.com',
      emailVerified: true,
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/me/staff-invitation/accept')
      .set(auth(token))
      .expect(201);
    expect(response.body).toEqual({ accepted: false, role: null });
  });

  it('未認証では呼べない', async () => {
    await request(app.getHttpServer()).post('/api/v1/me/staff-invitation/accept').expect(401);
  });
});

describe('スタッフの権限を変える', () => {
  function seedOwnerAndStaff(): { ownerToken: string } {
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    harness.accounts.seed(STAFF, 'operator');
    return { ownerToken };
  }

  it('オーナーは、ほかのスタッフを閲覧のみに落とせる', async () => {
    const { ownerToken } = seedOwnerAndStaff();
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${STAFF_ID}`)
      .set(auth(ownerToken))
      .send({ role: 'auditor' })
      .expect(200);

    expect(response.body.role).toBe('auditor');
    // 実際に作品を触れなくなっていること。
    await request(app.getHttpServer())
      .post('/api/v1/admin/artworks')
      .set(auth(tokenFor(STAFF)))
      .send({ slug: 'x', title: 'x', maxSupply: 1 })
      .expect(403);
  });

  it('自分自身は変えられない', async () => {
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${OWNER_ID}`)
      .set(auth(ownerToken))
      .send({ isOwner: false })
      .expect(409);
  });

  it('最後のオーナーは降ろせない（誰も権限を配れなくなる）', async () => {
    // 別のオーナーが 1 人だけいる状態を作り、その人を降ろそうとする。
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    harness.accounts.seed('other-owner', 'operator', { isOwner: true });
    // オーナーは 2 人なので、まず自分以外を降ろせる。
    await request(app.getHttpServer())
      .patch('/api/v1/admin/staff/account-other-owner')
      .set(auth(ownerToken))
      .send({ isOwner: false })
      .expect(200);

    // これで残りは自分だけ。自分自身は変えられないので、0 人にはできない。
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${OWNER_ID}`)
      .set(auth(ownerToken))
      .send({ isOwner: false })
      .expect(409);
  });

  it('一般会員をここから引き上げられない（招待を通す）', async () => {
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    harness.accounts.seed('member', 'buyer');
    await request(app.getHttpServer())
      .patch('/api/v1/admin/staff/account-member')
      .set(auth(ownerToken))
      .send({ role: 'operator' })
      .expect(409);
  });

  it('閲覧のみの人をオーナーにできない', async () => {
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    harness.accounts.seed('viewer', 'auditor');
    await request(app.getHttpServer())
      .patch('/api/v1/admin/staff/account-viewer')
      .set(auth(ownerToken))
      .send({ isOwner: true })
      .expect(409);
  });

  it('停止したスタッフは管理APIを呼べなくなる', async () => {
    const { ownerToken } = seedOwnerAndStaff();
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${STAFF_ID}`)
      .set(auth(ownerToken))
      .send({ status: 'suspended' })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/admin/artworks')
      .set(auth(tokenFor(STAFF)))
      .expect(403);
  });

  it('存在しない相手は 404', async () => {
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    await request(app.getHttpServer())
      .patch('/api/v1/admin/staff/account-nobody')
      .set(auth(ownerToken))
      .send({ role: 'auditor' })
      .expect(404);
  });

  it('何も指定しない要求は受け付けない', async () => {
    const { ownerToken } = seedOwnerAndStaff();
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${STAFF_ID}`)
      .set(auth(ownerToken))
      .send({})
      .expect(400);
  });

  it('変更が監査ログに残る', async () => {
    const { ownerToken } = seedOwnerAndStaff();
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${STAFF_ID}`)
      .set(auth(ownerToken))
      .send({ role: 'auditor' })
      .expect(200);

    const entry = harness.audit.entries.find((item) => item.action === 'staff.update');
    expect(entry?.actorAccountId).toBe(OWNER_ID);
    expect(entry?.targetId).toBe(STAFF_ID);
  });
});

describe('スタッフの一覧', () => {
  it('一般会員は並ばない（押し間違いで無関係の人を止めないため）', async () => {
    const ownerToken = actorToken('operator', OWNER, { isOwner: true });
    harness.accounts.seed('member', 'buyer');
    harness.accounts.seed('viewer', 'auditor');

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/staff')
      .set(auth(ownerToken))
      .expect(200);

    const ids = response.body.members.map((item: { accountId: string }) => item.accountId);
    expect(ids).toContain(OWNER_ID);
    expect(ids).toContain('account-viewer');
    expect(ids).not.toContain('account-member');
  });
});
