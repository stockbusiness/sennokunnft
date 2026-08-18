import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AeadSecretBox, lastFourOf, parseEncryptionKeys } from '../src/aead-secret-box';
import type { SecretScope } from '@sengoku/domain';

/**
 * 外部連携の資格情報を包む仕組み（指示書 §6.2・§13）。
 *
 * ⚠️ **この試験の主題は「読めないこと」。**
 * 「包んで開ける」より、鍵が違う・改ざんされた・別の行へ貼り替えた
 * ときに**開かない**ことを厚く見る。開いてしまう穴だけが事故になる。
 */

const KEY_V1 = randomBytes(32);
const KEY_V2 = randomBytes(32);

const WALLET_PROD: SecretScope = { service: 'ovew_wallet', environment: 'production' };
const WALLET_STAGING: SecretScope = { service: 'ovew_wallet', environment: 'staging' };
const STORAGE_PROD: SecretScope = { service: 'storage', environment: 'production' };

function box(activeKeyVersion = 'v1'): AeadSecretBox {
  return new AeadSecretBox({ keys: { v1: KEY_V1, v2: KEY_V2 }, activeKeyVersion });
}

const SECRET = 'ovew-live-9f2b1c00a4d67K9P';

describe('包んで開ける', () => {
  it('同じ組み合わせなら開ける', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    expect(box().open(sealed, WALLET_PROD)).toBe(SECRET);
  });

  it('暗号文に平文が現れない', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    const everything = JSON.stringify(sealed);
    expect(everything).not.toContain(SECRET);
    // 末尾 4 文字は識別表示として意図的に持つ。それ以外は出ない。
    expect(everything).not.toContain('ovew-live');
  });

  it('同じ値でも毎回ちがう暗号文になる', () => {
    // ⚠️ 使い捨ての値を固定すると、同じ値かどうかが暗号文から分かる。
    const first = box().seal(SECRET, WALLET_PROD);
    const second = box().seal(SECRET, WALLET_PROD);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it('どの鍵で包んだかを持つ', () => {
    expect(box('v2').seal(SECRET, WALLET_PROD).keyVersion).toBe('v2');
  });

  it('古い version で包んだものも、鍵が残っていれば開ける', () => {
    // 鍵を交換したあとも、まだ入れ替えていない行を読めなければならない。
    const sealed = box('v1').seal(SECRET, WALLET_PROD);
    expect(box('v2').open(sealed, WALLET_PROD)).toBe(SECRET);
  });
});

describe('開かないこと', () => {
  it('環境が違えば開けない', () => {
    // ⚠️ staging の暗号文を production の行へ貼り替えても読めない。
    const sealed = box().seal(SECRET, WALLET_STAGING);
    expect(box().open(sealed, WALLET_PROD)).toBeNull();
  });

  it('サービスが違えば開けない', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    expect(box().open(sealed, STORAGE_PROD)).toBeNull();
  });

  it('暗号文を 1 文字変えたら開けない', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    const tampered = { ...sealed, ciphertext: bytes.toString('base64') };
    expect(box().open(tampered, WALLET_PROD)).toBeNull();
  });

  it('改ざん検知の印を変えたら開けない', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    const tag = Buffer.from(sealed.authTag, 'base64');
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    expect(box().open({ ...sealed, authTag: tag.toString('base64') }, WALLET_PROD)).toBeNull();
  });

  it('使い捨ての値を変えたら開けない', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    const nonce = Buffer.from(sealed.nonce, 'base64');
    nonce[0] = (nonce[0] ?? 0) ^ 0x01;
    expect(box().open({ ...sealed, nonce: nonce.toString('base64') }, WALLET_PROD)).toBeNull();
  });

  it('鍵が違えば開けない', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    const other = new AeadSecretBox({ keys: { v1: randomBytes(32) }, activeKeyVersion: 'v1' });
    expect(other.open(sealed, WALLET_PROD)).toBeNull();
  });

  it('捨てた version の暗号文は開けない', () => {
    const sealed = box('v2').seal(SECRET, WALLET_PROD);
    const afterRetire = new AeadSecretBox({ keys: { v1: KEY_V1 }, activeKeyVersion: 'v1' });
    expect(afterRetire.open(sealed, WALLET_PROD)).toBeNull();
  });

  it('長さの違う使い捨ての値・印を受け付けない', () => {
    const sealed = box().seal(SECRET, WALLET_PROD);
    expect(
      box().open({ ...sealed, nonce: Buffer.alloc(8).toString('base64') }, WALLET_PROD),
    ).toBeNull();
    expect(
      box().open({ ...sealed, authTag: Buffer.alloc(8).toString('base64') }, WALLET_PROD),
    ).toBeNull();
  });

  it('失敗の理由を区別して返さない', () => {
    // 鍵違いも改ざんも同じ null。区別すると総当たりの手掛かりになる。
    const sealed = box().seal(SECRET, WALLET_PROD);
    const wrongKey = new AeadSecretBox({ keys: { v1: randomBytes(32) }, activeKeyVersion: 'v1' });
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;

    expect(wrongKey.open(sealed, WALLET_PROD)).toBeNull();
    expect(box().open({ ...sealed, ciphertext: bytes.toString('base64') }, WALLET_PROD)).toBeNull();
  });
});

describe('組み立てのときに落とす', () => {
  it('鍵の長さが違えば作れない', () => {
    expect(
      () => new AeadSecretBox({ keys: { v1: randomBytes(16) }, activeKeyVersion: 'v1' }),
    ).toThrow();
  });

  it('鍵の中身を例外へ載せない', () => {
    const secretKey = randomBytes(16);
    try {
      new AeadSecretBox({ keys: { v1: secretKey }, activeKeyVersion: 'v1' });
      throw new Error('作れてしまった');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretKey.toString('base64'));
      expect(message).not.toContain(secretKey.toString('hex'));
    }
  });

  it('使う version の鍵が無ければ作れない', () => {
    // 起動してから最初の保存で気付くのでは遅い。
    expect(() => new AeadSecretBox({ keys: { v1: KEY_V1 }, activeKeyVersion: 'v9' })).toThrow();
  });
});

describe('識別表示', () => {
  it('末尾 4 文字だけを出す', () => {
    expect(lastFourOf('ovew-live-9f2b1c00a4d67K9P')).toBe('7K9P');
  });

  it('短い値では何も出さない（全文を晒さない）', () => {
    expect(lastFourOf('short')).toBe('');
    expect(lastFourOf('1234')).toBe('');
  });
});

describe('鍵の読み取り', () => {
  it('version と鍵の並びを読む', () => {
    const raw = `v1:${KEY_V1.toString('base64')},v2:${KEY_V2.toString('base64')}`;
    const keys = parseEncryptionKeys(raw);
    expect(Object.keys(keys).sort()).toEqual(['v1', 'v2']);
  });

  it('長さの違う鍵は黙って捨てる', () => {
    const raw = `v1:${KEY_V1.toString('base64')},v2:${randomBytes(16).toString('base64')}`;
    expect(Object.keys(parseEncryptionKeys(raw))).toEqual(['v1']);
  });

  it('壊れた並びでも例外にしない（内容がログへ出るため）', () => {
    expect(Object.keys(parseEncryptionKeys('これは鍵ではない'))).toEqual([]);
    expect(Object.keys(parseEncryptionKeys(''))).toEqual([]);
  });
});
