import { notFound } from 'next/navigation';
import { EmptyState, PageHeader } from '@sengoku/ui';
import { renderLegalBody } from '@sengoku/contracts';
import { fetchLegalDocument } from '../../../src/api-client';
import { LEGAL_COPY, LEGAL_KIND_LABEL, TOKUSHOHO_LABEL } from '../../../src/legal-copy';
import type { LegalBlock, LegalDocumentKind } from '../../../src/legal-types';

/**
 * 法務文書の公開ページ。
 *
 * ⚠️ **HTML を差し込まない。** 本文は構造へ組み直してから React の要素で
 * 描く。`dangerouslySetInnerHTML` を使わない。法務文書は利用者が疑わずに
 * 読む場所なので、任意の内容を差し込める道を作らない。
 *
 * ⚠️ **静的化させない。** 管理画面から公開した内容が、次のビルドまで
 * 反映されないと、運営は「公開したのに変わらない」と読む。
 * 予約公開もあるので、時刻で切り替わる必要がある。
 */
export const dynamic = 'force-dynamic';

const KINDS: readonly LegalDocumentKind[] = ['terms', 'privacy', 'tokushoho'];

function isKind(value: string): value is LegalDocumentKind {
  return (KINDS as readonly string[]).includes(value);
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly kind: string }>;
}) {
  const { kind } = await params;
  return { title: isKind(kind) ? LEGAL_KIND_LABEL[kind] : '' };
}

export default async function LegalPage({
  params,
}: {
  readonly params: Promise<{ readonly kind: string }>;
}) {
  const { kind } = await params;
  if (!isKind(kind)) {
    notFound();
  }

  const result = await fetchLegalDocument(kind);
  if (!result.ok) {
    return (
      <>
        <PageHeader title={LEGAL_KIND_LABEL[kind]} />
        <EmptyState title={LEGAL_COPY.publicUnavailable} />
      </>
    );
  }

  const version = result.data.version;
  if (version === null) {
    /*
      ⚠️ **空の文を作って取り繕わない。** 「準備中」と正直に出す。
         それらしい文を置くと、購入者はそれを条件だと読む。
    */
    return (
      <>
        <PageHeader title={LEGAL_KIND_LABEL[kind]} />
        <EmptyState title={LEGAL_COPY.publicPreparingTitle} hint={LEGAL_COPY.publicPreparing} />
      </>
    );
  }

  return (
    <>
      <PageHeader title={version.title} />
      <section className="sengoku-legal">
        <p className="sengoku-legal__meta">
          {LEGAL_COPY.publicEffectiveFrom}: {formatDate(version.effectiveFrom)}（第
          {version.version}版）
        </p>

        {version.tokushoho === null ? (
          <LegalBody bodyText={version.bodyText ?? ''} />
        ) : (
          <dl className="sengoku-legal__fields">
            {Object.entries(version.tokushoho).map(([key, value]) => (
              <div key={key}>
                <dt>{TOKUSHOHO_LABEL[key] ?? key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}

/** 本文を、限られた印だけ解釈して描く。 */
export function LegalBody({ bodyText }: { readonly bodyText: string }) {
  const blocks = renderLegalBody(bodyText);
  return (
    <div className="sengoku-legal__body">
      {blocks.map((block, index) => (
        <LegalBlockView key={index} block={block} />
      ))}
    </div>
  );
}

function LegalBlockView({ block }: { readonly block: LegalBlock }) {
  if (block.type === 'heading') {
    return <h2>{block.text}</h2>;
  }
  if (block.type === 'list') {
    return (
      <ul>
        {block.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    );
  }
  return <p>{block.text}</p>;
}

function formatDate(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Tokyo',
      }).format(date);
}
