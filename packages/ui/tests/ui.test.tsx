import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EmptyState, PageHeader, PriceTag, StatusBadge, formatMoney, UI_TERMS } from '../src/index';

// 各テストの後で DOM を掃除する。掃除しないと前のテストで描画した要素が残り、
// 「表示されないこと」の検証が偽陰性になる。
afterEach(() => {
  cleanup();
});

describe('formatMoney', () => {
  it('JPY は小数を付けずに整形する', () => {
    // 内部表現は最小通貨単位の整数。JPY の最小通貨単位は 1 円。
    expect(formatMoney({ amount: 12000, currency: 'JPY' })).toContain('12,000');
  });

  it('USD は小数 2 桁として整形する', () => {
    expect(formatMoney({ amount: 1250, currency: 'USD' }, 'en-US')).toBe('$12.50');
  });

  it('0 円を表示できる', () => {
    expect(formatMoney({ amount: 0, currency: 'JPY' })).toContain('0');
  });
});

describe('UI 用語（Web3 用語を表に出さない）', () => {
  it.each(Object.entries(UI_TERMS))('%s の表示が日本語表記になっている', (_key, label) => {
    expect(label).not.toMatch(/NFT|Mint|Wallet/i);
  });
});

describe('コンポーネント', () => {
  it('PageHeader が見出しを表示する', () => {
    render(<PageHeader title="デジタル作品一覧" description="現在販売中の作品です" />);
    expect(screen.getByRole('heading', { name: 'デジタル作品一覧' })).toBeDefined();
    expect(screen.getByText('現在販売中の作品です')).toBeDefined();
  });

  it('PriceTag が税込表記を併記する', () => {
    render(<PriceTag price={{ amount: 12000, currency: 'JPY' }} />);
    expect(screen.getByText('（税込）')).toBeDefined();
  });

  it('PriceTag は税込表記を省略できる', () => {
    render(<PriceTag price={{ amount: 12000, currency: 'JPY' }} taxIncluded={false} />);
    expect(screen.queryByText('（税込）')).toBeNull();
  });

  it('StatusBadge が状態のトーンを属性で表す', () => {
    render(<StatusBadge label="受取り待ち" tone="progress" />);
    expect(screen.getByText('受取り待ち').getAttribute('data-tone')).toBe('progress');
  });

  it('EmptyState が支援テキスト付きで表示される', () => {
    render(<EmptyState title="まだ作品がありません" hint="購入すると表示されます" />);
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.getByText('購入すると表示されます')).toBeDefined();
  });
});
