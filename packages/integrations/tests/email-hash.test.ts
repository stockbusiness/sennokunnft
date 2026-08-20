import { describe, expect, it } from 'vitest';
import { HmacEmailHasher, normalizeEmail } from '../src/email-hash';

/**
 * 照合用のメール値（`UD-121`）。
 *
 * ⚠️ ここで守りたいのは 2 つ。
 *   1. **鍵が無い配備で素のハッシュへ落ちないこと。** 落ちると、
 *      配備によって保護の強さが変わり、どちらで作られた行なのか
 *      見分けが付かないまま同じ列に混ざる。
 *   2. **送り手側の慣習を真似ないこと。** `.` を無視したり `+` 以降を
 *      捨てたりすると、他所では**別人**のアドレスが同一人物になる。
 */
const PEPPER = 'test-email-lookup-pepper-0123456789abcdef';

describe('HmacEmailHasher', () => {
  it('同じアドレスからは同じ値になる（照合できる）', () => {
    const hasher = new HmacEmailHasher(PEPPER);
    expect(hasher.hash('buyer@example.com')).toBe(hasher.hash('buyer@example.com'));
  });

  it('大文字小文字と前後の空白を吸収する（聞き取って打ち込む運用のため）', () => {
    const hasher = new HmacEmailHasher(PEPPER);
    expect(hasher.hash('  BUYER@Example.COM ')).toBe(hasher.hash('buyer@example.com'));
  });

  it('鍵が違えば値も違う（鍵の無い相手には照合できない）', () => {
    const a = new HmacEmailHasher(PEPPER);
    const b = new HmacEmailHasher('another-pepper-0123456789abcdefghij');
    expect(a.hash('buyer@example.com')).not.toBe(b.hash('buyer@example.com'));
  });

  it('鍵が無ければ null。素のハッシュへ落とさない', () => {
    expect(new HmacEmailHasher(null).hash('buyer@example.com')).toBeNull();
    expect(new HmacEmailHasher('').hash('buyer@example.com')).toBeNull();
  });

  it('アドレスの形をなしていなければ null', () => {
    const hasher = new HmacEmailHasher(PEPPER);
    expect(hasher.hash('buyer')).toBeNull();
    expect(hasher.hash('@example.com')).toBeNull();
    expect(hasher.hash('buyer@')).toBeNull();
    expect(hasher.hash('   ')).toBeNull();
  });

  it('戻り値に平文が混ざらない', () => {
    const hashed = new HmacEmailHasher(PEPPER).hash('buyer@example.com');
    expect(hashed).not.toBeNull();
    expect(hashed).not.toContain('buyer');
    expect(hashed).not.toContain('example');
    expect(hashed).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('normalizeEmail', () => {
  it('ドット付きと無しを同じ人にしない', () => {
    // ⚠️ 特定の事業者の慣習であって規格ではない。まとめると、
    //    他所では他人の注文が同じ人として並ぶ。
    expect(normalizeEmail('a.b@example.com')).not.toBe(normalizeEmail('ab@example.com'));
  });

  it('プラス以降を捨てない', () => {
    expect(normalizeEmail('buyer+shop@example.com')).not.toBe(normalizeEmail('buyer@example.com'));
  });

  it('長すぎるアドレスは受け付けない', () => {
    expect(normalizeEmail(`${'a'.repeat(250)}@example.com`)).toBeNull();
  });
});
