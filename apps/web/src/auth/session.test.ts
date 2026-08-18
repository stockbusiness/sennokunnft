import { describe, expect, it } from 'vitest';
import {
  isExpired,
  isPublicPath,
  needsRefresh,
  normalizeEmail,
  REFRESH_MARGIN_SEC,
  requiresLogin,
  safeReturnPath,
} from './session';

describe('ログインを求める場所', () => {
  it.each(['/creator', '/creator/artworks/new', '/creator/artworks/abc'])(
    '%s はログインが要る',
    (path) => {
      expect(requiresLogin(path)).toBe(true);
    },
  );

  it.each(['/login', '/api/auth/confirm', '/enter', '/api/health', '/_next/static/x.js'])(
    '%s は素通しにする',
    (path) => {
      // ⚠️ ログイン画面を内側に置くと、入る前に入れない。
      expect(isPublicPath(path)).toBe(true);
      expect(requiresLogin(path)).toBe(false);
    },
  );

  it.each(['/', '/artworks/asagiri'])('%s は公開のままにする（買う前に登録させない）', (path) => {
    expect(requiresLogin(path)).toBe(false);
  });

  it('/creatorial のような紛らわしい名前を巻き込まない', () => {
    // 前方一致だけで判定すると、別の場所まで保護対象に見える。
    expect(requiresLogin('/creatorial')).toBe(false);
  });
});

describe('期限の判定', () => {
  const NOW = 1_800_000_000;

  it('期限を過ぎていれば切れている', () => {
    expect(isExpired(NOW - 1, NOW)).toBe(true);
    expect(isExpired(NOW + 1, NOW)).toBe(false);
  });

  it('猶予のうちに取り直す', () => {
    // ⚠️ 期限ちょうどで取り直すと、api に届くまでの間に切れる。
    //    切れた瞬間だけ 401 になり、再読み込みで直る不具合になる。
    expect(needsRefresh(NOW + REFRESH_MARGIN_SEC - 1, NOW)).toBe(true);
    expect(needsRefresh(NOW + REFRESH_MARGIN_SEC + 1, NOW)).toBe(false);
  });

  it('猶予は 0 ではない', () => {
    expect(REFRESH_MARGIN_SEC).toBeGreaterThan(0);
  });
});

describe('ログイン後の戻り先', () => {
  it('サイト内の場所はそのまま使う', () => {
    expect(safeReturnPath('/creator/artworks/new')).toBe('/creator/artworks/new');
  });

  it.each([
    ['外部URL', 'https://example.com/'],
    ['スキーム省略の外部URL', '//example.com/'],
    ['バックスラッシュ', '/\\example.com/'],
    ['空', ''],
    ['未指定', null],
  ])('%s は出品一覧へ倒す', (_label, value) => {
    // ⚠️ そのまま使うと、ログイン画面から知らない場所へ送る経路ができる。
    expect(safeReturnPath(value)).toBe('/creator');
  });
});

describe('メールアドレスの下ごしらえ', () => {
  it('前後の空白と大文字小文字を整える', () => {
    expect(normalizeEmail('  Tanaka@Example.JP  ')).toBe('tanaka@example.jp');
  });

  it.each([
    ['空', ''],
    ['空白だけ', '   '],
    ['@が無い', 'tanaka'],
    ['文字列でない', 123],
  ])('%s は受け付けない', (_label, value) => {
    expect(normalizeEmail(value)).toBeNull();
  });

  it('長すぎるものは受け付けない', () => {
    expect(normalizeEmail(`${'a'.repeat(320)}@example.jp`)).toBeNull();
  });

  it('見慣れない形でも弾かない（判断は Supabase に委ねる）', () => {
    // ⚠️ 独自の正規表現を持つと、通るはずのアドレスを弾いて
    //    「なぜか登録できない人」を生む。
    expect(normalizeEmail('user+tag@sub.example.co.jp')).toBe('user+tag@sub.example.co.jp');
    expect(normalizeEmail('"quoted"@example.jp')).toBe('"quoted"@example.jp');
  });
});
