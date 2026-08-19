import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  LegalConsentStatus,
  LegalVersionListResponse,
  LegalVersionView,
  PublicLegalDocument,
  PublishLegalVersionRequest,
  RecordConsentRequest,
  SaveLegalDraftRequest,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  evaluateConsentRequirement,
  isErr,
  missingTokushohoFields,
  publishLegalVersion,
  saveLegalDraft,
  type AuditLogPort,
  type ClockPort,
  type LegalConsentRepository,
  type LegalDocumentKind,
  type LegalDocumentRepository,
  type LegalDocumentVersion,
  type TokushohoFields,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 法務文書の編集と公開。
 *
 * ⚠️ **判断はドメインが持つ。** 「公開済みは書き換えない」「欠けたまま
 * 公開しない」「さかのぼって施行しない」をここへ書き足さない。
 * 2 か所に散ると、片方を直したときにもう片方が残る。
 *
 * ⚠️ **公開ページと管理画面で、施行中の判定を分けない。** 同じ
 * リポジトリの同じ問い合わせを通す。分けると、管理画面には
 * 「適用中」と出ているのに利用者には古い文が見える、という
 * 気づきにくい食い違いが生まれる。
 */
@Injectable()
export class LegalService {
  constructor(
    private readonly legal: LegalDocumentRepository,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    private readonly consents: LegalConsentRepository,
  ) {}

  /** 公開ページ向け。⚠️ 下書きは決して出さない。 */
  async public(kind: LegalDocumentKind): Promise<PublicLegalDocument> {
    const now = this.clock.now();
    const version = await this.legal.findEffective(kind, now);
    return { kind, version: version === null ? null : toView(version, now) };
  }

  async list(kind: LegalDocumentKind): Promise<LegalVersionListResponse> {
    const now = this.clock.now();
    const versions = await this.legal.listVersions(kind);
    return { kind, versions: versions.map((version) => toView(version, now)) };
  }

  /**
   * 下書きを保存する。無ければ作る。
   *
   * ⚠️ **種類ごとに下書きは 1 つ。** 「新規作成」と「編集」を画面から
   * 分けさせない。分けると、下書きが 2 つある状態を運営が作れてしまい、
   * どちらを公開したのか誰にも分からなくなる。
   */
  async saveDraft(
    actor: Actor,
    kind: LegalDocumentKind,
    request: SaveLegalDraftRequest,
  ): Promise<LegalVersionView> {
    const now = this.clock.now();
    const accountId = actor.accountId;
    if (accountId === null) {
      throw new NotFoundException();
    }

    const existing = await this.legal.findDraft(kind);
    const base: LegalDocumentVersion = existing ??
      /*
        ⚠️ 作る前に、ドメインの検査を通す。作ってから弾くと、
           空の下書きだけが残る。
      */
      {
        id: '',
        kind,
        version: 0,
        status: 'draft',
        title: '',
        bodyText: kind === 'tokushoho' ? null : '',
        tokushoho: kind === 'tokushoho' ? emptyTokushoho() : null,
        effectiveFrom: null,
        requiresReconsent: false,
        publishedAt: null,
        createdByAccountId: accountId,
        publishedByAccountId: null,
        createdAt: now,
      };

    const validated = saveLegalDraft(base, {
      title: request.title,
      bodyText: request.bodyText ?? null,
      tokushoho: (request.tokushoho ?? null) as TokushohoFields | null,
    });
    if (isErr(validated)) {
      throw new DomainErrorException(validated.error.code);
    }
    const next = validated.value;

    const saved =
      existing === null
        ? await this.legal.create({
            kind,
            title: next.title,
            bodyText: next.bodyText,
            tokushoho: next.tokushoho,
            createdByAccountId: accountId,
          })
        : await this.legal.saveDraft({
            id: existing.id,
            title: next.title,
            bodyText: next.bodyText,
            tokushoho: next.tokushoho,
          });

    if (saved === null) {
      /*
        ⚠️ 下書きだったはずの行が、間に公開されていた。書き換えずに断る。
      */
      throw new DomainErrorException('LEGAL_VERSION_NOT_DRAFT');
    }

    await this.audit.record({
      actorAccountId: accountId,
      action: 'legal.draft_saved',
      targetType: 'legal_document_version',
      targetId: saved.id,
      // ⚠️ 本文を監査ログへ入れない。長いうえに、版そのものが残っている。
      summary: { kind, version: saved.version },
    });

    return toView(saved, now);
  }

  /**
   * 下書きを公開する。
   *
   * ⚠️ **取り消せない操作。** 公開した版は書き換えも削除もできない。
   * 誤りは新しい版で直す。だから公開はオーナーだけに開いてある。
   */
  async publish(
    actor: Actor,
    kind: LegalDocumentKind,
    request: PublishLegalVersionRequest,
  ): Promise<LegalVersionView> {
    const now = this.clock.now();
    const accountId = actor.accountId;
    if (accountId === null) {
      throw new NotFoundException();
    }

    const draft = await this.legal.findDraft(kind);
    if (draft === null) {
      throw new NotFoundException();
    }

    const current = await this.legal.findEffective(kind, now);
    const decided = publishLegalVersion({
      version: draft,
      effectiveFrom: new Date(request.effectiveFrom),
      publishedByAccountId: accountId,
      requiresReconsent: request.requiresReconsent,
      now,
      currentEffectiveFrom: current?.effectiveFrom ?? null,
    });
    if (isErr(decided)) {
      throw new DomainErrorException(decided.error.code);
    }

    const published = await this.legal.publish({
      id: draft.id,
      effectiveFrom: decided.value.effectiveFrom ?? now,
      publishedByAccountId: accountId,
      publishedAt: now,
      requiresReconsent: request.requiresReconsent,
    });
    if (published === null) {
      throw new DomainErrorException('LEGAL_VERSION_NOT_DRAFT');
    }

    await this.audit.record({
      actorAccountId: accountId,
      action: 'legal.published',
      targetType: 'legal_document_version',
      targetId: published.id,
      summary: {
        kind,
        version: published.version,
        effectiveFrom: published.effectiveFrom?.toISOString() ?? null,
        // ⚠️ 誰に再同意を求め始めたかは、あとから追えるようにする。
        requiresReconsent: published.requiresReconsent,
      },
    });

    return toView(published, now);
  }

  /**
   * その人に同意を求めるべきか（`UD-126`）。
   *
   * ⚠️ **規約をまだ公開していなければ、求めない。** 求める作りにすると、
   * 立ち上げ時に誰もログインできなくなる。規約を公開できるのは管理画面へ
   * 入れる人で、その人がログインできなければ永久に公開できない。
   * 締め出しは復旧の手立てが無いので、通す側へ倒す。
   */
  async consentStatus(actor: Actor): Promise<LegalConsentStatus> {
    const accountId = actor.accountId;
    if (accountId === null) {
      throw new NotFoundException();
    }
    const now = this.clock.now();
    const effective = await this.legal.findEffective('terms', now);
    const latestConsent = await this.consents.findLatestConsent(accountId, 'terms');
    const hasPendingReconsent =
      latestConsent === null
        ? false
        : await this.consents.hasPendingReconsent('terms', latestConsent.version, now);

    const requirement = evaluateConsentRequirement({
      effective,
      latestConsent,
      hasPendingReconsent,
    });

    return {
      required: requirement.required,
      reason: requirement.reason,
      version: requirement.required ? toView(requirement.version, now) : null,
      consentedVersion: latestConsent?.version ?? null,
    };
  }

  /**
   * 同意を記録する。
   *
   * ⚠️ **画面が見ていた版と、いま施行中の版が違えば断る。** 黙って
   * 差し替えると、利用者が読んだものと記録が食い違う。「読んでいない
   * 条件に同意したことになっている」がいちばん困る。
   */
  async recordConsent(actor: Actor, request: RecordConsentRequest): Promise<LegalConsentStatus> {
    const accountId = actor.accountId;
    if (accountId === null) {
      throw new NotFoundException();
    }
    const now = this.clock.now();
    const effective = await this.legal.findEffective('terms', now);
    if (effective === null || effective.id !== request.versionId) {
      throw new DomainErrorException('LEGAL_CONSENT_VERSION_MISMATCH');
    }

    await this.consents.recordConsent({
      accountId,
      kind: 'terms',
      versionId: effective.id,
      version: effective.version,
      consentedAt: now,
    });

    await this.audit.record({
      actorAccountId: accountId,
      action: 'legal.consented',
      targetType: 'legal_document_version',
      targetId: effective.id,
      summary: { kind: 'terms', version: effective.version },
    });

    return this.consentStatus(actor);
  }
}

function emptyTokushoho(): TokushohoFields {
  return {
    sellerName: '',
    representativeName: '',
    address: '',
    phoneNumber: '',
    contactEmail: '',
    priceDescription: '',
    additionalFees: '',
    paymentMethods: '',
    paymentTiming: '',
    deliveryTiming: '',
    returnPolicy: '',
    operatingEnvironment: '',
  };
}

function toView(version: LegalDocumentVersion, now: Date): LegalVersionView {
  return {
    id: version.id,
    kind: version.kind,
    version: version.version,
    status: version.status,
    title: version.title,
    bodyText: version.bodyText,
    tokushoho: version.tokushoho,
    effectiveFrom: version.effectiveFrom?.toISOString() ?? null,
    requiresReconsent: version.requiresReconsent,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    /*
      ⚠️ 保存された印ではなく、毎回ここで決める。予約公開があるので
         「公開済み＝いま適用中」ではない。
    */
    isEffective:
      version.status === 'published' &&
      version.effectiveFrom !== null &&
      version.effectiveFrom.getTime() <= now.getTime(),
    missingFields:
      version.kind === 'tokushoho'
        ? [...missingTokushohoFields(version.tokushoho)]
        : (version.bodyText ?? '').trim() === ''
          ? ['bodyText']
          : [],
  };
}
