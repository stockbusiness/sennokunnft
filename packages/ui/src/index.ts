/**
 * `@sengoku/ui` — 状態を持たない React プレゼンテーション部品。
 *
 * 責務:
 *  - 表示専用のコンポーネント
 *  - 表示用の整形（金額・用語）
 *
 * 責務ではないもの:
 *  - API 呼び出し / データ取得
 *  - 業務判断（`@sengoku/domain` に依存しない。依存検査で強制している）
 *  - 認可判定（画面の出し分けは UX のためであり、セキュリティ境界ではない）
 */
export {
  PageHeader,
  PriceTag,
  StatusBadge,
  EmptyState,
  type PageHeaderProps,
  type PriceTagProps,
  type StatusBadgeProps,
  type StatusToneName,
  type EmptyStateProps,
} from './components';

export { formatMoney, UI_TERMS, type MoneyView } from './format';
