import { PageHeader } from '@sengoku/ui';
import { SITE_COPY } from '../src/site';

export default function NotFound() {
  return (
    <>
      {/*
        ⚠️ 見出しと空状態で同じ文言を繰り返さない。
        同じ言葉が 2 度続くと、別々のことが起きたように読める。
      */}
      <PageHeader title={SITE_COPY.notFoundTitle} description={SITE_COPY.notFoundHint} />
      <p className="sengoku-back-link">
        <a href="/">← {SITE_COPY.backToCatalog}</a>
      </p>
    </>
  );
}
