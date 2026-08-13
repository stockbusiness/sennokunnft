import type { ReactNode } from 'react';
import { formatMoney, type MoneyView } from './format';

/**
 * 状態を持たないプレゼンテーション部品。
 *
 * ⚠️ ここに API 呼び出しや業務判断を書かない。
 * `@sengoku/ui` は `@sengoku/domain` にも依存しない（依存検査で強制）。
 * 画面がドメイン規則を再実装すると、サーバー側の判定と乖離する。
 */

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
