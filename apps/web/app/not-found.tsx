import { EmptyState, PageHeader } from '@sengoku/ui';
import { SITE_COPY } from '../src/site';

export default function NotFound() {
  return (
    <>
      <PageHeader title={SITE_COPY.notFoundTitle} />
      <EmptyState title={SITE_COPY.notFoundTitle} hint={SITE_COPY.notFoundHint} />
      <p>
        <a href="/">{SITE_COPY.backToCatalog}</a>
      </p>
    </>
  );
}
