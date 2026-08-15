import { describe, expect, it } from 'vitest';
import { decideGate, gateToken, isExemptPath, safeEqual, safeNextPath } from './gate';

describe('合言葉の署名', () => {
  it('同じ合言葉からは同じ値になる', async () => {
    expect(await gateToken('sakura-wakaba-kinu')).toBe(await gateToken('sakura-wakaba-kinu'));
  });

  it('合言葉を変えると値が変わる（配った入れ物が無効になる）', async () => {
    // ✅ 呼び戻しの手順を別に用意しなくてよい、という性質をここで固定する。
    expect(await gateToken('sakura-wakaba-kinu')).not.toBe(await gateToken('sakura-wakaba-kinu2'));
  });

  it('合言葉そのものを含まない', async () => {
    // ⚠️ 入れ物はブラウザに残り、開発者ツールから読める。
    const token = await gateToken('sakura-wakaba-kinu');
    expect(token).not.toContain('sakura');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('比較', () => {
  it('長さが違えば一致しない', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('中身が違えば一致しない', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('同じなら一致する', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });
});

describe('門を通さない場所', () => {
  it.each(['/enter', '/api/enter', '/api/health', '/_next/static/x.js', '/favicon.ico'])(
    '%s は素通しにする',
    (path) => {
      // ⚠️ 合言葉を入れる画面を門の内側に置くと、入る前に入れない。
      expect(isExemptPath(path)).toBe(true);
    },
  );

  it.each(['/', '/artworks/asagiri', '/admin/artworks', '/admin/listings'])(
    '%s は門を通す',
    (path) => {
      expect(isExemptPath(path)).toBe(false);
    },
  );
});

describe('合言葉のあとの戻り先', () => {
  it('サイト内の場所はそのまま使う', () => {
    expect(safeNextPath('/artworks/asagiri')).toBe('/artworks/asagiri');
  });

  it.each([
    ['外部URL', 'https://example.com/'],
    ['スキーム省略の外部URL', '//example.com/'],
    ['バックスラッシュ', '/\\example.com/'],
    ['空', ''],
    ['未指定', null],
  ])('%s はトップへ倒す', (_label, value) => {
    // ⚠️ 受け取った値をそのまま戻り先にすると、
    //    合言葉の画面から知らない場所へ送る経路ができる。
    expect(safeNextPath(value)).toBe('/');
  });
});

describe('門を働かせるかどうか', () => {
  it('合言葉が設定され、入れ物が正しければ通す', () => {
    expect(
      decideGate({ password: 'a-real-password', vercelEnv: 'production', hasValidCookie: true }),
    ).toEqual({ kind: 'open' });
  });

  it('合言葉が設定され、入れ物が無ければ尋ねる', () => {
    expect(
      decideGate({ password: 'a-real-password', vercelEnv: 'production', hasValidCookie: false }),
    ).toEqual({ kind: 'ask' });
  });

  it.each(['production', 'preview'] as const)(
    '%s で合言葉が未設定なら、すべて拒否する',
    (vercelEnv) => {
      // ⚠️ 素通しにすると、設定を忘れたことに誰も気づけないまま公開が続く。
      expect(decideGate({ password: undefined, vercelEnv, hasValidCookie: false })).toEqual({
        kind: 'misconfigured',
      });
    },
  );

  it('空文字も未設定として扱う', () => {
    expect(decideGate({ password: '', vercelEnv: 'production', hasValidCookie: false })).toEqual({
      kind: 'misconfigured',
    });
  });

  it('手元では合言葉が無くても素通しでよい', () => {
    expect(
      decideGate({ password: undefined, vercelEnv: 'development', hasValidCookie: false }),
    ).toEqual({ kind: 'open' });
  });

  it('Vercel 以外（環境名が無い）でも素通しでよい', () => {
    expect(
      decideGate({ password: undefined, vercelEnv: undefined, hasValidCookie: false }),
    ).toEqual({ kind: 'open' });
  });
});
