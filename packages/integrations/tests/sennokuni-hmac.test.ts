import { describe, expect, it } from 'vitest';
import {
  canonicalString,
  signRequest,
  InMemoryNonceStore,
  SenNoKuniHmacVerifier,
  HMAC_HEADERS,
  TIMESTAMP_TOLERANCE_MS,
} from '../src/index';

/**
 * 千ノ国共通 HMAC v1.1 FINAL（確定回答書 2026-08-14 Q4）。
 *
 * ⚠️ このファイルの「固定テストベクトル」は **OVEW Wallet 側と共有する値**。
 * 片方だけ変えると、テストは通るのに実際の通信が成立しなくなる。
 * 値を変えるときは両システムを同時に変えること。
 */

// --- 固定テストベクトル（両システム共通） ------------------------------------

const VECTOR = {
  keyId: 'test-key-001',
  timestamp: '1786660000',
  nonce: 'nonce-fixed-001',
  method: 'POST',
  path: '/api/collectible-claims/test-token/confirm',
  rawBody: '{"common_user_id":"cu_0123456789abcdef0123456789abcdef"}',
  secret: 'test-secret',
  /** 期待される署名。**この値が両システムで一致することが相互接続の条件。** */
  signature: 'sha256=5d5dff59f51f7de3df54b541eb636e47b91cde8a0a79ccaccfcf34c0c28f9fe1',
} as const;

const GET_VECTOR = {
  keyId: 'test-key-001',
  timestamp: '1786660000',
  nonce: 'nonce-fixed-002',
  method: 'GET',
  path: '/api/collectible-claims/test-token',
  /** GET は本文が無い。**空文字で署名する。** */
  rawBody: '',
  secret: 'test-secret',
  signature: 'sha256=2b059e010615116377299b3526bf20e33161ad9c1cbce4ee552eb38a55e269ec',
} as const;

/** ベクトルの時刻ちょうど。時計を固定して検証する。 */
const VECTOR_NOW = new Date(Number(VECTOR.timestamp) * 1000);

describe('固定テストベクトル（OVEW Wallet と共有）', () => {
  it('POST の署名が期待値と一致する', () => {
    expect(signRequest(VECTOR.secret, VECTOR)).toBe(VECTOR.signature);
  });

  it('GET の署名が期待値と一致する（本文は空文字）', () => {
    expect(signRequest(GET_VECTOR.secret, GET_VECTOR)).toBe(GET_VECTOR.signature);
  });

  it('正準文字列が仕様どおりに並ぶ', () => {
    // 順序と区切りが仕様の本体なので、組み立て結果そのものを固定する。
    expect(canonicalString(VECTOR)).toBe(
      [
        'test-key-001',
        '1786660000',
        'nonce-fixed-001',
        'POST',
        '/api/collectible-claims/test-token/confirm',
        '{"common_user_id":"cu_0123456789abcdef0123456789abcdef"}',
      ].join('\n'),
    );
  });

  it('メソッドは大文字に揃える', () => {
    expect(signRequest(VECTOR.secret, { ...VECTOR, method: 'post' })).toBe(VECTOR.signature);
  });
});

describe('正準文字列の性質', () => {
  it('本文の空白やキー順が変われば署名も変わる', () => {
    // ⚠️ parse → stringify した文字列で署名すると、ここが一致しなくなる。
    const reserialized = JSON.stringify(JSON.parse(VECTOR.rawBody) as unknown);
    const spaced = '{ "common_user_id": "cu_0123456789abcdef0123456789abcdef" }';

    expect(reserialized).toBe(VECTOR.rawBody); // たまたま一致する場合もある
    expect(signRequest(VECTOR.secret, { ...VECTOR, rawBody: spaced })).not.toBe(VECTOR.signature);
  });

  it('要素を入れ替えても同じ署名にならない', () => {
    // 区切り文字を跨いだ「詰め替え」で同じ文字列を作れないこと。
    const shifted = canonicalString({
      ...VECTOR,
      keyId: 'test',
      nonce: 'key-001\n1786660000\nnonce-fixed-001',
    });
    expect(shifted).not.toBe(canonicalString(VECTOR));
  });
});

// --- 検証 --------------------------------------------------------------------

function headersFor(
  vector: typeof VECTOR | typeof GET_VECTOR,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    [HMAC_HEADERS.keyId]: vector.keyId,
    [HMAC_HEADERS.timestamp]: vector.timestamp,
    [HMAC_HEADERS.nonce]: vector.nonce,
    [HMAC_HEADERS.signature]: vector.signature,
    ...overrides,
  };
}

function verifier(): SenNoKuniHmacVerifier {
  return new SenNoKuniHmacVerifier({
    secrets: { 'test-key-001': 'test-secret' },
    nonces: new InMemoryNonceStore(),
  });
}

describe('署名の検証（確定回答書 §10 の拒否ケース）', () => {
  it('正しい署名を受け入れる', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keyId).toBe('test-key-001');
  });

  it('署名が無ければ拒否する', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR, { [HMAC_HEADERS.signature]: undefined }),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('missing_headers');
  });

  it('鍵IDが無ければ拒否する', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR, { [HMAC_HEADERS.keyId]: undefined }),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('missing_headers');
  });

  it('知らない鍵IDは拒否する', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR, { [HMAC_HEADERS.keyId]: 'unknown-key' }),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('unknown_key');
  });

  it('秘密鍵が違えば拒否する', async () => {
    const wrong = new SenNoKuniHmacVerifier({
      secrets: { 'test-key-001': 'another-secret' },
      nonces: new InMemoryNonceStore(),
    });
    const result = await wrong.verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('signature_mismatch');
  });

  it('本文が改ざんされていれば拒否する', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: '{"common_user_id":"cu_ffffffffffffffffffffffffffffffff"}',
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('signature_mismatch');
  });

  it('パスが改ざんされていれば拒否する', async () => {
    // 別のトークンへ署名を付け替えられないこと。
    const result = await verifier().verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: '/api/collectible-claims/another-token/confirm',
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('signature_mismatch');
  });

  it('メソッドが改ざんされていれば拒否する', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR),
      method: 'DELETE',
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('signature_mismatch');
  });

  it('数値でないタイムスタンプは拒否する', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR, { [HMAC_HEADERS.timestamp]: '17866600xx' }),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('malformed_timestamp');
  });

  it('古すぎるタイムスタンプは拒否する', async () => {
    const result = await verifier().verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: new Date(VECTOR_NOW.getTime() + TIMESTAMP_TOLERANCE_MS + 1000),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('timestamp_out_of_range');
  });

  it('未来すぎるタイムスタンプも拒否する', async () => {
    // 時計を進めた要求を貯めておけないようにする。
    const result = await verifier().verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: new Date(VECTOR_NOW.getTime() - TIMESTAMP_TOLERANCE_MS - 1000),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('timestamp_out_of_range');
  });
});

describe('nonce の再利用', () => {
  it('同じ nonce の 2 回目を拒否する', async () => {
    // 署名付きの要求をそのまま録画・再送されても通らないこと。
    const shared = verifier();
    const request = {
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    };

    const first = await shared.verify(request);
    expect(first.ok).toBe(true);

    const second = await shared.verify(request);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure).toBe('nonce_replayed');
  });

  it('署名が正しくないときは nonce を消費しない', async () => {
    // ⚠️ ここが逆だと、攻撃者が任意の nonce を先に使い潰せる。
    // 正規の相手が同じ nonce を使おうとしたときに弾かれてしまう。
    const shared = verifier();

    const tampered = await shared.verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: '{"tampered":true}',
      now: VECTOR_NOW,
    });
    expect(tampered.ok).toBe(false);

    // 同じ nonce で、正しい署名なら通ること。
    const legitimate = await shared.verify({
      headers: headersFor(VECTOR),
      method: VECTOR.method,
      path: VECTOR.path,
      rawBody: VECTOR.rawBody,
      now: VECTOR_NOW,
    });
    expect(legitimate.ok).toBe(true);
  });

  it('鍵IDが違えば同じ nonce を使える', async () => {
    const shared = new SenNoKuniHmacVerifier({
      secrets: { 'key-a': 'secret-a', 'key-b': 'secret-b' },
      nonces: new InMemoryNonceStore(),
    });

    for (const [keyId, secret] of [
      ['key-a', 'secret-a'],
      ['key-b', 'secret-b'],
    ] as const) {
      const input = { ...VECTOR, keyId };
      const result = await shared.verify({
        headers: {
          [HMAC_HEADERS.keyId]: keyId,
          [HMAC_HEADERS.timestamp]: VECTOR.timestamp,
          [HMAC_HEADERS.nonce]: VECTOR.nonce,
          [HMAC_HEADERS.signature]: signRequest(secret, input),
        },
        method: VECTOR.method,
        path: VECTOR.path,
        rawBody: VECTOR.rawBody,
        now: VECTOR_NOW,
      });
      expect(result.ok, keyId).toBe(true);
    }
  });
});

describe('鍵のローテーション', () => {
  it('新旧どちらの鍵でも受け入れる', async () => {
    // 無停止で鍵を切り替えるため、移行中は両方を受け付ける。
    const shared = new SenNoKuniHmacVerifier({
      secrets: { old: 'old-secret', new: 'new-secret' },
      nonces: new InMemoryNonceStore(),
    });

    for (const [keyId, secret] of [
      ['old', 'old-secret'],
      ['new', 'new-secret'],
    ] as const) {
      const result = await shared.verify({
        headers: {
          [HMAC_HEADERS.keyId]: keyId,
          [HMAC_HEADERS.timestamp]: VECTOR.timestamp,
          [HMAC_HEADERS.nonce]: `nonce-${keyId}`,
          [HMAC_HEADERS.signature]: signRequest(secret, {
            ...VECTOR,
            keyId,
            nonce: `nonce-${keyId}`,
          }),
        },
        method: VECTOR.method,
        path: VECTOR.path,
        rawBody: VECTOR.rawBody,
        now: VECTOR_NOW,
      });
      expect(result.ok, keyId).toBe(true);
    }
  });
});
