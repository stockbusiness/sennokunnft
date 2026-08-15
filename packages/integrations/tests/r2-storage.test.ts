import { describe, expect, it, vi } from 'vitest';
import { R2Storage, type R2StorageOptions } from '../src/index';

const BASE: R2StorageOptions = {
  accountId: 'acct-123',
  bucket: 'sennokunnft-media',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-value',
  publicBaseUrl: 'https://media-stg.example.jp',
};

function storageWith(
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: Partial<R2StorageOptions> = {},
) {
  return new R2Storage({ ...BASE, ...overrides, fetchImpl: fetchImpl as unknown as typeof fetch });
}

function okFetch(status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(null, { status }));
}

function requestOf(fetchImpl: ReturnType<typeof vi.fn>): Request {
  return (fetchImpl.mock.calls[0] as [Request])[0];
}

describe('公開URL', () => {
  it('Custom Domain から組み立てる', () => {
    const storage = storageWith(okFetch());
    expect(storage.publicUrl('artworks/2026/08/abc.png')).toBe(
      'https://media-stg.example.jp/artworks/2026/08/abc.png',
    );
  });

  it('末尾のスラッシュがあっても二重にしない', () => {
    const storage = storageWith(okFetch(), { publicBaseUrl: 'https://media-stg.example.jp/' });
    expect(storage.publicUrl('a.png')).toBe('https://media-stg.example.jp/a.png');
  });

  it('署名を付けない', () => {
    // ⚠️ 期限付きURLを返すと、Wallet が保存した過去の Holding が
    //    期限切れでまとめて壊れる。壊れるのは数日後なので気づけない。
    const url = storageWith(okFetch()).publicUrl('a.png');
    expect(url).not.toContain('?');
    expect(url.toLowerCase()).not.toContain('signature');
    expect(url.toLowerCase()).not.toContain('expires');
  });

  it('毎回同じ URL を返す（呼ぶたびに変わらない）', () => {
    const storage = storageWith(okFetch());
    expect(storage.publicUrl('a.png')).toBe(storage.publicUrl('a.png'));
  });
});

describe('設定の検証（起動時に落とす）', () => {
  // ⚠️ ここを通さないと、設定を誤ったまま起動し、
  //    Wallet へ壊れた URL を送り始めるまで誰も気づけない。
  it.each([
    ['http（平文）', 'http://media.example.jp'],
    ['localhost', 'https://localhost:8080'],
    ['プライベートIP', 'https://192.168.1.10'],
    ['署名付きURL', 'https://media.example.jp?X-Amz-Signature=abc'],
    ['期限付きURL', 'https://media.example.jp?expires=1234567890'],
  ])('%s は拒否する', (_label, publicBaseUrl) => {
    expect(() => storageWith(okFetch(), { publicBaseUrl })).toThrow();
  });

  it.each(['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'] as const)(
    '%s が空なら生成させない',
    (field) => {
      expect(() => storageWith(okFetch(), { [field]: '' })).toThrow();
    },
  );

  it('例外に秘密鍵を載せない', () => {
    try {
      storageWith(okFetch(), { publicBaseUrl: 'http://media.example.jp' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });
});

describe('保存', () => {
  it('バケットとキーの位置へ PUT する', async () => {
    const fetchImpl = okFetch();
    await storageWith(fetchImpl).put({
      key: 'artworks/2026/08/abc.png',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });

    const request = requestOf(fetchImpl);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(
      'https://acct-123.r2.cloudflarestorage.com/sennokunnft-media/artworks/2026/08/abc.png',
    );
    expect(request.headers.get('content-type')).toBe('image/png');
  });

  it('署名を付けて送る', async () => {
    const fetchImpl = okFetch();
    await storageWith(fetchImpl).put({
      key: 'a.png',
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
    });

    const authorization = requestOf(fetchImpl).headers.get('authorization') ?? '';
    expect(authorization).toContain('AWS4-HMAC-SHA256');
    // ⚠️ 秘密鍵そのものがヘッダへ出ていないこと。
    expect(authorization).not.toContain('secret-value');
  });

  it('保存したキーとサイズを返す', async () => {
    const stored = await storageWith(okFetch()).put({
      key: 'a.png',
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: 'image/webp',
    });
    expect(stored).toEqual({ key: 'a.png', contentType: 'image/webp', byteSize: 4 });
  });

  it('失敗したら例外にし、応答本文を載せない', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('<Error><BucketName>secret-bucket</BucketName></Error>', { status: 500 }),
      );

    await expect(
      storageWith(fetchImpl).put({
        key: 'a.png',
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/status 500/);

    await expect(
      storageWith(fetchImpl).put({
        key: 'a.png',
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
    ).rejects.not.toThrow(/secret-bucket/);
  });
});

describe('削除', () => {
  it('DELETE を送る', async () => {
    const fetchImpl = okFetch(204);
    await storageWith(fetchImpl).remove('a.png');
    expect(requestOf(fetchImpl).method).toBe('DELETE');
  });

  it('存在しないキーでも失敗にしない（冪等）', async () => {
    // ⚠️ 置換や再試行で同じキーを 2 度消しうる。
    //    ここで例外を投げると、成立している業務処理が落ちる。
    await expect(storageWith(okFetch(404)).remove('missing.png')).resolves.toBeUndefined();
  });

  it('それ以外の失敗は例外にする', async () => {
    await expect(storageWith(okFetch(500)).remove('a.png')).rejects.toThrow(/status 500/);
  });
});

describe('キーの検証', () => {
  // ⚠️ キーは本システムが生成するが、経路のどこかで外部入力が
  //    混ざったときに別の場所を指せてしまうと被害が大きい。
  //    LocalFileStorage と同じ規律をここでも持つ。
  it.each([
    ['空', ''],
    ['先頭スラッシュ', '/etc/passwd'],
    ['親ディレクトリ', 'artworks/../../secret.png'],
  ])('%s のキーは拒否する', async (_label, key) => {
    await expect(
      storageWith(okFetch()).put({
        key,
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
    ).rejects.toThrow();
  });

  it('階層は残したまま符号化する', async () => {
    const fetchImpl = okFetch();
    await storageWith(fetchImpl).put({
      key: 'artworks/2026/08/a b.png',
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
    });
    expect(requestOf(fetchImpl).url).toContain('/artworks/2026/08/a%20b.png');
  });
});
