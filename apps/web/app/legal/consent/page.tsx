import { redirect } from 'next/navigation';
import { EmptyState, PageHeader } from '@sengoku/ui';
import { fetchConsentStatus } from '../../../src/legal-consent-client';
import { LEGAL_COPY } from '../../../src/legal-copy';
import { safeReturnPath } from '../../../src/auth/session';
import { LegalBody } from '../[kind]/page';
import { ConsentForm } from './form';

/**
 * 規約への同意（`UD-126`）。
 *
 * ⚠️ **求める必要が無ければ、素通しする。** 同意済みの人をここへ
 * 留めない。規約が未公開のときも同じで、**求めない**。求める作りに
 * すると、立ち上げ時に誰もログインできなくなる（規約を公開できるのは
 * 管理画面へ入れる人で、その人が入れなければ永久に公開できない）。
 *
 * ⚠️ **本文をここに出す。** リンクだけにすると、読まずに押される。
 */
export const dynamic = 'force-dynamic';

export default async function LegalConsentPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = params.next;
  const next = safeReturnPath(typeof rawNext === 'string' ? rawNext : null);

  const status = await fetchConsentStatus();
  if (!status.ok) {
    if (status.reason === 'unauthenticated') {
      redirect(`/login?next=${encodeURIComponent('/legal/consent')}`);
    }
    return (
      <>
        <PageHeader title={LEGAL_COPY.consentTitle} />
        <EmptyState title={LEGAL_COPY.publicUnavailable} />
      </>
    );
  }

  const version = status.data.version;
  if (!status.data.required || version === null) {
    // ⚠️ 同意済み・規約未公開のどちらでも、先へ通す。
    redirect(next);
  }

  return (
    <>
      <PageHeader
        title={LEGAL_COPY.consentTitle}
        description={
          status.data.reason === 'reconsent'
            ? LEGAL_COPY.consentIntroAgain
            : LEGAL_COPY.consentIntroFirst
        }
      />
      <section className="sengoku-legal">
        <h2>{version.title}</h2>
        <p className="sengoku-legal__meta">第{version.version}版</p>
        <LegalBody bodyText={version.bodyText ?? ''} />
      </section>
      <ConsentForm versionId={version.id} next={next} />
    </>
  );
}
