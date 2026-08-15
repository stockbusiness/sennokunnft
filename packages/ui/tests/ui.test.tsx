import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  ARTWORK_IMAGE_MISSING,
  ArtworkCard,
  ArtworkImage,
  EmptyState,
  Notice,
  PageHeader,
  PriceTag,
  SiteFooter,
  SiteHeader,
  StatusBadge,
  formatMoney,
  UI_TERMS,
} from '../src/index';

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

describe('作品画像', () => {
  it('作品名をそのまま代替テキストにする', () => {
    // ⚠️ 「◯◯の画像」にしない。読み上げは要素の種類を先に伝えるので、
    //    「画像 ◯◯の画像」と二重になる。
    render(<ArtworkImage src="https://media.example.jp/a.png" title="朝霧の里" />);
    const img = screen.getByRole('img', { name: '朝霧の里' });
    expect(img.getAttribute('alt')).toBe('朝霧の里');
    expect(img.getAttribute('src')).toBe('https://media.example.jp/a.png');
  });

  it('画像が無くても場所と作品名を保つ', () => {
    // 高さが後から変わると、読んでいる最中に押す場所がずれる。
    render(<ArtworkImage src={null} title="朝霧の里" />);
    expect(screen.getByRole('img', { name: '朝霧の里' })).toBeDefined();
    expect(screen.getByText(ARTWORK_IMAGE_MISSING)).toBeDefined();
  });

  it('形の指定が寸法の手掛かりとして残る', () => {
    const { container } = render(<ArtworkImage src={null} title="朝霧の里" shape="square" />);
    expect(container.querySelector('.sengoku-artwork-image--square')).not.toBeNull();
  });
});

describe('ArtworkCard', () => {
  const base = {
    title: '朝霧の里',
    href: '/artworks/asagiri',
    imageUrl: 'https://media.example.jp/a.png',
    price: { amount: 12000, currency: 'JPY' },
    availableSupply: 8,
    maxSupply: 20,
    purchasable: true,
  } as const;

  it('画像と作品名を 1 つのリンクにまとめる', () => {
    // ⚠️ 分けると同じ行き先のリンクが 2 つ並び、読み上げでも Tab 移動でも
    //    同じ場所を 2 回通ることになる。
    render(<ArtworkCard {...base} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/artworks/asagiri');
    expect(screen.getByRole('img', { name: '朝霧の里' })).toBeDefined();
  });

  it('買えるときは販売中と出す', () => {
    render(<ArtworkCard {...base} />);
    expect(screen.getByText('販売中')).toBeDefined();
    expect(screen.getByText('（税込）')).toBeDefined();
  });

  it('買えないときは渡された言い回しを出す', () => {
    // ⚠️ 判定はサーバーが持つ。ここで条件を組み直すと表示と購入可否が食い違う。
    render(<ArtworkCard {...base} purchasable={false} statusLabel="完売しました" />);
    expect(screen.getByText('完売しました')).toBeDefined();
  });

  it('価格が未設定なら金額を出さずに準備中と伝える', () => {
    render(<ArtworkCard {...base} price={null} />);
    expect(screen.getByText('準備中')).toBeDefined();
    expect(screen.queryByText('（税込）')).toBeNull();
  });

  it('画像が無くても崩れずに代替を出す', () => {
    render(<ArtworkCard {...base} imageUrl={null} />);
    expect(screen.getByText(ARTWORK_IMAGE_MISSING)).toBeDefined();
  });
});

describe('共通の頭と足', () => {
  it('行き先の無い項目を並べない', () => {
    // ⚠️ 押せるのに何も無いページへ着くと、利用者は自分の操作を疑う。
    render(<SiteHeader siteName="デジタル作品マーケット" />);
    // ロゴ位置のリンク 1 本だけ。
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('現在地を読み上げにも伝える', () => {
    render(
      <SiteHeader
        siteName="デジタル作品マーケット"
        navItems={[{ label: '作品一覧', href: '/' }]}
        currentHref="/"
      />,
    );
    expect(screen.getByRole('link', { name: '作品一覧' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('足はサイト名を出す', () => {
    render(<SiteFooter siteName="デジタル作品マーケット" />);
    expect(screen.getByText('デジタル作品マーケット')).toBeDefined();
  });
});

describe('Notice', () => {
  it('取得に失敗したときだけ割り込みとして知らせる', () => {
    render(
      <Notice tone="alert" title="ただいま作品を表示できません" hint="しばらくお待ちください" />,
    );
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('ふだんの案内は割り込みにしない', () => {
    render(<Notice title="お申し込み機能は準備中です。" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
