import { createHash, randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ClaimTokenPort,
  ClockPort,
  IdGeneratorPort,
  IdempotencyKeyPort,
  IssuedClaimToken,
} from '@sengoku/domain';
import { mintIdempotencyPayload } from '@sengoku/domain';

/** 実時刻を返す時計。 */
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

/** テスト用に時刻を固定できる時計。 */
export class FixedClock implements ClockPort {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** UUID による識別子生成。`Math.random()` は使わない。 */
export class UuidGenerator implements IdGeneratorPort {
  generate(): string {
    return randomUUID();
  }
}

/** テスト用の決定論的な識別子生成。 */
export class SequentialIdGenerator implements IdGeneratorPort {
  private counter = 0;

  constructor(private readonly prefix = 'id') {}

  generate(): string {
    this.counter += 1;
    return `${this.prefix}-${String(this.counter)}`;
  }
}

/**
 * 内容ハッシュ（`sha256:<hex>`）。
 *
 * 配送本文（`payload_hash`）と作品画像（`image_hash`）で**同じ形式**を使う。
 * DB の CHECK 制約と `@sengoku/domain` の `isContentHash` も同じ規則で書いてある。
 * 形式が 3 か所でずれると、保存はできるのに照合が通らない値ができる。
 */
export function contentHash(data: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return `sha256:${hash.digest('hex')}`;
}

/** Claim トークンの乱数長（バイト）。総当たりを実用上不可能にする。 */
const CLAIM_TOKEN_BYTES = 32;

/**
 * Claim トークンの発行と照合。
 *
 * - 生成は CSPRNG（`randomBytes`）。`Math.random()` は予測可能なので使わない
 * - **平文は保存しない。** DB にはハッシュのみを置く
 * - 照合はタイミング安全な比較で行う
 *
 * （SECURITY_DESIGN.md §8）
 */
export class Sha256ClaimTokenService implements ClaimTokenPort {
  issue(): IssuedClaimToken {
    const token = randomBytes(CLAIM_TOKEN_BYTES).toString('base64url');
    return { token, tokenHash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  matches(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(token), 'utf8');
    const expected = Buffer.from(expectedHash, 'utf8');
    // 長さが異なると timingSafeEqual が例外を投げるため、先に長さを揃えて判定する。
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  }
}

/**
 * 発行ジョブの冪等キーを導出する。
 *
 * **受取権IDから決定論的に導出する**ことが要点。
 * 再試行のたびに新しいキーを作ると、外部の発行 API から見て別依頼になり、
 * 多重発行の原因になる（LAZY_MINT_FLOW.md §3.4）。
 */
export class HmacIdempotencyKeyService implements IdempotencyKeyPort {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error('idempotency secret must not be empty');
    }
  }

  deriveMintKey(entitlementId: string): string {
    return createHmac('sha256', this.secret)
      .update(mintIdempotencyPayload(entitlementId))
      .digest('hex');
  }
}
