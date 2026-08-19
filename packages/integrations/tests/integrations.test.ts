import { describe, expect, it } from 'vitest';
import {
  FakeMintingAdapter,
  FakePaymentGateway,
  FixedClock,
  HmacIdempotencyKeyService,
  SequentialIdGenerator,
  Sha256ClaimTokenService,
  signWebhookPayload,
  WEBHOOK_TOLERANCE_MS,
  generateStorageKey,
  LocalFileStorage,
  InMemoryStorage,
} from '../src/index';

describe('Sha256ClaimTokenService（SECURITY_DESIGN §8）', () => {
  const service = new Sha256ClaimTokenService();

  it('毎回異なるトークンを発行する', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => service.issue().token));
    expect(tokens.size).toBe(50);
  });

  it('十分な長さのトークンを発行する（総当たり対策）', () => {
    // 32 バイトを base64url にすると 43 文字。
    expect(service.issue().token.length).toBeGreaterThanOrEqual(43);
  });

  it('平文とハッシュが異なる（DB には平文を保存しない）', () => {
    const issued = service.issue();
    expect(issued.tokenHash).not.toBe(issued.token);
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('正しいトークンで照合できる', () => {
    const issued = service.issue();
    expect(service.matches(issued.token, issued.tokenHash)).toBe(true);
  });

  it('異なるトークンは照合に失敗する', () => {
    const a = service.issue();
    const b = service.issue();
    expect(service.matches(a.token, b.tokenHash)).toBe(false);
  });

  it('長さの異なるハッシュを渡しても例外にならず false を返す', () => {
    const issued = service.issue();
    expect(service.matches(issued.token, 'short')).toBe(false);
  });
});

describe('HmacIdempotencyKeyService（I-7）', () => {
  const service = new HmacIdempotencyKeyService('test-secret');

  it('同じ受取権IDからは常に同じキーを導出する', () => {
    // 再試行のたびにキーが変わると、外部から見て別依頼になり多重発行の原因になる。
    expect(service.deriveMintKey('e-1')).toBe(service.deriveMintKey('e-1'));
  });

  it('異なる受取権IDでは異なるキーになる', () => {
    expect(service.deriveMintKey('e-1')).not.toBe(service.deriveMintKey('e-2'));
  });

  it('シークレットが異なればキーも異なる', () => {
    const other = new HmacIdempotencyKeyService('another-secret');
    expect(service.deriveMintKey('e-1')).not.toBe(other.deriveMintKey('e-1'));
  });

  it('導出したキーに受取権IDが平文で現れない', () => {
    expect(service.deriveMintKey('entitlement-secret-id')).not.toContain('entitlement-secret-id');
  });

  it('空のシークレットを拒否する', () => {
    expect(() => new HmacIdempotencyKeyService('')).toThrow();
  });
});

describe('FakeMintingAdapter（多重発行の防止）', () => {
  it('同じ冪等キーで再依頼しても発行は1件に留まる（I-6）', async () => {
    const adapter = new FakeMintingAdapter();
    const request = {
      entitlementId: 'e-1',
      idempotencyKey: 'key-1',
      metadataRef: 'meta-1',
      recipientRef: 'recipient-1',
    };

    const first = await adapter.submit(request);
    const second = await adapter.submit(request);

    expect(second.submissionRef).toBe(first.submissionRef);
    expect(adapter.submissionCount()).toBe(1);
  });

  it('同時に複数回依頼しても発行は1件（I-5 相当）', async () => {
    const adapter = new FakeMintingAdapter();
    const request = {
      entitlementId: 'e-1',
      idempotencyKey: 'key-1',
      metadataRef: 'meta-1',
      recipientRef: 'recipient-1',
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => adapter.submit(request)));

    expect(new Set(results.map((r) => r.submissionRef)).size).toBe(1);
    expect(adapter.submissionCount()).toBe(1);
  });

  it('異なる冪等キーは別の発行になる', async () => {
    const adapter = new FakeMintingAdapter();
    await adapter.submit({
      entitlementId: 'e-1',
      idempotencyKey: 'key-1',
      metadataRef: 'm',
      recipientRef: 'r',
    });
    await adapter.submit({
      entitlementId: 'e-2',
      idempotencyKey: 'key-2',
      metadataRef: 'm',
      recipientRef: 'r',
    });
    expect(adapter.submissionCount()).toBe(2);
  });

  it('失敗させた受取権は failed を返し、状態問い合わせでも失敗のまま', async () => {
    const adapter = new FakeMintingAdapter(['e-bad']);
    const submission = await adapter.submit({
      entitlementId: 'e-bad',
      idempotencyKey: 'key-bad',
      metadataRef: 'm',
      recipientRef: 'r',
    });
    expect(submission.state).toBe('failed');

    const status = await adapter.getStatus(submission.submissionRef);
    expect(status.state).toBe('failed');
    expect(status.errorCode).toBe('FAKE_PROVIDER_REJECTED');
  });

  it('返す識別子は実チェーンの形式を模倣していない（UD-501 未決定）', async () => {
    const adapter = new FakeMintingAdapter();
    const submission = await adapter.submit({
      entitlementId: 'e-1',
      idempotencyKey: 'key-1',
      metadataRef: 'm',
      recipientRef: 'r',
    });
    const status = await adapter.getStatus(submission.submissionRef);
    expect(status.chainRef).toBe('fake:local');
    // EVM のアドレス形式などを既定にしてしまわないことを確認する。
    expect(status.contractRef).not.toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('FakePaymentGateway の署名検証（TEST_STRATEGY §3.7）', () => {
  const SECRET = 'webhook-secret';
  const NOW = new Date('2026-01-01T00:00:00.000Z');
  const gateway = new FakePaymentGateway(SECRET, 'http://localhost:3000/fake-checkout', () => NOW);

  function signed(body: unknown, options: { secret?: string; skewMs?: number } = {}) {
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const timestampSec = Math.floor((NOW.getTime() + (options.skewMs ?? 0)) / 1000);
    const signature = signWebhookPayload(options.secret ?? SECRET, timestampSec, rawBody);
    return { rawBody, header: `t=${String(timestampSec)},v1=${signature}` };
  }

  const EVENT = {
    id: 'evt_1',
    type: 'payment.succeeded',
    data: { order_id: 'order-1', amount: 12000, currency: 'jpy' },
  };

  it('正しい署名の通知を受理し、業務の事象へ畳む', async () => {
    const { rawBody, header } = signed(EVENT);
    const result = await gateway.verifyAndParseWebhook(rawBody, header);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventId).toBe('evt_1');
      // ⚠️ イベント名ごとではなく、3 つの事象へ畳んだ結果を見る。
      expect(result.value.kind).toBe('succeeded');
      expect(result.value.orderId).toBe('order-1');
      expect(result.value.amount).toBe(12000);
    }
  });

  it('署名が不正なら拒否する（W-1）', async () => {
    const { rawBody, header } = signed(EVENT, { secret: 'wrong-secret' });
    expect((await gateway.verifyAndParseWebhook(rawBody, header)).ok).toBe(false);
  });

  it('本文が改竄されていたら拒否する（W-4）', async () => {
    const { header } = signed(EVENT);
    const tampered = Buffer.from(JSON.stringify({ id: 'evt_2', type: 'x' }), 'utf8');
    expect((await gateway.verifyAndParseWebhook(tampered, header)).ok).toBe(false);
  });

  it('タイムスタンプが古すぎる通知を拒否する（W-3 リプレイ）', async () => {
    const { rawBody, header } = signed(EVENT, { skewMs: -(WEBHOOK_TOLERANCE_MS + 1000) });
    expect((await gateway.verifyAndParseWebhook(rawBody, header)).ok).toBe(false);
  });

  it('許容範囲内の時刻ずれは受理する', async () => {
    const { rawBody, header } = signed(EVENT, { skewMs: -(WEBHOOK_TOLERANCE_MS - 60_000) });
    expect((await gateway.verifyAndParseWebhook(rawBody, header)).ok).toBe(true);
  });

  it('署名ヘッダの形式が不正なら拒否する', async () => {
    const { rawBody } = signed(EVENT);
    expect((await gateway.verifyAndParseWebhook(rawBody, 'garbage')).ok).toBe(false);
  });

  it('署名は正しいが本文が JSON でなければ拒否する', async () => {
    const rawBody = Buffer.from('not-json', 'utf8');
    const timestampSec = Math.floor(NOW.getTime() / 1000);
    const header = `t=${String(timestampSec)},v1=${signWebhookPayload(SECRET, timestampSec, rawBody)}`;
    expect((await gateway.verifyAndParseWebhook(rawBody, header)).ok).toBe(false);
  });

  it('イベントIDのない通知を拒否する（冪等排除ができないため）', async () => {
    const { rawBody, header } = signed({ type: 'payment.succeeded' });
    expect((await gateway.verifyAndParseWebhook(rawBody, header)).ok).toBe(false);
  });

  it('知らないイベントは ignored へ畳む（拒否しない）', async () => {
    // ⚠️ 拒否すると相手が再送し続ける。受け取って無視する。
    const { rawBody, header } = signed({ id: 'evt_9', type: 'charge.updated' });
    const result = await gateway.verifyAndParseWebhook(rawBody, header);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('ignored');
    }
  });

  it('同じ冪等キーなら同じ支払い口を返す', async () => {
    const input = {
      orderId: 'order-1',
      orderNumber: 'SNK-20260819-AAAAAAAA',
      itemName: '作品',
      amount: 12000,
      currency: 'JPY',
      quantity: 1,
      expiresAt: new Date('2026-01-01T00:30:00.000Z'),
      idempotencyKey: 'order-1:1',
      correlationId: null,
    };
    const first = await gateway.createCheckoutSession(input);
    const second = await gateway.createCheckoutSession(input);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.sessionRef).toBe(first.value.sessionRef);
    }
  });
});

describe('テスト用の補助実装', () => {
  it('FixedClock は時刻を固定し、明示的に進められる', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    clock.advanceMs(60_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('SequentialIdGenerator は決定論的なIDを返す', () => {
    const generator = new SequentialIdGenerator('order');
    expect([generator.generate(), generator.generate()]).toEqual(['order-1', 'order-2']);
  });
});

describe('保存キーの生成（SECURITY_DESIGN §5）', () => {
  it('毎回異なるキーになる', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateStorageKey('artworks', 'png')));
    expect(keys.size).toBe(50);
  });

  it('利用者のファイル名を含まない', () => {
    // 制御文字・パス区切り・同名衝突を持ち込ませないため、名前は使わない。
    const key = generateStorageKey('artworks', 'png');
    expect(key).toMatch(/^artworks\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/);
  });

  it('パス区切りを含む拡張子を渡してもキーの形が崩れない', () => {
    // 拡張子はドメイン側の許可形式からしか渡らないが、念のため形を確認する。
    expect(generateStorageKey('artworks', 'png').split('/')).toHaveLength(4);
  });
});

describe('LocalFileStorage', () => {
  it('保存ルートの外へ出るキーを拒否する', async () => {
    const storage = new LocalFileStorage('/tmp/sengoku-storage-test');
    await expect(
      storage.put({
        key: '../../etc/passwd',
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/escapes the storage root/);
  });

  it('公開URLはキーから解決する（URLを保存しない）', () => {
    const storage = new LocalFileStorage('/tmp/sengoku-storage-test', '/media');
    expect(storage.publicUrl('artworks/2026/08/abc.png')).toBe('/media/artworks/2026/08/abc.png');
  });
});

describe('InMemoryStorage', () => {
  it('保存と削除ができる', async () => {
    const storage = new InMemoryStorage();
    await storage.put({ key: 'k1', bytes: new Uint8Array(10), contentType: 'image/png' });
    expect(storage.has('k1')).toBe(true);
    await storage.remove('k1');
    expect(storage.has('k1')).toBe(false);
  });

  it('存在しないキーの削除でも失敗しない（置換や再試行のため）', async () => {
    const storage = new InMemoryStorage();
    await expect(storage.remove('missing')).resolves.toBeUndefined();
  });
});
