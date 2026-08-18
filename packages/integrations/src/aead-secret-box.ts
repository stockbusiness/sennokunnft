import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SealedSecret, SecretCipherPort, SecretScope } from '@sengoku/domain';
import { integrationScope } from '@sengoku/domain';

/**
 * 外部連携の資格情報を包む（指示書 §6.2）。
 *
 * ⚠️ **独自方式を作らない。** Node 標準の AES-256-GCM をそのまま使う。
 * 認証付き暗号なので、改ざんされた暗号文は復号の段階で弾かれる。
 * 「暗号化してから別途ハッシュで検証」のような自作の組み合わせは、
 * 組み合わせ方を一箇所間違えるだけで検証が効かなくなる。
 *
 * ⚠️ **鍵はここに持たない。** 呼び出し側が配備環境の Secret から渡す。
 * DB へ鍵を置くと、DB を取られた時点で暗号化の意味が無くなる。
 */

const ALGORITHM = 'aes-256-gcm';
/** GCM の推奨長。**12 バイトから変えない。** 他の長さは実装ごとに扱いが割れる。 */
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

export interface AeadSecretBoxOptions {
  /**
   * 使える暗号鍵（version → 32 バイトの鍵）。
   *
   * ⚠️ **複数持てるようにしてある。** 鍵を交換したあとも、
   * 古い version で包まれた行を読めなければならない。
   * 1 本しか持てない設計にすると、鍵交換が「全部を入れ替える大工事」になる。
   */
  readonly keys: Readonly<Record<string, Buffer>>;
  /**
   * 新しく包むときに使う version。
   *
   * ⚠️ **`keys` に無い version を指定したら、その場で落とす。**
   * 起動してから最初の保存で気付くのでは遅い。
   */
  readonly activeKeyVersion: string;
  /** 試験用の差し替え口。 */
  readonly generateNonce?: () => Buffer;
}

export class AeadSecretBox implements SecretCipherPort {
  private readonly keys: Readonly<Record<string, Buffer>>;
  private readonly activeKeyVersion: string;
  private readonly generateNonce: () => Buffer;

  constructor(options: AeadSecretBoxOptions) {
    for (const [version, key] of Object.entries(options.keys)) {
      if (key.length !== KEY_BYTES) {
        // ⚠️ 鍵の中身は例外へ載せない。長さだけを伝える。
        throw new Error(
          `暗号鍵 ${version} の長さが ${String(key.length)} バイトです。${String(KEY_BYTES)} バイトである必要があります。`,
        );
      }
    }
    if (options.keys[options.activeKeyVersion] === undefined) {
      throw new Error(`暗号鍵 ${options.activeKeyVersion} が設定されていません。`);
    }
    this.keys = options.keys;
    this.activeKeyVersion = options.activeKeyVersion;
    this.generateNonce = options.generateNonce ?? (() => randomBytes(NONCE_BYTES));
  }

  seal(plaintext: string, scope: SecretScope): SealedSecret {
    const key = this.keys[this.activeKeyVersion];
    if (key === undefined) {
      // 構築時に確かめているので通常は起きない。型の上で保証されないため残す。
      throw new Error('暗号鍵が見つかりません。');
    }

    const nonce = this.generateNonce();
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    // ⚠️ 結び付け情報。これにより、staging の暗号文を production の行へ
    //    貼り替えても復号が失敗する（DB を触れる人にだけできる攻撃を塞ぐ）。
    cipher.setAAD(Buffer.from(aad(scope), 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.activeKeyVersion,
      lastFour: lastFourOf(plaintext),
    };
  }

  open(sealed: SealedSecret, scope: SecretScope): string | null {
    const key = this.keys[sealed.keyVersion];
    if (key === undefined) {
      // 交換で捨てられた version。理由は返さない。
      return null;
    }

    try {
      const nonce = Buffer.from(sealed.nonce, 'base64');
      const authTag = Buffer.from(sealed.authTag, 'base64');
      if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        return null;
      }

      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAAD(Buffer.from(aad(scope), 'utf8'));
      decipher.setAuthTag(authTag);

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        // 印が合わなければ、ここで例外になる。
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      // ⚠️ 「鍵が違う」と「改ざんされている」を区別して返さない。
      //    区別すると、総当たりの手掛かりになる。
      return null;
    }
  }
}

function aad(scope: SecretScope): string {
  return integrationScope(scope.service, scope.environment);
}

/**
 * 画面での見分け用に末尾を取る。
 *
 * ⚠️ **短い値では何も出さない。** 4 文字の秘密を渡されたときに
 * 全文を「識別表示」として出してしまう。
 */
export function lastFourOf(plaintext: string): string {
  return plaintext.length >= 8 ? plaintext.slice(-4) : '';
}

/**
 * `version:base64鍵,version:base64鍵` を表に変換する。
 *
 * ⚠️ **失敗しても内容を例外へ載せない。** 鍵がそのままログへ出る。
 * 読めなかった項目は黙って捨て、件数だけを呼び出し元の判断材料にする
 * （`parseHmacKeys` と同じ方針）。
 */
export function parseEncryptionKeys(raw: string): Readonly<Record<string, Buffer>> {
  const keys: Record<string, Buffer> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const version = trimmed.slice(0, separator).trim();
    const encoded = trimmed.slice(separator + 1).trim();
    if (version === '' || encoded === '') continue;

    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) continue;
    keys[version] = key;
  }
  return keys;
}
