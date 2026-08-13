import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { PutObjectInput, StoragePort, StoredObject } from '@sengoku/domain';

/**
 * ローカルファイルシステムへの保存。
 *
 * ✅ 本番ストレージ（S3 / Supabase Storage / IPFS）へは接続しない。
 * 保存先は未決定（`UD-508`）で、決まってからアダプタを追加する。
 *
 * 開発と結合テスト用だが、**キーの生成とパス検証は本番と同じ規律**にしてある。
 * ここを緩めると、実装を差し替えたときに検証の欠落に気付けない。
 */
export class LocalFileStorage implements StoragePort {
  private readonly root: string;

  constructor(
    rootDir: string,
    /** 表示用URLの前置き。実行時にキーから解決するために使う。 */
    private readonly urlPrefix = '/media',
  ) {
    this.root = resolve(rootDir);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.resolveSafePath(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
    return { key: input.key, contentType: input.contentType, byteSize: input.bytes.length };
  }

  async remove(key: string): Promise<void> {
    const path = this.resolveSafePath(key);
    // 存在しなくても失敗させない。置換や再試行で同じキーを2度消しうるため。
    await rm(path, { force: true });
  }

  publicUrl(key: string): string {
    return `${this.urlPrefix}/${key}`;
  }

  /**
   * キーを実パスへ変換する。
   *
   * ⚠️ **保存ルートの外へ出るキーを拒否する。**
   * キーは本システムが生成するが、経路のどこかで外部入力が混ざったときに
   * `../` でルート外へ書き込めてしまうと被害が大きい。
   */
  private resolveSafePath(key: string): string {
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error('storage key escapes the storage root');
    }
    return path;
  }
}

/**
 * 保存キーを生成する。
 *
 * ⚠️ **利用者が送ったファイル名を使わない。**
 * ファイル名には制御文字・パス区切り・極端な長さ・同名衝突など
 * 扱いづらい要素が詰まっている。推測もされたくないので乱数にする。
 * `Math.random()` ではなく CSPRNG を使う。
 */
export function generateStorageKey(prefix: string, extension: string): string {
  const random = randomBytes(16).toString('hex');
  // 日付で階層を切る。1 ディレクトリにファイルが増え続けるのを避けるため。
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}/${yyyy}/${mm}/${random}.${extension}`;
}

/**
 * メモリ上に保持するストレージ。テスト用。
 *
 * ファイルシステムに触れないので、テストが並列でも干渉しない。
 */
export class InMemoryStorage implements StoragePort {
  private readonly objects = new Map<string, StoredObject>();

  put(input: PutObjectInput): Promise<StoredObject> {
    const stored: StoredObject = {
      key: input.key,
      contentType: input.contentType,
      byteSize: input.bytes.length,
    };
    this.objects.set(input.key, stored);
    return Promise.resolve(stored);
  }

  remove(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  publicUrl(key: string): string {
    return `/media/${key}`;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  size(): number {
    return this.objects.size;
  }
}
