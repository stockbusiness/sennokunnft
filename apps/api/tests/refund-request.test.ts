import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDevToken, DevTokenVerifier, signWebhookPayload } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
import {
  BUYER_REFUND_REASON_VALUES,
  REFUND_REQUEST_REASON_VALUES,
  REFUND_REQUEST_STATUS_VALUES,
} from '@sengoku/contracts';
import {
  BUYER_SELECTABLE_REFUND_REASONS,
  REFUND_REQUEST_REASONS,
  REFUND_REQUEST_STATUSES,
} from '@sengoku/domain';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error.filter';
import {
  buildHarness,
  sampleArtwork,
  sampleListing,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_NOW,
  TEST_TOKEN_SECRET,
  TEST_WEBHOOK_SECRET,
  type TestHarness,
} from './helpers/doubles';

/**
 * 返金の申請と審査（方針整理 2026-08-22）。
 *
 * ⚠️ **この組の主題は 7 つ。**
 *  1. **作家さまが決済事業者へ投げる口が無いこと**——販売の代金は運営の
 *     決済アカウントで受けている。返せるのも運営だけである
 *  2. **調べる人と、返すと決める人が分かれていること**——承認は
 *     オーナー限定（`refund_request.approve`）
 *  3. **同じ注文に、決着していない申請が 2 つできないこと**——できると、
 *     2 つとも承認されて二重に返金できる
 *  4. **二重承認では、申請した本人が承認できないこと**——承認の欄が
 *     1 つ増えただけでは歯止めにならない
 *  5. **金額の再入力が要ること**——一部返金の額を受け取る口を開けた
 *     代わりの歯止め（`UD-104` の当初の判断を覆した条件）
 *  6. **2 回押しても 1 回しか投げないこと**——`executing` を条件付き
 *     更新で取ったほうだけが進む
 *  7. **作家さまの回答を待たずに進められること**——答えない作家さまが
 *     いるだけで購入者が待たされる、という形にしない
 */

let app: INestApplication;
let harness: TestHarness;

const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_TOTAL = 12000;
/** ⚠️ `sampleArtwork` の作家さま。事実確認はこの方へ届く。 */
const CREATOR_SUBJECT = 'operator';
const ADMIN = '/api/v1/admin/refund-requests';

function tokenFor(subject: string): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });
}

function actorToken(
  role: Role,
  subject = `user-${role}`,
  options: { isOwner?: boolean } = {},
): string {
  harness.accounts.seed(subject, role, { isOwner: options.isOwner ?? false });
  return tokenFor(subject);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 承認できる人。⚠️ `refund_request.approve` はオーナー限定。 */
function ownerToken(subject = 'owner-1'): string {
  return actorToken('operator', subject, { isOwner: true });
}

function webhook(body: Record<string, unknown>) {
  const serialized = JSON.stringify(body);
  const rawBody = Buffer.from(serialized, 'utf8');
  const timestampSec = Math.floor(harness.clock.now().getTime() / 1000);
  const signature = signWebhookPayload(TEST_WEBHOOK_SECRET, timestampSec, rawBody);
  return request(app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('stripe-signature', `t=${String(timestampSec)},v1=${signature}`)
    .set('content-type', 'application/json')
    .send(serialized);
}

/** 支払い済みの注文を 1 件。⚠️ 決済確定は Webhook だけが行う。 */
async function paidOrder(buyerToken: string): Promise<string> {
  harness.artworks.seed(sampleArtwork({ maxSupply: 3 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));

  const created = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(auth(buyerToken))
    .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
    .expect(201);
  const orderId = created.body.order.id as string;

  await request(app.getHttpServer())
    .post(`/api/v1/orders/${orderId}/checkout-session`)
    .set(auth(buyerToken))
    .expect(201);

  await webhook({
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: { order_id: orderId, amount: ORDER_TOTAL, currency: 'jpy' },
  }).expect(200);

  return orderId;
}

/** 申し出 1 件を作る。⚠️ 事由で作家さまへの確認の要否が変わる。 */
async function submitted(
  reason = 'not_as_described',
): Promise<{ orderId: string; requestId: string; buyer: string }> {
  const buyer = actorToken('buyer');
  const orderId = await paidOrder(buyer);
  const response = await request(app.getHttpServer())
    .post(`/api/v1/orders/${orderId}/refund-requests`)
    .set(auth(buyer))
    .send({ reason, statement: '届いたものが説明と違いました。' })
    .expect(201);
  return { orderId, requestId: response.body.id as string, buyer };
}

/** 調べ終えたところまで進める。 */
async function reviewed(reason = 'not_as_described'): Promise<{ requestId: string }> {
  const { requestId } = await submitted(reason);
  await request(app.getHttpServer())
    .post(`${ADMIN}/${requestId}/investigate`)
    .set(auth(actorToken('operator', 'investigator-1')))
    .send({ note: '購入者の申し出を確かめました。' })
    .expect(201);
  return { requestId };
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
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('誰が触れるか', () => {
  it('未認証では一覧を読めない', async () => {
    await request(app.getHttpServer()).get(ADMIN).expect(401);
  });

  it('会員は運営の一覧を読めない', async () => {
    await request(app.getHttpServer())
      .get(ADMIN)
      .set(auth(actorToken('buyer', 'nosy-1')))
      .expect(403);
  });

  it('監査担当は読める（誰が申し出て誰が承認したかは監査の対象そのもの）', async () => {
    await request(app.getHttpServer())
      .get(ADMIN)
      .set(auth(actorToken('auditor', 'auditor-1')))
      .expect(200);
  });

  it('監査担当は調べられない（外へ働きかける操作だから）', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/investigate`)
      .set(auth(actorToken('auditor', 'auditor-2')))
      .send({ note: '見ました' })
      .expect(403);
  });

  it('オーナーの印が無い運営は承認できない', async () => {
    /*
      ⚠️ **ここがお金を返すと決める場所。** 調べる力
         （`refund_request.investigate`）を持っていても、返すとは決められない。
    */
    const { requestId } = await reviewed();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(actorToken('operator', 'plain-operator')))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(403);
  });
});

describe('作家さまには返金を実行する口が無い', () => {
  /*
    ⚠️ **この試験がこの PR のいちばんの主題。** 販売の代金は運営の決済
       アカウントで受けているので、返せるのも運営だけである。作家さまへ
       この口を渡すと、受けていないお金を返す操作ができてしまう。
  */
  it('作家さまは運営の実行の口を叩けない', async () => {
    const { requestId } = await reviewed();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/execute`)
      .set(auth(actorToken('buyer', CREATOR_SUBJECT)))
      .expect(403);
  });

  it('作家さまは承認も却下もできない', async () => {
    const { requestId } = await reviewed();
    const creator = actorToken('buyer', CREATOR_SUBJECT);
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(creator))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/reject`)
      .set(auth(creator))
      .send({ rejectionNote: '返しません' })
      .expect(403);
  });
});

describe('購入者の申し出', () => {
  it('ご自分の注文にだけ申し出られる', async () => {
    const buyer = actorToken('buyer', 'buyer-owner');
    const orderId = await paidOrder(buyer);
    /*
      ⚠️ **「他人の注文だ」と教えない。** 無いのと同じ扱いにする。
         教えると、注文IDを総当たりして「在る」ことを確かめられる。
    */
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/refund-requests`)
      .set(auth(actorToken('buyer', 'someone-else')))
      .send({ reason: 'not_as_described', statement: '関係のない人からの申し出です。' })
      .expect(404);
  });

  it('購入者には分からない事由は選べない', async () => {
    const buyer = actorToken('buyer', 'buyer-chargeback');
    const orderId = await paidOrder(buyer);
    /*
      ⚠️ **チャージバックは事業者から届く事実。** 人が申し出る事由ではない。
    */
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/refund-requests`)
      .set(auth(buyer))
      .send({ reason: 'chargeback', statement: 'カード会社へ連絡しました。' })
      .expect(422);
  });

  it('原則対象外の事由でも受け付ける（記録に残すため）', async () => {
    /*
      ⚠️ **受け付けないと、その申し出がどれだけ来ているかが残らない。**
         既定では却下されるだけで、受け付けること自体は妨げない。
    */
    const { requestId } = await submitted('buyer_change_of_mind');
    const detail = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'reader-1')))
      .expect(200);
    expect(detail.body.request.category).toBe('excluded');
  });

  it('同じ注文に、決着していない申請を 2 つ作れない', async () => {
    const { orderId, buyer } = await submitted();
    const second = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/refund-requests`)
      .set(auth(buyer))
      .send({ reason: 'quality_issue', statement: 'やはり品質にも不満があります。' });
    // ⚠️ 403 ではない。権限はある。この注文では押せないだけ。
    expect(second.status).toBe(409);
  });

  it('金額を受け取らない（どれだけ返るかは審査が決める）', async () => {
    const buyer = actorToken('buyer', 'buyer-amount');
    const orderId = await paidOrder(buyer);
    const response = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/refund-requests`)
      .set(auth(buyer))
      .send({ reason: 'quality_issue', statement: '思っていたものと違いました。', amount: 1 })
      .expect(201);
    // ⚠️ 送られてきた 1 円は捨てられ、残額で置かれる。
    expect(response.body.amount).toBe(ORDER_TOTAL);
  });
});

describe('作家さまへの事実確認', () => {
  it('運営だけで判断する事由では、作家さまへ聞けない', async () => {
    /*
      ⚠️ **何でも聞けるようにすると、運営の判断で済む話まで作家さまの
         手を止める。** 事実を知っているのが作家さまだけ、という事由の
         ときにだけ聞く。
    */
    const { requestId } = await submitted('duplicate_payment');
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/ask-creator`)
      .set(auth(actorToken('operator', 'asker-1')))
      .send({})
      .expect(409);
  });

  it('作家さまは、ご自分に来た確認だけを読める', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/ask-creator`)
      .set(auth(actorToken('operator', 'asker-2')))
      .send({})
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/api/v1/creator/refund-inquiries')
      .set(auth(actorToken('buyer', CREATOR_SUBJECT)))
      .expect(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].requestId).toBe(requestId);

    const other = await request(app.getHttpServer())
      .get('/api/v1/creator/refund-inquiries')
      .set(auth(actorToken('buyer', 'other-creator')))
      .expect(200);
    expect(other.body.items).toHaveLength(0);
  });

  it('別の方宛ての確認には答えられない', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/ask-creator`)
      .set(auth(actorToken('operator', 'asker-3')))
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/creator/refund-inquiries/${requestId}/answer`)
      .set(auth(actorToken('buyer', 'not-the-creator')))
      .send({ answer: '私の作品ではありませんが答えます。' })
      .expect(409);
  });

  it('答えられるのは 1 度だけ', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/ask-creator`)
      .set(auth(actorToken('operator', 'asker-4')))
      .send({})
      .expect(201);
    const creator = actorToken('buyer', CREATOR_SUBJECT);
    const path = `/api/v1/creator/refund-inquiries/${requestId}/answer`;
    await request(app.getHttpServer())
      .post(path)
      .set(auth(creator))
      .send({ answer: '説明どおりの品です。' })
      .expect(201);
    await request(app.getHttpServer())
      .post(path)
      .set(auth(creator))
      .send({ answer: 'やはり違いました。' })
      .expect(409);
  });

  it('作家さまが答えなくても、運営だけで審査を進められる', async () => {
    /*
      ⚠️ **ここが期限の意味。** 「答えないと返金できない」にすると、
         答えない作家さまがいるだけで購入者が待たされる。
    */
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/ask-creator`)
      .set(auth(actorToken('operator', 'asker-5')))
      .send({})
      .expect(201);

    const advanced = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/investigate`)
      .set(auth(actorToken('operator', 'investigator-2')))
      .send({ note: '回答を待たずに進めます。' })
      .expect(201);
    expect(advanced.body.status).toBe('reviewed');
  });

  it('回答の本文を証跡へ写さない', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/ask-creator`)
      .set(auth(actorToken('operator', 'asker-6')))
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/creator/refund-inquiries/${requestId}/answer`)
      .set(auth(actorToken('buyer', CREATOR_SUBJECT)))
      .send({ answer: '秘密にしたい取引先の名前が入っています。' })
      .expect(201);

    /*
      ⚠️ **証跡は長く残り、閲覧範囲も広い。** 数と符号までにする。
    */
    const serialized = JSON.stringify(harness.refundRequests.requests.events);
    expect(serialized).not.toContain('秘密にしたい取引先');
  });
});

describe('承認', () => {
  it('調べ終える前は承認できない', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(409);
  });

  it('残額を超える金額は通らない', async () => {
    const { requestId } = await reviewed();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: ORDER_TOTAL + 1, entitlementDisposition: 'revoke' })
      .expect(422);
  });

  it('0 円の返金は作れない', async () => {
    /*
      ⚠️ **422 ではなく 400。** 要求の形そのものが通っていない（金額の欄が
         正の整数を要る）。中身の判断まで届いていないので、区別できる形に
         しておく——画面は「打ち直してください」で同じだが、記録は違う。
    */
    const { requestId } = await reviewed();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: 0, entitlementDisposition: 'revoke' })
      .expect(400);
  });

  it('一部返金の金額を指定できる', async () => {
    const { requestId } = await reviewed();
    const approved = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: 3000, entitlementDisposition: 'keep' })
      .expect(201);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.amount).toBe(3000);
    // ⚠️ 一部返金では、受取権を残すか取り消すかを運営が指定する。
    expect(approved.body.entitlementDisposition).toBe('keep');
    expect(approved.body.isFullRefund).toBe(false);
  });

  it('原則対象外は、例外として通すと明示しなければ承認できない', async () => {
    const { requestId } = await reviewed('buyer_change_of_mind');
    const owner = ownerToken();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(owner))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(409);

    const approved = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(owner))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke', approveAsException: true })
      .expect(201);
    expect(approved.body.approvedAsException).toBe(true);
  });

  it('却下には理由が要る', async () => {
    const { requestId } = await reviewed();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/reject`)
      .set(auth(ownerToken()))
      .send({ rejectionNote: '' })
      // ⚠️ 400。要求の形で弾いている（空の理由は欄として通らない）。
      .expect(400);
  });

  it('承認済みは却下できない（両方立った申請は意味が取れない）', async () => {
    const { requestId } = await reviewed();
    const owner = ownerToken();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(owner))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/reject`)
      .set(auth(owner))
      .send({ rejectionNote: 'やはり返しません。' })
      .expect(409);
  });
});

describe('二重承認', () => {
  beforeEach(() => {
    // ⚠️ しきい値以上で 2 人目が要る。`null` は「使わない」の意味。
    harness.refundRequests.policy.set({
      creatorInquiryBusinessDays: 3,
      dualApprovalThresholdAmount: 10_000,
    });
  });

  it('しきい値以上では、申請した本人は承認できない', async () => {
    /*
      ⚠️ **承認の欄が 1 つ増えただけでは歯止めにならない。** 申請した人と
         承認する人が同じなら、二重承認の意味が無い。
    */
    const operator = actorToken('operator', 'self-approver', { isOwner: true });
    const buyer = actorToken('buyer', 'buyer-dual');
    const orderId = await paidOrder(buyer);
    const opened = await request(app.getHttpServer())
      .post(ADMIN)
      .set(auth(operator))
      .send({ orderId, reason: 'quality_issue' })
      .expect(201);
    const requestId = opened.body.id as string;

    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/investigate`)
      .set(auth(operator))
      .send({ note: '自分で受けて自分で調べました。' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(operator))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(409);
  });

  it('しきい値未満なら 1 人で承認できる', async () => {
    const { requestId } = await reviewed();
    const approved = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: 9999, entitlementDisposition: 'revoke' })
      .expect(201);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.dualApprovalRequired).toBe(false);
  });

  it('しきい値以上では 1 人目で承認待ちになり、別の人が押して承認される', async () => {
    const { requestId } = await reviewed();
    const first = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken('owner-first')))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(201);
    expect(first.body.status).toBe('approval_pending');

    // ⚠️ 1 人目が押し直しても進まない。
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken('owner-first')))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(409);

    const second = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken('owner-second')))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(201);
    expect(second.body.status).toBe('approved');
  });
});

describe('実行', () => {
  async function approved(amount = ORDER_TOTAL): Promise<string> {
    const { requestId } = await reviewed();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount, entitlementDisposition: 'revoke' })
      .expect(201);
    return requestId;
  }

  it('承認していなければ実行できない', async () => {
    const { requestId } = await reviewed();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/execute`)
      .set(auth(ownerToken()))
      .expect(409);
  });

  it('承認された額で事業者へ投げ、注文へ反映される', async () => {
    const requestId = await approved(4000);
    const result = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/execute`)
      .set(auth(ownerToken()))
      .expect(201);
    expect(result.body.request.status).toBe('executed');
    expect(result.body.amountRefunded).toBe(4000);
  });

  it('2 回押しても、事業者へは 1 回しか投げない', async () => {
    /*
      ⚠️ **ここが二重返金の歯止め。** `executing` を条件付き更新で取った
         ほうだけが進む。

      ⚠️ **符号（409）だけを確かめても足りない。** 全額を返したあとなら
         2 回目は「もう返し終えている」でも 409 になり、歯止めが外れて
         いても試験が通ってしまう。**一部返金**にして、事業者へ渡った
         回数——返金の**行の数**——を見る。
    */
    const requestId = await approved(4000);
    const owner = ownerToken();
    const first = await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/execute`)
      .set(auth(owner))
      .expect(201);
    const orderId = first.body.request.orderId as string;

    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/execute`)
      .set(auth(owner))
      .expect(409);

    const refunds = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${orderId}/refunds`)
      .set(auth(actorToken('auditor', 'refund-counter')))
      .expect(200);
    expect(refunds.body.items).toHaveLength(1);
    expect(refunds.body.items[0].amount).toBe(4000);
  });

  it('返金が済んだ注文には、新しい申し出を作れない', async () => {
    const buyer = actorToken('buyer', 'buyer-done');
    const orderId = await paidOrder(buyer);
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/refund-requests`)
      .set(auth(buyer))
      .send({ reason: 'quality_issue', statement: '返金をお願いします。' })
      .expect(201);
    const requestId = opened.body.id as string;
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/investigate`)
      .set(auth(actorToken('operator', 'investigator-3')))
      .send({ note: '確かめました。' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/execute`)
      .set(auth(ownerToken()))
      .expect(201);

    // ⚠️ 全額返し終えているので、残額が無い。
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/refund-requests`)
      .set(auth(buyer))
      .send({ reason: 'quality_issue', statement: 'もう一度お願いします。' })
      .expect(409);
  });
});

describe('設定が無い配備', () => {
  it('審査の設定が無ければ、承認を断る（既定値でそっと動かさない）', async () => {
    /*
      ⚠️ **しきい値を設定したつもりの配備で、二重承認が効いていない、
         という状態を作らない。** 手数料率で避けた形と同じ。
    */
    const { requestId } = await reviewed();
    harness.refundRequests.policy.clear();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(503);
  });
});

describe('見せるもの', () => {
  it('運営の注記と購入者の申し出を混ぜない', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/investigate`)
      .set(auth(actorToken('operator', 'investigator-4')))
      .send({ note: '運営の見立てです。' })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'reader-2')))
      .expect(200);
    expect(detail.body.note).toBe('運営の見立てです。');
    expect(detail.body.buyerStatement).toContain('説明と違い');
    expect(detail.body.remainingAmount).toBe(ORDER_TOTAL);
  });

  it('作家さまには金額と購入者を見せない', async () => {
    const { requestId } = await submitted();
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/ask-creator`)
      .set(auth(actorToken('operator', 'asker-7')))
      .send({})
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/api/v1/creator/refund-inquiries')
      .set(auth(actorToken('buyer', CREATOR_SUBJECT)))
      .expect(200);
    const item = mine.body.items[0];
    expect(item).not.toHaveProperty('amount');
    expect(item).not.toHaveProperty('buyerAccountId');
    // ⚠️ 事由と経緯は見せる。事実を答えていただくために要る。
    expect(item.reason).toBe('not_as_described');
  });

  it('売上からの戻しは、ご自分の分だけ', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/creator/receivables')
      .set(auth(actorToken('buyer', CREATOR_SUBJECT)))
      .expect(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.outstandingAmount).toBe(0);
  });
});

/**
 * 契約とドメインの並びが食い違っていないこと。
 *
 * ⚠️ **`web` は `@sengoku/domain` へ依存できない**（依存の向きの決まり）ので、
 * 事由と状態は契約の側で並べ直してある。**ずれると、画面で選べるのに
 * サーバーが受け付けない事由**ができる——確かめる場所がここしか無い。
 *
 * ⚠️ **`apps/api` は両方へ依存できる。** だからこの試験はここに置く。
 */
describe('契約とドメインの並び', () => {
  it('事由の並びが一致する', () => {
    expect([...REFUND_REQUEST_REASON_VALUES]).toEqual([...REFUND_REQUEST_REASONS]);
  });

  it('状態の並びが一致する', () => {
    expect([...REFUND_REQUEST_STATUS_VALUES]).toEqual([...REFUND_REQUEST_STATUSES]);
  });

  it('購入者が選べる事由が一致する', () => {
    expect([...BUYER_REFUND_REASON_VALUES]).toEqual([...BUYER_SELECTABLE_REFUND_REASONS]);
  });
});

/**
 * 誰がこの返金を被るか（決定 2026-08-22）。
 *
 * ⚠️ **これまで、事由を見ずに全部作家さまから差し引いていた。** 精算の
 * 差し戻しに事由の条件が無く、**こちらの不具合で返金した分まで作家さまの
 * 次回の売上から引いていた**。
 *
 * ⚠️ **画面で選ばせない。** 選べるようにすると、一度の操作で作家さまへ
 * 費用を寄せられてしまう——この決定が止めたかったのは、まさにそれである。
 */
describe('返金の負担者', () => {
  it('こちらの落ち度は運営が被ると、詳細に出る', async () => {
    const { requestId } = await submitted('system_failure');
    const detail = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-1')))
      .expect(200);
    expect(detail.body.clawbackBearer).toBe('platform');
  });

  it('作家さま起因は作家さまが負うと、詳細に出る', async () => {
    const { requestId } = await submitted('not_as_described');
    const detail = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-2')))
      .expect(200);
    expect(detail.body.clawbackBearer).toBe('creator');
  });

  it('例外として通すと、運営が被る側へ変わる', async () => {
    /*
      ⚠️ **運営の親切の代金を、作家さまに払わせない。** 規約では原則
         お受けしない事由を、運営の判断でお返しした——作家さまは何も
         間違えていない。
    */
    const { requestId } = await reviewed('buyer_change_of_mind');
    const before = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-3')))
      .expect(200);
    expect(before.body.clawbackBearer).toBe('creator');

    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({
        amount: ORDER_TOTAL,
        entitlementDisposition: 'revoke',
        approveAsException: true,
      })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-4')))
      .expect(200);
    expect(after.body.clawbackBearer).toBe('platform');
  });

  it('承認のときに負担者を選び直せる（決定 2026-08-22）', async () => {
    /*
      ⚠️ **実務では事由の表に当てはまらないことが起きる。** 決めるのは運営で、
         仕組みはその判断を**記録する**側に回る。
    */
    const { requestId } = await reviewed('not_as_described');
    const before = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-5')))
      .expect(200);
    expect(before.body.clawbackBearerDefault).toBe('creator');

    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({
        amount: ORDER_TOTAL,
        entitlementDisposition: 'revoke',
        clawbackBearer: 'platform',
      })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-6')))
      .expect(200);
    expect(after.body.clawbackBearer).toBe('platform');
    // ⚠️ 既定は動かない。何が既定だったかは、あとから読めるままにする。
    expect(after.body.clawbackBearerDefault).toBe('creator');
  });

  it('既定と違う値を選んだことが残る', async () => {
    /*
      ⚠️ **値だけ残しても、それが既定だったのか判断だったのかが読めない。**
         あとから「なぜこの作家さまが負担したのか」を説明するときに要る。
    */
    const { requestId } = await reviewed('not_as_described');
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({
        amount: ORDER_TOTAL,
        entitlementDisposition: 'revoke',
        clawbackBearer: 'platform',
      })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-7')))
      .expect(200);
    expect(detail.body.clawbackBearerOverridden).toBe(true);

    const approved = harness.refundRequests.requests.events.find(
      (event) => event.action === 'refund_request.approved',
    );
    expect(approved?.summary).toMatchObject({
      clawbackBearer: 'platform',
      clawbackBearerOverridden: true,
    });
  });

  it('既定のまま承認したら、変更の印は立たない', async () => {
    const { requestId } = await reviewed('not_as_described');
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({ amount: ORDER_TOTAL, entitlementDisposition: 'revoke' })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`${ADMIN}/${requestId}`)
      .set(auth(actorToken('operator', 'bearer-reader-8')))
      .expect(200);
    expect(detail.body.clawbackBearer).toBe('creator');
    expect(detail.body.clawbackBearerOverridden).toBe(false);
  });

  it('選び直した値が、操作の記録にも残る', async () => {
    // ⚠️ 証跡と監査ログの両方。読める人の範囲が違う。
    const { requestId } = await reviewed('not_as_described');
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({
        amount: ORDER_TOTAL,
        entitlementDisposition: 'revoke',
        clawbackBearer: 'platform',
      })
      .expect(201);

    const entry = harness.audit.entries.find((row) => row.action === 'refund_request.approve');
    expect(entry?.summary).toMatchObject({
      clawbackBearer: 'platform',
      clawbackBearerOverridden: true,
    });
  });

  it('知らない負担者は受け付けない', async () => {
    // ⚠️ 黙って既定へ落とさない。送った側は選んだつもりのまま違う結果になる。
    const { requestId } = await reviewed('not_as_described');
    await request(app.getHttpServer())
      .post(`${ADMIN}/${requestId}/approve`)
      .set(auth(ownerToken()))
      .send({
        amount: ORDER_TOTAL,
        entitlementDisposition: 'revoke',
        clawbackBearer: 'someone_else',
      })
      .expect(400);
  });
});
