import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  AttestationListResponse,
  ProductionReadinessResponse,
  RecordAttestationRequest,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
  decideAttestation,
  evaluateProductionReadiness,
  type AttestationPort,
  type AuditLogPort,
  type ClockPort,
  type IntegrationEnvironment,
  type ProductionReadiness,
  type ProductionReadinessPort,
  type ProductionReadinessThresholds,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 本番販売ガード（実運営 指示書 P0-7）。
 *
 * **売れる状態と、売ってよい状態は別である。** 10 条件がそろうまで、
 * 本番の支払い口を作らせない。
 *
 * ⚠️ **判定を毎回やり直す。** 「一度そろったから以後は通す」という
 * 記憶を持たない。条件は崩れるもので、崩れたことに気づかないまま
 * 売り続けるのがいちばん困る。
 *
 * ⚠️ **本番でだけ止める。** staging では判定はするが止めない。止めると
 * 誰も試せず、本番で初めて動かすことになる。**判定そのものはどちらの
 * 環境でも同じ**で、違うのは「止めるかどうか」だけ。
 */
@Injectable()
export class ProductionReadinessService {
  constructor(
    private readonly readiness: ProductionReadinessPort,
    private readonly attestations: AttestationPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    /** ⚠️ このプロセスの環境。要求から受け取らない。 */
    private readonly environment: IntegrationEnvironment,
    private readonly thresholds: ProductionReadinessThresholds = DEFAULT_PRODUCTION_READINESS_THRESHOLDS,
  ) {}

  /** ⚠️ **本番だけ止める。** staging は判定するが通す。 */
  get enforced(): boolean {
    return this.environment === 'production';
  }

  async evaluate(): Promise<ProductionReadiness & { readonly credentialId: string | null }> {
    const now = this.clock.now();
    const facts = await this.readiness.facts(now);
    const result = evaluateProductionReadiness({ facts, thresholds: this.thresholds, now });
    return { ...result, credentialId: facts.acceptingCredential?.id ?? null };
  }

  /**
   * 本番の支払い口を作ってよいか。
   *
   * ⚠️ **理由の内訳を返さない。** どの条件が欠けているかは運営の
   * 内部事情で、買おうとした方に伝えることではない。運営は管理画面で
   * 内訳を見られる。
   */
  async assertSellable(): Promise<void> {
    if (!this.enforced) {
      return;
    }
    const result = await this.evaluate();
    if (!result.ready) {
      throw new DomainErrorException('PRODUCTION_NOT_READY');
    }
  }

  async status(): Promise<ProductionReadinessResponse> {
    const result = await this.evaluate();
    return {
      ready: result.ready,
      enforced: this.enforced,
      environment: this.environment,
      checks: result.checks.map((row) => ({
        key: row.key,
        label: row.label,
        satisfied: row.satisfied,
        detail: row.detail,
        remedy: row.remedy,
      })),
      credentialId: result.credentialId,
      generatedAt: this.clock.now().toISOString(),
    };
  }

  async listAttestations(): Promise<AttestationListResponse> {
    const rows = await this.attestations.list(ATTESTATION_PAGE_SIZE);
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        succeeded: row.succeeded,
        credentialId: row.credentialId,
        attestedByAccountId: row.attestedByAccountId,
        note: row.note,
        attestedAt: row.attestedAt.toISOString(),
      })),
    };
  }

  /**
   * 証跡を残す。
   *
   * ⚠️ **`credentialId` を要求から受け取らない。** 受け取れると、いま
   * 受付中でない世代を指す証跡を作れてしまう。サーバー側でいまの世代へ
   * 紐づける。鍵が替われば、その証跡は自動で失効する。
   *
   * ⚠️ **10 条件が満たされていることを求めない。** 承認を先に取っておく
   * 運用（鍵の切り替え日に合わせて段取りする）ができなくなる。押した
   * 記録は残り、条件の判定は毎回やり直されるので、早く押しても近道に
   * ならない。
   */
  async attest(actor: Actor, request: RecordAttestationRequest): Promise<{ readonly id: string }> {
    const accountId = actor.accountId;
    if (accountId === null) {
      // ⚠️ ここへ来るのは配線の誤り。認可ガードが先に弾いている。
      throw new ForbiddenException();
    }

    const now = this.clock.now();
    const facts = await this.readiness.facts(now);
    const credential = facts.acceptingCredential;
    if (credential === null) {
      // ⚠️ 紐づける先が無い証跡を作らせない。何の証拠にもならない。
      throw new DomainErrorException('PRODUCTION_CREDENTIAL_MISSING');
    }

    const decision = decideAttestation({
      kind: request.kind,
      succeeded: request.succeeded,
      credentialId: credential.id,
      attestedByAccountId: accountId,
      note: request.note,
    });
    if (!decision.ok) {
      throw new DomainErrorException(
        decision.reason === 'NOTE_TOO_LONG'
          ? 'ATTESTATION_NOTE_TOO_LONG'
          : 'ATTESTATION_NOTE_REQUIRED',
      );
    }

    const id = await this.attestations.record(decision.command, now);
    await this.audit.record({
      actorAccountId: accountId,
      action: 'production.attest',
      targetType: 'production_attestation',
      targetId: id,
      /*
        ⚠️ **覚え書きを監査ログへ写さない。** 証跡の側に残っており、
           そちらは書き換えられない。写すと 2 か所に同じ文が散る。
      */
      summary: {
        kind: decision.command.kind,
        succeeded: decision.command.succeeded,
        credentialId: credential.id,
      },
    });
    return { id };
  }
}

/**
 * 一覧に出す件数。
 *
 * ⚠️ **少なくしない。** 証跡は消せないので、そのぶん「何度やり直したか」
 * が読めることに値打ちがある。
 */
const ATTESTATION_PAGE_SIZE = 50;
