import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_VERIFICATION_LIMIT,
  acceptingGeneration,
  activateGeneration,
  canAcceptPayments,
  isErr,
  isOk,
  retireGeneration,
  unwrap,
  verificationOrder,
  type PaymentCredentialGeneration,
} from '../src/index';

const NOW = new Date('2026-08-19T00:00:00.000Z');

function generation(
  overrides: Partial<PaymentCredentialGeneration> = {},
): PaymentCredentialGeneration {
  return {
    id: `cred-${String(overrides.generation ?? 1)}`,
    provider: 'stripe',
    environment: 'production',
    generation: 1,
    status: 'active',
    accountRef: 'acct_old',
    label: null,
    apiVersion: null,
    lastCheckSucceeded: true,
    lastCheckAt: NOW,
    lastWebhookReceivedAt: null,
    acceptsNewPayments: true,
    activatedAt: NOW,
    retiredAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('新規受付の世代', () => {
  it('受付の印で選ぶ（新しさで選ばない）', () => {
    const older = generation({ generation: 1, acceptsNewPayments: true });
    const newer = generation({ generation: 2, acceptsNewPayments: false });
    // ⚠️ 切り替えの途中では「有効だが受付はしない」世代ができる。
    expect(acceptingGeneration([older, newer])?.generation).toBe(1);
  });

  /*
    ⚠️ **2 つあったら選ばない。** DB の部分UNIQUE が防いでいるが、
       そこが外れたときに「たまたま先頭」で入金先が決まるのは最悪。
  */
  it('受付世代が 2 つあれば選ばない', () => {
    const a = generation({ generation: 1 });
    const b = generation({ generation: 2 });
    expect(acceptingGeneration([a, b])).toBeNull();
    expect(canAcceptPayments([a, b])).toBe(false);
  });

  it('受付世代が無ければ売れない', () => {
    expect(canAcceptPayments([generation({ acceptsNewPayments: false })])).toBe(false);
  });

  it('pending は受付にならない', () => {
    const pending = generation({ status: 'pending', acceptsNewPayments: false });
    expect(acceptingGeneration([pending])).toBeNull();
  });
});

describe('署名検証で試す順序', () => {
  /*
    ⚠️ **退役した世代も試す。** 切り替え後も旧アカウントの知らせは届く。
       外すと、旧世代の決済が「署名が違う」として捨てられる。
  */
  it('retired も含める', () => {
    const rows = [
      generation({ generation: 1, status: 'retired', acceptsNewPayments: false }),
      generation({ generation: 2, acceptsNewPayments: true }),
    ];
    expect(verificationOrder(rows).map((row) => row.generation)).toEqual([2, 1]);
  });

  it('新しい世代から試す（速さのため。判定には影響しない）', () => {
    const rows = [1, 2, 3].map((n) => generation({ generation: n, acceptsNewPayments: false }));
    expect(verificationOrder(rows).map((row) => row.generation)).toEqual([3, 2, 1]);
  });

  it('上限を超えた古い世代は外れる', () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      generation({ generation: index + 1, acceptsNewPayments: false }),
    );
    const order = verificationOrder(rows);
    expect(order).toHaveLength(CREDENTIAL_VERIFICATION_LIMIT);
    expect(order.map((row) => row.generation)).toEqual([8, 7, 6, 5, 4]);
  });
});

describe('世代の有効化', () => {
  /*
    ⚠️ **接続確認を通っていない世代は有効化しない。** 二者承認をやめた
       代わりの守り。鍵の打ち間違いをここで止める。
  */
  it('接続確認を通っていなければ断る', () => {
    const target = generation({
      generation: 2,
      status: 'pending',
      acceptsNewPayments: false,
      lastCheckSucceeded: null,
    });
    const result = activateGeneration({ target, currentlyAccepting: null, now: NOW });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('PAYMENT_CREDENTIAL_CHECK_REQUIRED');
    }
  });

  it('接続確認に失敗していれば断る', () => {
    const target = generation({
      generation: 2,
      status: 'pending',
      acceptsNewPayments: false,
      lastCheckSucceeded: false,
    });
    expect(isErr(activateGeneration({ target, currentlyAccepting: null, now: NOW }))).toBe(true);
  });

  it('退役した世代は有効化できない', () => {
    const target = generation({ generation: 1, status: 'retired', acceptsNewPayments: false });
    const result = activateGeneration({ target, currentlyAccepting: null, now: NOW });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('PAYMENT_CREDENTIAL_NOT_ACTIVATABLE');
    }
  });

  /*
    ⚠️ **旧世代を `retired` にしない。** 返金と照会は旧世代の鍵で続く。
       ここで退役させると、切り替えた瞬間に過去の注文が返金不能になる。
  */
  it('旧世代は受付を降りるだけで、退役はしない', () => {
    const current = generation({ generation: 1 });
    const target = generation({
      generation: 2,
      status: 'pending',
      acceptsNewPayments: false,
      accountRef: 'acct_new',
    });

    const result = activateGeneration({ target, currentlyAccepting: current, now: NOW });
    expect(isOk(result)).toBe(true);
    const { activated, steppedDown } = unwrap(result);

    expect(activated.status).toBe('active');
    expect(activated.acceptsNewPayments).toBe(true);
    expect(steppedDown?.status).toBe('active');
    expect(steppedDown?.acceptsNewPayments).toBe(false);
    expect(steppedDown?.retiredAt).toBeNull();
  });

  it('1 本目は旧世代が無くても有効化できる', () => {
    const target = generation({ generation: 1, status: 'pending', acceptsNewPayments: false });
    const result = activateGeneration({ target, currentlyAccepting: null, now: NOW });
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).steppedDown).toBeNull();
  });

  it('すでに受付中の世代は有効化できない', () => {
    const current = generation({ generation: 1 });
    const result = activateGeneration({ target: current, currentlyAccepting: current, now: NOW });
    expect(isErr(result)).toBe(true);
  });
});

describe('世代の退役', () => {
  it('受付中の世代は退役させられない（販売が止まる）', () => {
    const result = retireGeneration(generation({ acceptsNewPayments: true }), NOW);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('PAYMENT_CREDENTIAL_IN_USE');
    }
  });

  it('受付を降りた世代は退役させられる', () => {
    const result = retireGeneration(generation({ acceptsNewPayments: false }), NOW);
    expect(isOk(result)).toBe(true);
    const retired = unwrap(result);
    expect(retired.status).toBe('retired');
    expect(retired.retiredAt).toEqual(NOW);
  });

  it('すでに退役していれば何も変えない', () => {
    const already = generation({ status: 'retired', acceptsNewPayments: false, retiredAt: NOW });
    expect(unwrap(retireGeneration(already, new Date('2026-09-01')))).toEqual(already);
  });
});
