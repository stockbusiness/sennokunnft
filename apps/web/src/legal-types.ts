/**
 * 画面が使う法務文書の型。
 *
 * ⚠️ **`@sengoku/domain` から直接引かない。** web はドメインへ依存できない
 * （`check:deps` の許可表）。契約の側が通してくれる分だけを使う。
 */
export type {
  LegalBlock,
  LegalDocumentKind,
  LegalVersionView,
  PublicLegalDocument,
} from '@sengoku/contracts';
