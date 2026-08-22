import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDevToken, DevTokenVerifier, signWebhookPayload } from '@sengoku/integrations';
import type { Role } from '@sengoku/auth';
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
 * 返金の実行（`UD-104` / `UD-120`。決定 2026-08-20）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. お金が動く操作に、正しい人しか届かないこと
 *  2. **期限で当方の不具合を断らないこと**——自社の落ち度に「14 日を
 *     過ぎたので」と言うのは、消費者契約法上も商売としても通らない
 *  3. **`processing` の発行を取り消さないこと**（`INV-M4`）——外部へ
 *     送信済みの可能性があり、多重発行は回復できない
 *  4. **送信より先に記録すること**——落ちたときに「返金したのに記録が
 *     無い」を残さない
 *  5. **事業者の画面からの返金に追随し、二重に積まないこと**
 */

let app: INestApplication;
let harness: TestHarness;

const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_TOTAL = 12000;

function tokenFor(subject: string): string {
  return createDevToken(TEST_TOKEN_SECRET, {
    sub: subject,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    exp: Math.floor(TEST_NOW.getTime() / 1000) + 3600,
  });
}

function actorToken(role: Role, subject = `user-${role}`): string {
  harness.accounts.seed(subject, role);
  return tokenFor(subject);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 支払い済みの注文を 1 件用意する。⚠️ 決済確定は Webhook だけが行う。 */
async function paidOrder(): Promise<string> {
  harness.artworks.seed(sampleArtwork({ maxSupply: 3 }));
  harness.listings.seed(sampleListing({ id: LISTING_ID }));
  const buyer = actorToken('buyer');

  const created = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(auth(buyer))
    .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
    .expect(201);
  const orderId = created.body.order.id as string;

  await request(app.getHttpServer())
    .post(`/api/v1/orders/${orderId}/checkout-session`)
    .set(auth(buyer))
    .expect(201);

  await webhook({
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    data: { order_id: orderId, amount: ORDER_TOTAL, currency: 'jpy' },
  }).expect(200);

  return orderId;
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

function refund(orderId: string, token: string, body: Record<string, unknown> = {}) {
  return request(app.getHttpServer())
    .post(`/api/v1/admin/orders/${orderId}/refund`)
    .set(auth(token))
    .send({ reason: 'buyer_request', ...body });
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

describe('誰が返金できるか', () => {
  it('未認証では返金できない', async () => {
    const orderId = await paidOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/orders/${orderId}/refund`)
      .send({ reason: 'buyer_request' })
      .expect(401);
  });

  it('会員は返金できない', async () => {
    const orderId = await paidOrder();
    await refund(orderId, actorToken('buyer', 'buyer-2')).expect(403);
  });

  it('監査担当は返金できない（お金が動く操作）', async () => {
    const orderId = await paidOrder();
    await refund(orderId, actorToken('auditor')).expect(403);
  });

  it('監査担当でも返金の記録は読める（見えないと監査にならない）', async () => {
    const orderId = await paidOrder();
    await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${orderId}/refunds`)
      .set(auth(actorToken('auditor')))
      .expect(200);
  });

  it('運営は返金できる（オーナーの印を要らない）', async () => {
    /*
      ⚠️ **オーナー限定にしていない。** 問い合わせ対応の日常業務で、
         乗っ取られたときの被害も「払った本人のカードへ戻る」であって
         攻撃者の利得にならない。`payment_credential.manage` とは重さが違う。
    */
    const orderId = await paidOrder();
    await refund(orderId, actorToken('operator')).expect(201);
  });
});

describe('返金してよいか', () => {
  it('お支払い前の注文は返金できない', async () => {
    harness.artworks.seed(sampleArtwork({ maxSupply: 3 }));
    harness.listings.seed(sampleListing({ id: LISTING_ID }));
    const buyer = actorToken('buyer');
    const created = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set(auth(buyer))
      .send({ listingId: LISTING_ID, idempotencyKey: randomUUID() })
      .expect(201);

    const response = await refund(created.body.order.id as string, actorToken('operator')).expect(
      409,
    );
    expect(response.body.error.code).toBe('REFUND_NOT_ALLOWED');
  });

  it('二度目は断る（二重返金にしない）', async () => {
    const orderId = await paidOrder();
    const operator = actorToken('operator');
    await refund(orderId, operator).expect(201);

    const second = await refund(orderId, operator).expect(409);
    expect(second.body.error.code).toBe('REFUND_ALREADY_DONE');
  });

  it('期限を過ぎたお申し出は断る', async () => {
    const orderId = await paidOrder();
    // 焼き付けた期限を過ぎたところまで時計を進める。
    harness.clock.set(new Date(TEST_NOW.getTime() + 20 * 86_400_000));

    const response = await refund(orderId, actorToken('operator')).expect(409);
    expect(response.body.error.code).toBe('REFUND_WINDOW_CLOSED');
  });

  it('当方の不具合は、期限を過ぎていても返金できる', async () => {
    /*
      ⚠️ **ここを期限で断ると、自社の落ち度を期限で断ることになる。**
         消費者契約法上も、商売としても通らない。
    */
    const orderId = await paidOrder();
    harness.clock.set(new Date(TEST_NOW.getTime() + 200 * 86_400_000));

    await refund(orderId, actorToken('operator'), { reason: 'our_fault' }).expect(201);
  });
});

describe('発行がどこまで進んだか', () => {
  it('発行処理中は、機械では決めない', async () => {
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'claimed';
    harness.refunds.mintStatus = 'processing';

    const response = await refund(orderId, actorToken('operator')).expect(409);
    // ⚠️ 「返金できない」ではない。判断のうえで返すことはある。
    expect(response.body.error.code).toBe('REFUND_NEEDS_REVIEW');
  });

  it('承知のうえなら進める。ただし発行処理は取り消さない（`INV-M4`）', async () => {
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'claimed';
    harness.refunds.mintStatus = 'processing';

    const response = await refund(orderId, actorToken('operator'), {
      acknowledgeIssued: true,
    }).expect(201);

    // ⚠️ 外部へ送信済みの可能性がある。取り消すと多重発行になる。
    expect(response.body.cancelledMintJobs).toBe(0);
    expect(response.body.annotatedMintJobs).toBe(1);
    expect(harness.refunds.mintStatus).toBe('processing');
  });

  it('発行待ちなら、発行の依頼を取り消す', async () => {
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'claimed';
    harness.refunds.mintStatus = 'queued';

    const response = await refund(orderId, actorToken('operator')).expect(201);
    expect(response.body.cancelledMintJobs).toBe(1);
    expect(harness.refunds.mintStatus).toBe('cancelled');
  });

  it('まだ受け取っていなければ、受取権ごと取り消す', async () => {
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'issued';

    const response = await refund(orderId, actorToken('operator')).expect(201);
    expect(response.body.revokedEntitlements).toBe(1);
    expect(harness.refunds.entitlementStatus).toBe('revoked');
  });

  it('受取り済みなら、受取権は取り消さない', async () => {
    // ⚠️ 受け取った事実は起きたこと。記録から消さない。
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'claimed';

    const response = await refund(orderId, actorToken('operator')).expect(201);
    expect(response.body.revokedEntitlements).toBe(0);
    expect(harness.refunds.entitlementStatus).toBe('claimed');
  });
});

describe('記録', () => {
  it('返金すると、注文が返金済みになる', async () => {
    const orderId = await paidOrder();
    const response = await refund(orderId, actorToken('operator')).expect(201);

    expect(response.body.refundStatus).toBe('refunded');
    expect(response.body.amountRefunded).toBe(ORDER_TOTAL);
  });

  it('誰がどの理由で返したかを残す', async () => {
    const orderId = await paidOrder();
    await refund(orderId, actorToken('operator', 'operator-7'), {
      reason: 'our_fault',
      note: '発行に失敗したため',
    }).expect(201);

    const listed = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${orderId}/refunds`)
      .set(auth(actorToken('operator')))
      .expect(200);

    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      status: 'succeeded',
      reason: 'our_fault',
      initiatedBy: 'admin',
      // ⚠️ 認証の subject ではなく、こちらのアカウントID。
      actorAccountId: 'account-operator-7',
      note: '発行に失敗したため',
    });
  });

  it('監査ログに残す', async () => {
    const orderId = await paidOrder();
    await refund(orderId, actorToken('operator')).expect(201);

    const entry = harness.audit.entries.find((row) => row.action === 'refund.succeeded');
    expect(entry).toBeDefined();
    expect(entry?.summary).toMatchObject({ amount: ORDER_TOTAL, reason: 'buyer_request' });
  });

  it('金額を本文から受け取らない（額の指定は無視される）', async () => {
    /*
      ⚠️ **一部返金は自動処理しない決定**（`UD-104`）。額を受け取る口が
         無いことを、ここで固定しておく。作られると、桁を 1 つ多く打った
         操作がそのまま通るようになる。
    */
    const orderId = await paidOrder();
    const response = await refund(orderId, actorToken('operator'), { amount: 1 }).expect(201);
    expect(response.body.refund.amount).toBe(ORDER_TOTAL);
  });
});

describe('事業者へ届かなかったとき', () => {
  it('記録は残し、成功にしない', async () => {
    /*
      ⚠️ **記録が先、送信があと。** 送信してから記録すると、途中で落ちた
         ときに「返金したのに記録が無い」が残る。逆（記録だけ残って送信
         していない）は `failed` として洗い出せる。
    */
    const orderId = await paidOrder();
    // 事業者側の識別子を消す。⚠️ 擬似ゲートウェイは本物と同じ所で断る。
    harness.refunds.paymentRefOverride = null;

    const response = await refund(orderId, actorToken('operator')).expect(502);
    expect(response.body.error.code).toBe('REFUND_PROVIDER_ERROR');

    const rows = harness.refunds.all;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
  });
});

describe('事業者の画面からの返金に追随する', () => {
  function refundedEvent(orderId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `evt_${randomUUID()}`,
      type: 'payment.refunded',
      data: {
        order_id: orderId,
        amount: ORDER_TOTAL,
        currency: 'jpy',
        refund_ref: 're_1',
        refunded_total: ORDER_TOTAL,
        ...overrides,
      },
    };
  }

  it('全額返金の知らせで、注文が返金済みになる', async () => {
    const orderId = await paidOrder();
    await webhook(refundedEvent(orderId)).expect(200);

    const rows = harness.refunds.all;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'succeeded',
      initiatedBy: 'provider',
      // ⚠️ 運営の誰かを紐づけない。こちらを経由していない返金である。
      actorAccountId: null,
      amount: ORDER_TOTAL,
    });
  });

  it('全額返金なら、代理店へ渡す出来事を積む', async () => {
    const orderId = await paidOrder();
    await webhook(refundedEvent(orderId)).expect(200);

    /*
      ⚠️ **いま送る先は無い。** 行が溜まるだけである（`UD-1003` が
         決まるまで）。それでも**起きた時点で積む**——あとから
         `refunds` を読めば「いつ返金になったか」は組み直せるが、
         そのとき積むはずだった出来事は作り直せない。
    */
    expect(harness.refunds.agencyRefundEvents.has(orderId)).toBe(true);
  });

  it('一部返金では、代理店へ渡す出来事を積まない', async () => {
    const orderId = await paidOrder();
    await webhook(
      refundedEvent(orderId, { refunded_total: 3000, refund_ref: 're_part_agency' }),
    ).expect(200);

    /*
      ⚠️ **一部返金は「返金された注文」ではない。** 積むと、受け取る側が
         売上を丸ごと取り消す判断をしうる。
    */
    expect(harness.refunds.agencyRefundEvents.has(orderId)).toBe(false);
  });

  it('同じ返金の知らせが 2 回来ても、二重に積まない', async () => {
    const orderId = await paidOrder();
    await webhook(refundedEvent(orderId)).expect(200);
    // ⚠️ イベントIDは別。事業者は同じ返金を別のイベントで再送しうる。
    await webhook(refundedEvent(orderId)).expect(200);

    expect(harness.refunds.all).toHaveLength(1);
  });

  it('こちらから投げた返金の知らせが来ても、二重に積まない', async () => {
    const orderId = await paidOrder();
    await refund(orderId, actorToken('operator')).expect(201);
    /*
      ⚠️ **事業者側の識別子は API から出していない。** 運用に要るのは
         状態と金額までで、識別子を画面へ出す理由が無い。ここは記録から
         直接取る。
    */
    const ourRef = harness.refunds.all[0]?.providerRefundRef;

    await webhook(refundedEvent(orderId, { refund_ref: ourRef })).expect(200);
    expect(harness.refunds.all).toHaveLength(1);
  });

  it('一部返金では、渡したものを取り消さない', async () => {
    /*
      ⚠️ **一部返金は自動処理しない**（`UD-104`）。金額だけを記録する。
         全部返ってはじめて、渡したものを取り消す判断になる。
    */
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'issued';

    await webhook(refundedEvent(orderId, { refunded_total: 3000, refund_ref: 're_part' })).expect(
      200,
    );

    expect(harness.refunds.entitlementStatus).toBe('issued');
    const rows = harness.refunds.all;
    expect(rows[0]?.amount).toBe(3000);
  });

  it('累計が増えていなければ何もしない', async () => {
    const orderId = await paidOrder();
    await webhook(refundedEvent(orderId, { refunded_total: 0, refund_ref: 're_zero' })).expect(200);
    expect(harness.refunds.all).toHaveLength(0);
  });

  it('累計が読めない知らせでは金額を動かさない', async () => {
    // ⚠️ 推測で埋めない。埋めると、返っていない額を返金済みにする。
    const orderId = await paidOrder();
    await webhook(refundedEvent(orderId, { refunded_total: undefined })).expect(200);
    expect(harness.refunds.all).toHaveLength(0);
  });
});

describe('チャージバック（決済の争い）', () => {
  function disputeEvent(orderId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `evt_${randomUUID()}`,
      type: 'payment.disputed',
      data: {
        order_id: orderId,
        currency: 'jpy',
        dispute_ref: 'dp_1',
        dispute_status: 'needs_response',
        dispute_amount: ORDER_TOTAL,
        dispute_reason: 'fraudulent',
        ...overrides,
      },
    };
  }

  it('申し立てを受けても、渡したものを取り消さない', async () => {
    /*
      ⚠️ **争いが起きたことと、返金されたことは別である。** ここで
         取り消すと、**こちらが勝ったときに返せない**——外部のウォレットへ
         渡したものは、こちらからは戻せない。
    */
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'issued';

    await webhook(disputeEvent(orderId)).expect(200);

    expect(harness.refunds.entitlementStatus).toBe('issued');
    // ⚠️ 返金も積まない。まだ何も返っていない。
    expect(harness.refunds.all).toHaveLength(0);
  });

  it('申し立てを記録する', async () => {
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId)).expect(200);

    const dispute = await harness.disputes.findByRef('fake', 'dp_1');
    expect(dispute).not.toBeNull();
    expect(dispute?.status).toBe('needs_response');
    expect(dispute?.orderId).toBe(orderId);
    expect(dispute?.closedAt).toBeNull();
  });

  it('勝っても返金にしない', async () => {
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'issued';

    await webhook(disputeEvent(orderId)).expect(200);
    await webhook(disputeEvent(orderId, { dispute_status: 'won' })).expect(200);

    const dispute = await harness.disputes.findByRef('fake', 'dp_1');
    expect(dispute?.status).toBe('won');
    expect(dispute?.refundId).toBeNull();
    expect(harness.refunds.all).toHaveLength(0);
    // ⚠️ 取り消していないので、そのまま残っている。
    expect(harness.refunds.entitlementStatus).toBe('issued');
  });

  it('負けたら返金として記録し、渡したものを取り消す', async () => {
    /*
      ⚠️ **敗訴の時点で、もう引かれている。** 記録しないと、帳簿の上では
         持っていないお金を持っていることになり、**作家さまへその分まで
         お支払いする**。
      ⚠️ **`charge.refunded` は届かない。** ここで記録しなければ、
         どこにも残らない。
    */
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'issued';

    await webhook(disputeEvent(orderId)).expect(200);
    await webhook(disputeEvent(orderId, { dispute_status: 'lost' })).expect(200);

    const rows = harness.refunds.all;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      initiatedBy: 'provider',
      // ⚠️ 運営の誰かを紐づけない。こちらを経由していない返金である。
      actorAccountId: null,
      amount: ORDER_TOTAL,
      reason: 'provider_initiated',
    });
    expect(harness.refunds.entitlementStatus).toBe('revoked');
  });

  it('負けた返金の事由は `provider_initiated`（＝運営が被る）', async () => {
    /*
      ⚠️ **場を開いている側が備える筋のもの。** 作家さまへ転嫁すると、
         身に覚えのないカード不正で作家さまの売上が削られる。

      ⚠️ **ここで見るのは事由まで。** 負担者そのものは事由から決まり
         （`clawbackBearerForRefundReason`）、列に書くのは DB の
         リポジトリである。`RefundRecordView` は負担者を持たないので、
         **事由が正しいこと**を押さえる——ここが `buyer_request` に
         化けたら、作家さまの売上から引かれる。
    */
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId)).expect(200);
    await webhook(disputeEvent(orderId, { dispute_status: 'lost' })).expect(200);

    expect(harness.refunds.all[0]?.reason).toBe('provider_initiated');
  });

  it('返金の行と争いの行を結ぶ', async () => {
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId)).expect(200);
    await webhook(disputeEvent(orderId, { dispute_status: 'lost' })).expect(200);

    const dispute = await harness.disputes.findByRef('fake', 'dp_1');
    expect(dispute?.refundId).toBe(harness.refunds.all[0]?.id);
  });

  it('敗訴の知らせが 2 回来ても、返金を 2 回積まない', async () => {
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId, { dispute_status: 'lost' })).expect(200);
    // ⚠️ イベントIDは別。事業者は同じ決着を別のイベントで再送しうる。
    await webhook(disputeEvent(orderId, { dispute_status: 'lost' })).expect(200);

    expect(harness.refunds.all).toHaveLength(1);
  });

  it('決着したあとに古い知らせが届いても、開き直さない', async () => {
    /*
      ⚠️ **事業者の知らせは前後して届く。** 開き直すと、精算が理由なく
         止まり続ける。
    */
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId, { dispute_status: 'lost' })).expect(200);
    await webhook(disputeEvent(orderId, { dispute_status: 'needs_response' })).expect(200);

    const dispute = await harness.disputes.findByRef('fake', 'dp_1');
    expect(dispute?.status).toBe('lost');
    expect(harness.refunds.all).toHaveLength(1);
  });

  it('警告だけでは何も起きない', async () => {
    /*
      ⚠️ **カード会社が調べ始めただけ。** 申し立てにならずに消えることも
         ある。争いと同じ扱いにすると、消えた警告のぶんまで精算を止める。
    */
    const orderId = await paidOrder();
    harness.refunds.entitlementStatus = 'issued';

    await webhook(disputeEvent(orderId, { dispute_status: 'warning' })).expect(200);

    const dispute = await harness.disputes.findByRef('fake', 'dp_1');
    expect(dispute?.status).toBe('warning');
    expect(harness.refunds.all).toHaveLength(0);
    expect(harness.refunds.entitlementStatus).toBe('issued');
  });

  it('知らない状態の知らせは、記録に残して無視する', async () => {
    // ⚠️ 推測で進めるより、無視して記録に残すほうがよい。
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId, { dispute_status: 'maybe_lost' })).expect(200);

    await expect(harness.disputes.findByRef('fake', 'dp_1')).resolves.toBeNull();
    expect(harness.refunds.all).toHaveLength(0);
  });

  it('識別子の無い知らせでは記録しない', async () => {
    // ⚠️ 推測で埋めない。識別子が無ければ 1 行に束ねられない。
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId, { dispute_ref: undefined })).expect(200);

    expect(harness.disputes.rows.size).toBe(0);
  });

  it('争いは 1 行に束ねる（申し立て → 審理 → 決着）', async () => {
    const orderId = await paidOrder();
    await webhook(disputeEvent(orderId)).expect(200);
    await webhook(disputeEvent(orderId, { dispute_status: 'under_review' })).expect(200);
    await webhook(disputeEvent(orderId, { dispute_status: 'lost' })).expect(200);

    expect(harness.disputes.rows.size).toBe(1);
  });
});
