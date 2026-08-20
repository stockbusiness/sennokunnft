import { describe, expect, it } from 'vitest';
import {
  buildGrantedEvent,
  buildRevokedEvent,
  canManuallyResend,
  decideDelivery,
  errorCodeFor,
  formatSerialNumber,
  isLongLivedImageUrl,
  isRetryable,
  RETRY_BACKOFF_MINUTES,
  SOURCE_SYSTEM_KEY,
  TARGET_SITE_KEY,
  WALLET_DELIVERY_MAX_ATTEMPTS,
  WALLET_GRANTED_EVENT_VERSION,
  WALLET_REVOKED_EVENT_VERSION,
  type WalletGrantedEventInput,
} from '../src/index';

const COMMON_USER_ID = `cu_${'0123456789abcdef'.repeat(2)}`;
const IMAGE_HASH = `sha256:${'a'.repeat(64)}`;

function grantedInput(overrides: Partial<WalletGrantedEventInput> = {}): WalletGrantedEventInput {
  return {
    eventId: 'evt_00000000-0000-4000-8000-000000000000',
    occurredAt: new Date('2026-08-14T08:00:00.000Z'),
    correlationId: 'corr_0123456789',
    commonUserId: COMMON_USER_ID,
    entitlementId: 'ent-1',
    orderId: 'order-1',
    orderLineId: 'line-1',
    artworkId: 'artwork-1',
    artworkTitle: '天下布武の陣羽織',
    artworkDescription: '説明文',
    imageUrl: 'https://media-stg.example.jp/artworks/abc.png',
    thumbnailUrl: null,
    imageHash: IMAGE_HASH,
    serialNo: 1,
    ...overrides,
  };
}

describe('シリアル番号の表記（§5）', () => {
  // ⚠️ この規則を後から変えると、既に Wallet へ送った Holding の表示と
  //    食い違い、同じ 1 枚が別の番号で 2 通りに見える。
  it.each([
    [1, '0001'],
    [7, '0007'],
    [34, '0034'],
    [9999, '9999'],
    [10000, '10000'],
    [123456, '123456'],
  ])('%i を %s と表記する', (input, expected) => {
    expect(formatSerialNumber(input)).toBe(expected);
  });

  it('固定4桁ではなく「最低4桁」である（5桁以上を切り詰めない）', () => {
    expect(formatSerialNumber(10000)).toHaveLength(5);
  });
});

describe('画像URLの受け入れ（§4-2）', () => {
  it('https の公開ホストは通す', () => {
    expect(isLongLivedImageUrl('https://media-stg.example.jp/artworks/a.png')).toBe(true);
  });

  it.each([
    ['http', 'http://media.example.jp/a.png'],
    ['localhost', 'https://localhost/a.png'],
    ['file スキーム', 'file:///tmp/a.png'],
    ['プライベートIP(10)', 'https://10.0.0.5/a.png'],
    ['プライベートIP(192.168)', 'https://192.168.1.2/a.png'],
    ['プライベートIP(172.16)', 'https://172.16.0.1/a.png'],
    ['ループバック', 'https://127.0.0.1/a.png'],
    ['ドットの無い社内名', 'https://wallet/a.png'],
    ['相対パス', '/media/artworks/a.png'],
  ])('%s は拒否する', (_label, url) => {
    expect(isLongLivedImageUrl(url)).toBe(false);
  });

  // ⚠️ 期限付きURLを通すと、期限が切れた時点で**過去に渡した分の画像が
  //    まとめて壊れる**。壊れるのは配信の瞬間ではなく数日後なので、
  //    誰も原因に気づけない。
  it.each([
    'https://media.example.jp/a.png?X-Amz-Signature=abc',
    'https://media.example.jp/a.png?X-Amz-Expires=900',
    'https://media.example.jp/a.png?token=abc',
    'https://media.example.jp/a.png?expires=1234567890',
  ])('期限付きの署名URLは拒否する: %s', (url) => {
    expect(isLongLivedImageUrl(url)).toBe(false);
  });
});

describe('entitlement.granted の組み立て（§13）', () => {
  it('契約の固定値を入れる', () => {
    const result = buildGrantedEvent(grantedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.event_type).toBe('entitlement.granted');
    expect(result.value.event_version).toBe(WALLET_GRANTED_EVENT_VERSION);
    expect(result.value.source_system_key).toBe(SOURCE_SYSTEM_KEY);
    expect(result.value.target_site_key).toBe(TARGET_SITE_KEY);
    // 旧 `sengoku-market` を新規送信で使わない。
    expect(result.value.source_system_key).not.toBe('sengoku-market');
  });

  it('product_code は採番せず null で送る（§6）', () => {
    const result = buildGrantedEvent(grantedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.product_code).toBeNull();
    // 識別は asset_code で行う。
    expect(result.value.metadata.asset_code).toBe('artwork-1');
  });

  it('Blockchain は NOT_MINTED のまま（オフチェーン先行）', () => {
    const result = buildGrantedEvent(grantedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata.blockchain_status).toBe('NOT_MINTED');
  });

  it('個人情報を載せない', () => {
    const result = buildGrantedEvent(grantedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.value);
    // 入れてよいのは common_user_id まで。氏名・メール・金額は載せない。
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('amount');
    expect(serialized).not.toContain('price');
  });

  it.each([
    ['common_user_id の形が違う', { commonUserId: 'account-1' }],
    ['correlation_id の形が違う', { correlationId: 'x' }],
    ['シリアルが 0 以下', { serialNo: 0 }],
    ['シリアルが整数でない', { serialNo: 1.5 }],
    ['画像ハッシュの形が違う', { imageHash: 'abc' }],
    ['画像URLが相対パス', { imageUrl: '/media/a.png' }],
    ['サムネイルが期限付き', { thumbnailUrl: 'https://m.example.jp/a.png?token=x' }],
    ['作品名が空', { artworkTitle: '   ' }],
  ])('%s なら組み立てない', (_label, overrides) => {
    const result = buildGrantedEvent(grantedInput(overrides as Partial<WalletGrantedEventInput>));
    expect(result.ok).toBe(false);
  });
});

describe('entitlement.revoked の組み立て（§11・M3a）', () => {
  function revokedInput() {
    return { ...grantedInput(), reasonCode: 'full_refund' as const };
  }

  it('封筒と data のみを送る（表示情報は載せない）', () => {
    /*
      ⚠️ **作品名や画像を再送しない。** 相手がそれで Holding を
         書き換える余地を作らない。取消に要るのは「どれが無効になったか」だけ。
    */
    const result = buildRevokedEvent(revokedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('entitlement.revoked');
    expect('metadata' in result.value).toBe(false);
  });

  it('取り消しの理由を固定コードで載せる', () => {
    const result = buildRevokedEvent(revokedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reason_code).toBe('full_refund');
  });

  it('版は 1.1（付与の 1.0 とは分けて持つ）', () => {
    /*
      ⚠️ **定数を 1 本にまとめない。** まとめると、取消の版を上げた瞬間に
         付与の版まで黙って上がる。相手はヘッダで分岐するため、
         触っていないはずの付与が別の版として届く。
    */
    const revoked = buildRevokedEvent(revokedInput());
    const granted = buildGrantedEvent(grantedInput());
    expect(revoked.ok && granted.ok).toBe(true);
    if (!revoked.ok || !granted.ok) return;
    expect(revoked.value.event_version).toBe(WALLET_REVOKED_EVENT_VERSION);
    expect(revoked.value.event_version).toBe('1.1');
    expect(granted.value.event_version).toBe('1.0');
  });

  it('金額も氏名もメールも含まない', () => {
    const result = buildRevokedEvent(revokedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.stringify(result.value);
    for (const forbidden of ['amount', 'email', 'name', 'address', 'refund_amount']) {
      expect(payload).not.toContain(forbidden);
    }
  });

  it('同じ入力なら本文はいつも同じ（再実行で変わらない）', () => {
    /*
      ⚠️ **時計を読まない。** 呼び出しのたびに `occurred_at` が変わると
         本文が変わり、**正常な重複が「本文の食い違い」として検知される**。
    */
    const first = buildRevokedEvent(revokedInput());
    const second = buildRevokedEvent(revokedInput());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });
});

describe('再試行の分類（§18）', () => {
  it.each([
    ['timeout', { kind: 'timeout' } as const],
    ['network', { kind: 'network' } as const],
    ['500', { kind: 'response', statusCode: 500 } as const],
    ['503', { kind: 'response', statusCode: 503 } as const],
    ['429', { kind: 'response', statusCode: 429 } as const],
  ])('%s は再試行する', (_label, outcome) => {
    expect(isRetryable(outcome)).toBe(true);
  });

  it.each([400, 401, 403, 409, 422, 404])('%i は再試行しない', (statusCode) => {
    expect(isRetryable({ kind: 'response', statusCode })).toBe(false);
  });

  it('分類コードに応答本文を含めない', () => {
    expect(errorCodeFor({ kind: 'response', statusCode: 409 })).toBe('http_409');
    expect(errorCodeFor({ kind: 'timeout' })).toBe('timeout');
    expect(errorCodeFor({ kind: 'network' })).toBe('network');
  });
});

describe('配送後の状態判定（§18・§19）', () => {
  const context = { attemptCount: 1, maxAttempts: WALLET_DELIVERY_MAX_ATTEMPTS };

  it('2xx は DELIVERED', () => {
    expect(decideDelivery({ kind: 'response', statusCode: 200 }, context)).toEqual({
      next: 'DELIVERED',
    });
    expect(decideDelivery({ kind: 'response', statusCode: 202 }, context)).toEqual({
      next: 'DELIVERED',
    });
  });

  it('3xx は成功にしない（リダイレクトを追わない）', () => {
    const decision = decideDelivery({ kind: 'response', statusCode: 302 }, context);
    expect(decision.next).toBe('FAILED');
  });

  it.each([400, 401, 403, 409, 422])('%i は FAILED（自動再試行を止める）', (statusCode) => {
    const decision = decideDelivery({ kind: 'response', statusCode }, context);
    expect(decision.next).toBe('FAILED');
  });

  it('再試行のバックオフは 1/5/15/60/240 分', () => {
    const delays = [1, 2, 3, 4].map((attemptCount) => {
      const decision = decideDelivery(
        { kind: 'timeout' },
        { attemptCount, maxAttempts: WALLET_DELIVERY_MAX_ATTEMPTS },
      );
      return decision.next === 'PENDING' ? decision.retryAfterMs / 60_000 : null;
    });
    expect(delays).toEqual(RETRY_BACKOFF_MINUTES.slice(0, 4));
  });

  it('上限に達したら DEAD（FAILED ではない）', () => {
    // ⚠️ FAILED（送る内容が悪い）と DEAD（相手が復旧しない）は
    //    運用でやることが違う。同じ状態へ丸めない。
    const decision = decideDelivery(
      { kind: 'timeout' },
      { attemptCount: WALLET_DELIVERY_MAX_ATTEMPTS, maxAttempts: WALLET_DELIVERY_MAX_ATTEMPTS },
    );
    expect(decision.next).toBe('DEAD');
  });

  it('上限に達しても、再試行できない失敗なら FAILED のまま', () => {
    const decision = decideDelivery(
      { kind: 'response', statusCode: 400 },
      { attemptCount: WALLET_DELIVERY_MAX_ATTEMPTS, maxAttempts: WALLET_DELIVERY_MAX_ATTEMPTS },
    );
    expect(decision.next).toBe('FAILED');
  });
});

describe('手動再送の対象（§20）', () => {
  it('FAILED / DEAD だけを戻せる', () => {
    expect(canManuallyResend('FAILED')).toBe(true);
    expect(canManuallyResend('DEAD')).toBe(true);
  });

  it('PROCESSING は戻せない（届いたか分からないため）', () => {
    expect(canManuallyResend('PROCESSING')).toBe(false);
  });

  it('DELIVERED / PENDING は戻さない', () => {
    expect(canManuallyResend('DELIVERED')).toBe(false);
    expect(canManuallyResend('PENDING')).toBe(false);
  });
});
