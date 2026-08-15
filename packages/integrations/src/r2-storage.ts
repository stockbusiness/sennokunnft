import { AwsClient } from 'aws4fetch';
import {
  isLongLivedImageUrl,
  type PutObjectInput,
  type StoragePort,
  type StoredObject,
} from '@sengoku/domain';

/**
 * Cloudflare R2 への保存（`UD-508`）。
 *
 * R2 は S3 互換の API を持つので、SigV4 で署名した HTTP 要求で扱える。
 * 使うのは PUT と DELETE の 2 つだけ。
 *
 * ⚠️ **`publicUrl` が署名付き URL を返してはならない。**
 * OVEW Wallet は受け取った URL を Holding に保存して表示に使う。
 * 期限付きの URL を渡すと、期限が切れた時点で
 * **過去に渡した分の画像がまとめて壊れる**。壊れるのは配信の瞬間ではなく
 * 数日後なので、誰も原因に気づけない。
 * 公開は必ず Custom Domain（`https://media.example.jp/...`）から行う。
 */

export interface R2StorageOptions {
  /** Cloudflare のアカウントID。API の宛先を組み立てるのに使う。 */
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  /** ⚠️ ログにも例外にも載せない。 */
  readonly secretAccessKey: string;
  /**
   * 公開URLの前置き。R2 に割り当てた Custom Domain。
   * 末尾のスラッシュは付けても付けなくてもよい（内部で落とす）。
   */
  readonly publicBaseUrl: string;
  /** 応答を待つ上限。待ち続けると画像アップロードの要求が詰まる。 */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** R2 は SigV4 のリージョンとして `auto` を使う。 */
const R2_REGION = 'auto';

export class R2Storage implements StoragePort {
  private readonly client: AwsClient;
  private readonly endpoint: string;
  private readonly publicBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: R2StorageOptions) {
    for (const [name, value] of [
      ['accountId', options.accountId],
      ['bucket', options.bucket],
      ['accessKeyId', options.accessKeyId],
      ['secretAccessKey', options.secretAccessKey],
    ] as const) {
      if (value.length === 0) {
        // ⚠️ 値そのものは載せない。何が欠けているかだけを伝える。
        throw new Error(`R2 storage requires ${name}`);
      }
    }

    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');

    // ⚠️ **起動時に公開URLの形を確かめる。**
    //    ここを通さないと、設定を誤ったまま起動し、
    //    Wallet へ壊れた URL を送り始めるまで誰も気づけない。
    //    判定はドメイン側と**同じ関数**を使う。二重に書くとずれる。
    if (!isLongLivedImageUrl(`${this.publicBaseUrl}/probe.png`)) {
      throw new Error(
        'R2 publicBaseUrl must be a long-lived https url (no signed or expiring urls)',
      );
    }

    this.endpoint = `https://${options.accountId}.r2.cloudflarestorage.com`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: R2_REGION,
      service: 's3',
    });
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const response = await this.send(input.key, {
      method: 'PUT',
      body: input.bytes,
      headers: {
        'content-type': input.contentType,
        'content-length': String(input.bytes.length),
      },
    });

    if (!response.ok) {
      // ⚠️ 応答本文を載せない。バケット名や鍵IDが混ざりうる。
      throw new Error(`R2 put failed with status ${String(response.status)}`);
    }

    return { key: input.key, contentType: input.contentType, byteSize: input.bytes.length };
  }

  async remove(key: string): Promise<void> {
    const response = await this.send(key, { method: 'DELETE' });

    // ⚠️ **存在しないキーを失敗にしない。**
    //    置換や再試行で同じキーを 2 度消しうる。そこで例外を投げると、
    //    業務としては成立している処理が落ちる。
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw new Error(`R2 delete failed with status ${String(response.status)}`);
    }
  }

  /**
   * 表示用の URL。
   *
   * ⚠️ **署名を付けない。** 期限のある URL を返すと、
   * Wallet が保存した過去の Holding が期限切れでまとめて壊れる。
   */
  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${encodeKeyPath(key)}`;
  }

  private async send(key: string, init: RequestInit): Promise<Response> {
    const url = `${this.endpoint}/${this.options.bucket}/${encodeKeyPath(assertSafeKey(key))}`;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const signed = await this.client.sign(url, init);
      return await this.fetchImpl(signed, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * キーの検証。
 *
 * ⚠️ **バケットの外へ出る形を拒否する。**
 * キーは本システムが生成するが、経路のどこかで外部入力が混ざったときに
 * `../` で別の場所を指せてしまうと被害が大きい。
 * ローカル実装（`LocalFileStorage`）と同じ規律をここでも持つ。
 * 片方だけ守ると、実装を差し替えたときに検証が消える。
 */
function assertSafeKey(key: string): string {
  if (key.length === 0 || key.startsWith('/') || key.split('/').includes('..')) {
    throw new Error('storage key has an unexpected shape');
  }
  return key;
}

/** `/` は階層として残し、それ以外を URL 用に符号化する。 */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
