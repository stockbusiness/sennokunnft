import { PageHeader } from '@sengoku/ui';
import { LEGAL_COPY, LEGAL_KIND_LABEL } from '../../../src/legal-copy';

/**
 * 法務の表記の入口。
 *
 * ⚠️ **1 画面に詰めない。** どれを編集しているのか分からなくなる。
 * 特に特商法は項目が 12 あるので、ほかと混ざると押し間違える。
 */
export default function AdminLegalIndexPage() {
  return (
    <>
      <PageHeader title={LEGAL_COPY.adminTitle} description={LEGAL_COPY.adminDescription} />
      <ul className="sengoku-admin__list">
        {(['terms', 'privacy', 'tokushoho', 'creator_terms'] as const).map((kind) => (
          <li key={kind}>
            <a href={`/admin/legal/${kind}`}>{LEGAL_KIND_LABEL[kind]}</a>
          </li>
        ))}
      </ul>
    </>
  );
}
