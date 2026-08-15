import type { ReactNode } from 'react';
import { formatMoney, type MoneyView } from './format';

/**
 * 状態を持たないプレゼンテーション部品。
 *
 * ⚠️ ここに API 呼び出しや業務判断を書かない。
 * `@sengoku/ui` は `@sengoku/domain` にも依存しない（依存検査で強制）。
 * 画面がドメイン規則を再実装すると、サーバー側の判定と乖離する。
 */

export interface SiteLink {
  readonly label: string;
  readonly href: string;
}

export interface SiteHeaderProps {
  readonly siteName: string;
  /**
   * ⚠️ **行き先の無い項目を渡さない。**
   * 押せるのに何も無いページへ着くと、利用者は自分の操作を疑う。
   * 用意できたページだけを渡すこと。
   */
  readonly navItems?: readonly SiteLink[];
  /** いま開いている項目の `href`。読み上げにも見た目にも同じ値を使う。 */
  readonly currentHref?: string;
}

/**
 * 全ページ共通の頭。
 *
 * ⚠️ **ロゴ画像はまだ受け取っていないので、文字だけで組んである。**
 * 似せた印を描き起こさないのは、正式なロゴが入ったときに
 * 「似ているだけの別物」が残るため。差し込む場所だけ空けてある。
 */
export function SiteHeader({ siteName, navItems = [], currentHref }: SiteHeaderProps): ReactNode {
  return (
    <header className="sengoku-site-header">
      <div className="sengoku-site-header__inner">
        <a className="sengoku-brand" href="/">
          <span className="sengoku-brand__name">{siteName}</span>
        </a>
        {navItems.length > 0 ? (
          <nav className="sengoku-site-nav" aria-label="主要">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                // ⚠️ 現在地を色や下線だけで示さない。読み上げにも伝える。
                aria-current={item.href === currentHref ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </header>
  );
}

export interface SiteFooterProps {
  readonly siteName: string;
  readonly links?: readonly SiteLink[];
}

export function SiteFooter({ siteName, links = [] }: SiteFooterProps): ReactNode {
  return (
    <footer className="sengoku-site-footer">
      <div className="sengoku-site-footer__inner">
        <span className="sengoku-site-footer__name">{siteName}</span>
        {links.length > 0 ? (
          <nav aria-label="補助">
            {links.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </footer>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
}

export function PageHeader({ title, description }: PageHeaderProps): ReactNode {
  return (
    <header className="sengoku-page-header">
      <h1>{title}</h1>
      {description !== undefined ? <p>{description}</p> : null}
    </header>
  );
}

/** 画像が無いときに出す言葉。1 か所に置く。 */
export const ARTWORK_IMAGE_MISSING = '画像は準備中です';

export interface ArtworkImageProps {
  readonly src: string | null;
  /**
   * 作品名をそのまま渡す。
   *
   * ⚠️ 「◯◯の画像」のような説明を足さない。読み上げは要素の種類を先に
   * 伝えるので、「画像 ◯◯の画像」と二重になる。
   */
  readonly title: string;
  /** 一覧は横長、詳細は正方形。場所を先に確保するために使う。 */
  readonly shape?: 'wide' | 'square';
}

/**
 * 作品画像。
 *
 * ⚠️ **画像が無い場合も同じ大きさの場所を取る。**
 * 縦の寸法を先に決めておかないと、読み込みが終わった瞬間に下の文字が飛ぶ。
 * 読んでいる最中に動くと、押そうとしたものを押し損ねる。
 *
 * ⚠️ 公開された作品は必ず画像を持つ（公開時にサーバーが要求する）。
 * それでも `null` を受け付けるのは、保存先の障害や過去データの取りこぼしで
 * 欠けたときに**画面ごと崩れないようにする**ため。
 */
export function ArtworkImage({ src, title, shape = 'wide' }: ArtworkImageProps): ReactNode {
  const className = `sengoku-artwork-image sengoku-artwork-image--${shape}`;
  if (src === null) {
    return (
      <div className={`${className} sengoku-artwork-image--missing`} role="img" aria-label={title}>
        <span>{ARTWORK_IMAGE_MISSING}</span>
      </div>
    );
  }
  return (
    <div className={className}>
      {/* 一覧では折り返しより下にある画像が多いので、既定で遅延読み込みにする。 */}
      <img src={src} alt={title} loading="lazy" decoding="async" />
    </div>
  );
}

export interface PriceTagProps {
  readonly price: MoneyView;
  /** 税込表記を併記するか。表示要件は事業側の確認待ち（UD-106 / UD-401）。 */
  readonly taxIncluded?: boolean;
}

export function PriceTag({ price, taxIncluded = true }: PriceTagProps): ReactNode {
  return (
    <span className="sengoku-price">
      {formatMoney(price)}
      {taxIncluded ? <span className="sengoku-price__note">（税込）</span> : null}
    </span>
  );
}

export type StatusToneName = 'neutral' | 'progress' | 'success' | 'warning';

export interface StatusBadgeProps {
  readonly label: string;
  readonly tone?: StatusToneName;
}

export function StatusBadge({ label, tone = 'neutral' }: StatusBadgeProps): ReactNode {
  return (
    <span className={`sengoku-badge sengoku-badge--${tone}`} data-tone={tone}>
      {label}
    </span>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly hint?: string;
}

export function EmptyState({ title, hint }: EmptyStateProps): ReactNode {
  return (
    <div className="sengoku-empty-state" role="status">
      <p className="sengoku-empty-state__title">{title}</p>
      {hint !== undefined ? <p className="sengoku-empty-state__hint">{hint}</p> : null}
    </div>
  );
}

export interface NoticeProps {
  readonly title: string;
  readonly hint?: string;
  /** `alert` は取得に失敗したときだけ。ふだんの案内は `info`。 */
  readonly tone?: 'info' | 'alert';
}

/**
 * 一行の案内。
 *
 * ⚠️ **色だけで区別しない。** 見出しの言葉で何が起きたか分かるようにする。
 */
export function Notice({ title, hint, tone = 'info' }: NoticeProps): ReactNode {
  return (
    <div
      className={`sengoku-notice sengoku-notice--${tone}`}
      role={tone === 'alert' ? 'alert' : undefined}
    >
      <p className="sengoku-notice__title">{title}</p>
      {hint !== undefined ? <p className="sengoku-notice__hint">{hint}</p> : null}
    </div>
  );
}

export interface ArtworkCardProps {
  readonly title: string;
  readonly href: string;
  readonly imageUrl: string | null;
  readonly price: MoneyView | null;
  readonly availableSupply: number;
  readonly maxSupply: number;
  readonly purchasable: boolean;
  /** 買えないときの言い回し。判定はサーバーが持つので、ここは言葉を受け取るだけ。 */
  readonly statusLabel?: string;
}

/**
 * カタログ一覧の 1 件。
 *
 * 画像を先に置き、文字を後に置く。買う人が最初に見るのは絵であり、
 * 名前や値段はその次に確かめるもの。
 *
 * 残数を「◯点」とだけ出すのは、Web3 用語を避けるため。
 */
export function ArtworkCard({
  title,
  href,
  imageUrl,
  price,
  availableSupply,
  maxSupply,
  purchasable,
  statusLabel,
}: ArtworkCardProps): ReactNode {
  return (
    <article className="sengoku-artwork-card">
      {/*
        画像と作品名を 1 つのリンクにまとめる。
        分けると同じ行き先のリンクが 2 つ並び、読み上げでも Tab 移動でも
        同じ場所を 2 回通ることになる。
      */}
      <a href={href} className="sengoku-artwork-card__link">
        <ArtworkImage src={imageUrl} title={title} shape="wide" />
        <h2 className="sengoku-artwork-card__title">{title}</h2>
      </a>
      <div className="sengoku-artwork-card__body">
        {price === null ? (
          <StatusBadge label="準備中" tone="neutral" />
        ) : purchasable ? (
          <StatusBadge label="販売中" tone="success" />
        ) : (
          <StatusBadge label={statusLabel ?? 'ただいまお求めいただけません'} tone="warning" />
        )}
        <p className="sengoku-artwork-card__supply">
          残り {availableSupply} 点 / 全 {maxSupply} 点
        </p>
        {price === null ? null : <PriceTag price={price} />}
      </div>
    </article>
  );
}
