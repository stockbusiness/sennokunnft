import { describe, expect, it } from 'vitest';
import { resolveSiteName, SITE_COPY } from './site';

describe('resolveSiteName', () => {
  it('設定された名前を使う', () => {
    expect(resolveSiteName('千ノ国マーケット')).toBe('千ノ国マーケット');
  });

  it('未設定なら暫定名にフォールバックする（UD-101 が未決定のため）', () => {
    expect(resolveSiteName(undefined)).toBe(SITE_COPY.fallbackSiteName);
  });

  it('空文字・空白のみの場合もフォールバックする', () => {
    expect(resolveSiteName('')).toBe(SITE_COPY.fallbackSiteName);
    expect(resolveSiteName('   ')).toBe(SITE_COPY.fallbackSiteName);
  });

  it('前後の空白を取り除く', () => {
    expect(resolveSiteName('  マーケット  ')).toBe('マーケット');
  });
});

describe('表示文言', () => {
  it('Web3 用語を利用者向け文言に含めない', () => {
    // 購入者は暗号資産の知識を持たない前提（PRODUCT_REQUIREMENTS.md §2.2）。
    const allCopy = Object.values(SITE_COPY).join(' ');
    expect(allCopy).not.toMatch(/NFT|ミント|Mint|ウォレット|Wallet|ブロックチェーン/i);
  });

  it('投資性を想起させる表現を含めない', () => {
    expect(Object.values(SITE_COPY).join(' ')).not.toMatch(/値上がり|利益|投資|儲/);
  });
});
