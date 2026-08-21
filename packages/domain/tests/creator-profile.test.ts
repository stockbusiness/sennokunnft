import { describe, expect, it } from 'vitest';
import {
  CREATOR_BIO_MAX_LENGTH,
  CREATOR_LINK_MAX_COUNT,
  CREATOR_SETUP_KEYS,
  CREATOR_SHOP_NAME_MAX_LENGTH,
  creatorSetupChecklist,
  validateCreatorProfile,
} from '../src/creator/profile';

/** 作家さまのプロフィール（実運営 指示書 P1-2）。 */

const EMPTY = { shopName: null, bio: null, links: [], invoiceNumber: null };

describe('保存してよいか', () => {
  /*
    ⚠️ **すべて任意。** 埋めないと売れない作りにすると、作りたい人が
       最初の一歩で止まる。
  */
  it('空でも保存できる', () => {
    expect(validateCreatorProfile(EMPTY).ok).toBe(true);
  });

  it('前後の空白は落とし、空文字は null にする', () => {
    const result = validateCreatorProfile({ ...EMPTY, shopName: '  桜屋  ', bio: '   ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shopName).toBe('桜屋');
    expect(result.value.bio).toBeNull();
  });

  it('長すぎるショップ名は断る', () => {
    const result = validateCreatorProfile({
      ...EMPTY,
      shopName: 'あ'.repeat(CREATOR_SHOP_NAME_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('SHOP_NAME_TOO_LONG');
  });

  it('長すぎる紹介文は断る', () => {
    const result = validateCreatorProfile({
      ...EMPTY,
      bio: 'あ'.repeat(CREATOR_BIO_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BIO_TOO_LONG');
  });

  /*
    ⚠️ **消して保存しない。断る。** 消すと、書いた本人には消えたことが
       分からない。
  */
  it('HTML らしきものが混じっていたら断る', () => {
    const result = validateCreatorProfile({
      ...EMPTY,
      bio: '日本画を描いています<script>alert(1)</script>',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BIO_CONTAINS_HTML');
  });

  it('普通の紹介文は通る', () => {
    const result = validateCreatorProfile({
      ...EMPTY,
      bio: '日本画を描いています。1 < 2 のような表現も使えます。',
    });
    expect(result.ok).toBe(true);
  });
});

describe('SNS・Web サイト', () => {
  /*
    ⚠️ **`https` だけ。** 画面から辿る先が平文だと、そこで何が起きても
       分からない。`javascript:` は言うまでもない。
  */
  it.each([
    ['javascript:alert(1)'],
    ['http://example.test'],
    ['data:text/html,<script>alert(1)</script>'],
    ['ではないもの'],
  ])('%s は断る', (url) => {
    const result = validateCreatorProfile({ ...EMPTY, links: [{ label: 'X', url }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('LINK_URL_NOT_ALLOWED');
  });

  it('https は通る', () => {
    const result = validateCreatorProfile({
      ...EMPTY,
      links: [{ label: 'ホームページ', url: 'https://example.test/sakura' }],
    });
    expect(result.ok).toBe(true);
  });

  it('多すぎるリンクは断る', () => {
    const links = Array.from({ length: CREATOR_LINK_MAX_COUNT + 1 }, (_, i) => ({
      label: `link-${String(i)}`,
      url: 'https://example.test',
    }));
    const result = validateCreatorProfile({ ...EMPTY, links });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('TOO_MANY_LINKS');
  });

  it('表示名が空なら URL を表示名にする', () => {
    const result = validateCreatorProfile({
      ...EMPTY,
      links: [{ label: '  ', url: 'https://example.test' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.links[0]?.label).toBe('https://example.test');
  });
});

describe('インボイス登録番号', () => {
  it('T + 13 桁なら通る', () => {
    const result = validateCreatorProfile({ ...EMPTY, invoiceNumber: 'T1234567890123' });
    expect(result.ok).toBe(true);
  });

  it.each([['1234567890123'], ['T123'], ['T12345678901234'], ['Tabcdefghijklm']])(
    '%s は形が違うので断る',
    (invoiceNumber) => {
      const result = validateCreatorProfile({ ...EMPTY, invoiceNumber });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('INVOICE_NUMBER_MALFORMED');
    },
  );

  /*
    ⚠️ **免税事業者もいる。** 無いことは不備ではない。
  */
  it('未登録でもよい', () => {
    expect(validateCreatorProfile({ ...EMPTY, invoiceNumber: null }).ok).toBe(true);
  });
});

describe('売る準備', () => {
  const READY = {
    hasDisplayName: true,
    salesTermsAcceptedAt: new Date('2026-08-01T00:00:00.000Z'),
    hasPayoutAccount: true,
    hasInvoiceNumber: true,
  };

  it('4 つを、語彙どおりの順で返す', () => {
    expect(creatorSetupChecklist(READY).map((row) => row.key)).toEqual([...CREATOR_SETUP_KEYS]);
  });

  it('揃っていれば、すべて済み', () => {
    expect(creatorSetupChecklist(READY).every((row) => row.done)).toBe(true);
  });

  /*
    ⚠️ **免税事業者もいる。** インボイスだけは「必須ではない」。
  */
  it('インボイスだけは必須ではない', () => {
    const rows = creatorSetupChecklist(READY);
    expect(rows.find((row) => row.key === 'invoice_number')?.required).toBe(false);
    expect(rows.filter((row) => row.key !== 'invoice_number').every((row) => row.required)).toBe(
      true,
    );
  });

  /*
    ⚠️ **登録できるかのように見せない。** 振込先を預かる仕組みは
       まだ無い（P1-3）。
  */
  it('振込先は「準備中」と伝える', () => {
    const rows = creatorSetupChecklist({ ...READY, hasPayoutAccount: false });
    expect(rows.find((row) => row.key === 'payout_account')?.detail).toContain('準備中');
  });

  it('同意していなければ、そう出る', () => {
    const rows = creatorSetupChecklist({ ...READY, salesTermsAcceptedAt: null });
    expect(rows.find((row) => row.key === 'sales_terms_accepted')?.done).toBe(false);
  });

  /*
    ⚠️ **実在を確かめていないことを書く。** 国税庁の公表サイトでしか
       分からず、こちらでは確かめられない。
  */
  it('インボイスは「確認していない」と書く', () => {
    const rows = creatorSetupChecklist(READY);
    expect(rows.find((row) => row.key === 'invoice_number')?.detail).toContain(
      '確認はしていません',
    );
  });
});
