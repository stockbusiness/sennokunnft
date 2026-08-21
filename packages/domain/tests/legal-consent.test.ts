import { describe, expect, it } from 'vitest';
import {
  CONSENT_REQUIRED_KINDS,
  evaluateConsentRequirement,
  requiresConsent,
  snapshotForOrder,
  type LegalConsentRecord,
  type LegalDocumentVersion,
} from '../src/index';

const NOW = new Date('2026-08-19T00:00:00.000Z');

function version(overrides: Partial<LegalDocumentVersion> = {}): LegalDocumentVersion {
  return {
    id: 'version-1',
    kind: 'terms',
    version: 1,
    status: 'published',
    title: '利用規約',
    bodyText: '本文',
    tokushoho: null,
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    requiresReconsent: false,
    publishedAt: NOW,
    noticesEnqueuedAt: null,
    createdByAccountId: 'account-1',
    publishedByAccountId: 'account-1',
    createdAt: NOW,
    ...overrides,
  };
}

function consent(version: number): LegalConsentRecord {
  return {
    accountId: 'account-buyer',
    kind: 'terms',
    versionId: `version-${String(version)}`,
    version,
    consentedAt: NOW,
  };
}

describe('同意を求める文書', () => {
  /*
    ⚠️ **プライバシーポリシーを束ねない。** 個人情報保護法では利用目的は
       原則「公表」で足り、「同意」が要るのは第三者提供などの場面。
       束ねると、必要な同意が取れていないのに取れたつもりになる。
  */
  it('利用規約と販売規約', () => {
    expect(CONSENT_REQUIRED_KINDS).toEqual(['terms', 'creator_terms']);
    expect(requiresConsent('terms')).toBe(true);
    /*
      ⚠️ **販売規約は「同意が要る文書」だが、ログイン時には求めない**（P1-2）。
         こちらと作家さまのあいだの取り決めなので承諾が要る一方、
         **買うだけの方に販売規約を承諾させない**。ログイン時の判定は
         `LegalService` が `'terms'` だけを見る（束ねていない）。
    */
    expect(requiresConsent('creator_terms')).toBe(true);
    expect(requiresConsent('privacy')).toBe(false);
    expect(requiresConsent('tokushoho')).toBe(false);
  });
});

describe('同意を求めるべきか', () => {
  /*
    ⚠️ **ここがいちばん大事。** 規約が未公開のときに同意を求めると、
       立ち上げ時に誰もログインできなくなる。規約を公開できるのは
       管理画面へ入れる人で、その人が入れなければ永久に公開できない。
       締め出しは復旧の手立てが無い。
  */
  it('規約が未公開なら求めない（締め出しを作らない）', () => {
    const result = evaluateConsentRequirement({
      effective: null,
      latestConsent: null,
      hasPendingReconsent: false,
    });
    expect(result).toEqual({ required: false, reason: 'no_document' });
  });

  it('一度も同意していなければ求める', () => {
    const result = evaluateConsentRequirement({
      effective: version(),
      latestConsent: null,
      hasPendingReconsent: false,
    });
    expect(result.required).toBe(true);
    if (result.required) {
      expect(result.reason).toBe('never_consented');
      expect(result.version.id).toBe('version-1');
    }
  });

  it('いまの版に同意済みなら求めない', () => {
    const result = evaluateConsentRequirement({
      effective: version(),
      latestConsent: consent(1),
      hasPendingReconsent: false,
    });
    expect(result).toEqual({ required: false, reason: 'already_consented' });
  });

  /*
    ⚠️ **「新しい版が出た」だけでは求めない。** 誤字を直しただけの改定で
       全員を止めると、同意の画面が「とりあえず押すもの」になり、
       同意という記録の意味が薄れる。
  */
  it('新しい版が出ても、再同意の印が無ければ求めない', () => {
    const result = evaluateConsentRequirement({
      effective: version({ id: 'version-2', version: 2 }),
      latestConsent: consent(1),
      hasPendingReconsent: false,
    });
    expect(result).toEqual({ required: false, reason: 'already_consented' });
  });

  it('再同意の印が立っていれば求める', () => {
    const result = evaluateConsentRequirement({
      effective: version({ id: 'version-2', version: 2, requiresReconsent: true }),
      latestConsent: consent(1),
      hasPendingReconsent: true,
    });
    expect(result.required).toBe(true);
    if (result.required) {
      expect(result.reason).toBe('reconsent');
      expect(result.version.version).toBe(2);
    }
  });

  it('同意した版のほうが新しければ求めない（予約公開をまたいだ場合）', () => {
    const result = evaluateConsentRequirement({
      effective: version({ version: 2 }),
      latestConsent: consent(3),
      hasPendingReconsent: true,
    });
    expect(result).toEqual({ required: false, reason: 'already_consented' });
  });
});

describe('注文へ残す版', () => {
  /*
    ⚠️ **同意の記録ではない。** 「何が表示されていたか」の記録で、
       価格・手数料率と同じスナップショット原則。
  */
  it('施行中の版を写す', () => {
    expect(snapshotForOrder(version({ id: 'v9', version: 9 }))).toEqual({
      termsVersionId: 'v9',
      termsVersion: 9,
    });
  });

  it('規約が未公開なら null のまま残す（それらしい版で取り繕わない）', () => {
    expect(snapshotForOrder(null)).toEqual({ termsVersionId: null, termsVersion: null });
  });
});
