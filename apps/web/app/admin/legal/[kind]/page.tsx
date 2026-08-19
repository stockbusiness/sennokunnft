import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader, StatusBadge } from '@sengoku/ui';
import { fetchLegalVersions } from '../../../../src/admin-client';
import { ADMIN_COPY } from '../../../../src/admin-copy';
import { LEGAL_COPY, LEGAL_KIND_LABEL, versionStatusLabel } from '../../../../src/legal-copy';
import type { LegalDocumentKind, LegalVersionView } from '../../../../src/legal-types';
import { DraftForm, PublishForm } from '../forms';

/**
 * 法務文書の編集画面。
 *
 * ⚠️ **「適用中」を保存された印から出さない。** API が毎回、施行日と
 * 現在時刻から決めたものを返す。画面で作り直すと、公開ページと
 * 食い違う。
 *
 * ⚠️ **過去の版を消す操作を置かない。** API にも無い。
 */
const KINDS: readonly LegalDocumentKind[] = ['terms', 'privacy', 'tokushoho'];

function isKind(value: string): value is LegalDocumentKind {
  return (KINDS as readonly string[]).includes(value);
}

export default async function AdminLegalKindPage({
  params,
}: {
  readonly params: Promise<{ readonly kind: string }>;
}) {
  const { kind } = await params;
  if (!isKind(kind)) {
    notFound();
  }

  const result = await fetchLegalVersions(kind);
  if (!result.ok) {
    return (
      <>
        <PageHeader title={LEGAL_KIND_LABEL[kind]} />
        <EmptyState
          title={ADMIN_COPY.unavailableTitle(result.reason)}
          hint={ADMIN_COPY.unavailableHint}
        />
      </>
    );
  }

  const versions = result.data.versions;
  const draft = versions.find((version) => version.status === 'draft') ?? null;
  const effective = versions.find((version) => version.isEffective) ?? null;

  return (
    <>
      <PageHeader title={LEGAL_KIND_LABEL[kind]} description={LEGAL_COPY.adminDescription} />

      {/* ⚠️ いちばん先に出す。公開は取り消せない。 */}
      <Notice
        tone="info"
        title={LEGAL_COPY.immutableNotice}
        hint={LEGAL_COPY.immutableNoticeHint}
      />

      <section>
        <h2>{LEGAL_COPY.draftHeading}</h2>
        {draft === null ? <p>{LEGAL_COPY.draftNone}</p> : null}
        {draft !== null && draft.missingFields.length > 0 ? (
          <Notice
            tone="alert"
            title={LEGAL_COPY.missingHeading}
            hint={draft.missingFields.map(fieldLabel).join('、')}
          />
        ) : null}
        <DraftForm kind={kind} draft={draft} />
      </section>

      {draft === null ? null : (
        <section>
          <h2>{LEGAL_COPY.publishHeading}</h2>
          <PublishForm kind={kind} />
        </section>
      )}

      <section>
        <h2>{LEGAL_COPY.historyHeading}</h2>
        {versions.length === 0 ? (
          <p>{LEGAL_COPY.draftNone}</p>
        ) : (
          <ul className="sengoku-admin__list">
            {versions.map((version) => (
              <li key={version.id}>
                <span>第{version.version}版</span>{' '}
                <StatusBadge
                  tone={badgeTone(version, effective)}
                  label={versionStatusLabel(
                    version,
                    effective !== null && effective.version > version.version,
                  )}
                />{' '}
                <span>{version.title}</span> <span>{formatDateTime(version.effectiveFrom)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function badgeTone(
  version: LegalVersionView,
  effective: LegalVersionView | null,
): 'neutral' | 'progress' | 'success' {
  if (version.status === 'draft') {
    return 'progress';
  }
  return effective !== null && effective.id === version.id ? 'success' : 'neutral';
}

function fieldLabel(key: string): string {
  return key === 'bodyText' ? LEGAL_COPY.missingBody : key;
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('ja-JP', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Tokyo',
      }).format(date);
}
