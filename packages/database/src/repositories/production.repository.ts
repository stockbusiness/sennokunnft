import {
  type AttestationFact,
  type AttestationKind,
  type AttestationPort,
  type AttestationRecord,
  type ConnectionCheckFact,
  type IntegrationEnvironment,
  type JobHeartbeat,
  type LegalDocumentKind,
  type ProductionReadinessFacts,
  type ProductionReadinessPort,
  type RecordAttestationCommand,
  PRODUCTION_REQUIRED_JOB_KEYS,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 本番販売ガードが必要とする事実を集める（実運営 指示書 P0-7）。
 *
 * ⚠️ **判定を持たない。集めるだけ。** 満たしているかどうかはドメインが
 * 決める。ここで判定すると、しきい値を変えるのに SQL を触ることになる。
 *
 * ⚠️ **秘密を読まない。** 鍵の暗号文には触れず、有無と確認の結果だけを見る。
 * `open`（復号）を呼ばないのは、この経路が画面から呼ばれるため。
 */
export class PrismaProductionReadinessRepository implements ProductionReadinessPort {
  constructor(
    private readonly prisma: PrismaClient,
    /** ⚠️ **プロセスの環境。要求から受け取らない。** */
    private readonly environment: IntegrationEnvironment,
    private readonly provider: string,
  ) {}

  async facts(now: Date): Promise<ProductionReadinessFacts> {
    const [credentials, feeSetting, legalVersions, walletCheck, mailCheck, jobs, owners] =
      await Promise.all([
        /*
          ⚠️ **受付中の世代を SQL で 1 件に絞らない。** 2 件あるのは
             異常であって、そのときに「たまたま先頭」を選ぶと、
             どちらの鍵が効いているか分からないまま売れてしまう。
             絞り込みはドメイン（`acceptingGeneration`）の仕事。
        */
        this.prisma.paymentCredential.findMany({
          where: { provider: this.provider, environment: this.environment, status: 'active' },
          select: {
            id: true,
            generation: true,
            acceptsNewPayments: true,
            lastCheckSucceeded: true,
            lastCheckAt: true,
            lastWebhookReceivedAt: true,
          },
        }),
        this.prisma.integrationSetting.findUnique({
          where: { service_environment: { service: 'payment', environment: this.environment } },
          select: { platformFeeRateBps: true },
        }),
        /*
          施行中の法務文書。⚠️ **「公開した」ではなく「施行日を迎えた」。**
             未来の施行日を入れた版を数えると、まだ掲げていないものを
             掲げたことにしてしまう。
        */
        this.prisma.legalDocumentVersion.findMany({
          where: { status: 'published', effectiveFrom: { lte: now } },
          select: { kind: true },
          distinct: ['kind'],
        }),
        latestCheck(this.prisma, 'ovew_wallet', this.environment),
        latestCheck(this.prisma, 'mail', this.environment),
        this.prisma.jobRun.findMany({
          where: { jobKey: { in: [...PRODUCTION_REQUIRED_JOB_KEYS] } },
        }),
        /*
          ⚠️ **停止中のオーナーは数えない。** 停止した人の記録で条件を
             満たせると、責任を引き受ける人が居ないまま通ってしまう。
        */
        this.prisma.account.findMany({
          where: { isOwner: true, status: 'active' },
          select: { id: true, lastAal2At: true },
        }),
      ]);

    const accepting =
      credentials.length === 1 && credentials[0]?.acceptsNewPayments === true
        ? credentials[0]
        : null;

    const [latestE2e, latestApproval] = await Promise.all([
      this.latest('e2e_sale_test'),
      this.latest('owner_approval'),
    ]);

    return {
      acceptingCredential:
        accepting === null
          ? null
          : {
              id: accepting.id,
              generation: accepting.generation,
              lastCheckSucceeded: accepting.lastCheckSucceeded,
              lastCheckAt: accepting.lastCheckAt,
              lastWebhookReceivedAt: accepting.lastWebhookReceivedAt,
            },
      platformFeeRateBps: feeSetting?.platformFeeRateBps ?? 0,
      publishedLegalKinds: legalVersions.map(
        (row: { kind: string }) => row.kind as LegalDocumentKind,
      ),
      walletCheck,
      mailCheck,
      jobs: jobs.map(
        (row: {
          jobKey: string;
          lastSucceededAt: Date | null;
          lastFailedAt: Date | null;
          lastOutcome: string | null;
        }): JobHeartbeat => ({
          jobKey: row.jobKey,
          lastSucceededAt: row.lastSucceededAt,
          lastFailedAt: row.lastFailedAt,
          lastOutcome: row.lastOutcome as JobHeartbeat['lastOutcome'],
        }),
      ),
      owners: owners.map((row: { id: string; lastAal2At: Date | null }) => ({
        accountId: row.id,
        lastAal2At: row.lastAal2At,
      })),
      latestE2eSaleTest: latestE2e,
      latestOwnerApproval: latestApproval,
    };
  }

  private async latest(kind: AttestationKind): Promise<AttestationFact | null> {
    const row = await this.prisma.productionAttestation.findFirst({
      where: { kind, environment: this.environment },
      // ⚠️ 「どこかに成功がある」ではなく「最新が成功か」。並べ替えを外さない。
      orderBy: [{ attestedAt: 'desc' }],
      select: { succeeded: true, credentialId: true, attestedAt: true },
    });
    return row === null
      ? null
      : { succeeded: row.succeeded, credentialId: row.credentialId, attestedAt: row.attestedAt };
  }
}

/**
 * 人が残す証跡（実運営 指示書 P0-7）。
 *
 * ⚠️ **`update` も `delete` も実装しない。** 口が無ければ、あとから
 * 足す人がまずここを読む。DB 側にもトリガーで止めてある
 * （`production_attestations_append_only`）。二重にしているのは、
 * 「アプリを通さない書き込み」も止めるため。
 */
export class PrismaAttestationRepository implements AttestationPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly environment: IntegrationEnvironment,
  ) {}

  async record(command: RecordAttestationCommand, now: Date): Promise<string> {
    const row = await this.prisma.productionAttestation.create({
      data: {
        kind: command.kind,
        environment: this.environment,
        succeeded: command.succeeded,
        credentialId: command.credentialId,
        attestedByAccountId: command.attestedByAccountId,
        note: command.note,
        attestedAt: now,
      },
      select: { id: true },
    });
    return row.id;
  }

  async latest(kind: AttestationKind): Promise<AttestationFact | null> {
    const row = await this.prisma.productionAttestation.findFirst({
      where: { kind, environment: this.environment },
      orderBy: [{ attestedAt: 'desc' }],
      select: { succeeded: true, credentialId: true, attestedAt: true },
    });
    return row === null
      ? null
      : { succeeded: row.succeeded, credentialId: row.credentialId, attestedAt: row.attestedAt };
  }

  async list(limit: number): Promise<readonly AttestationRecord[]> {
    const rows = await this.prisma.productionAttestation.findMany({
      where: { environment: this.environment },
      orderBy: [{ attestedAt: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as AttestationKind,
      succeeded: row.succeeded,
      credentialId: row.credentialId,
      attestedByAccountId: row.attestedByAccountId,
      note: row.note,
      attestedAt: row.attestedAt,
    }));
  }
}

/**
 * その相手への直近の接続確認。
 *
 * ⚠️ **成功だけを拾わない。** 直近が失敗しているなら、それが現状である。
 * 成功だけを拾うと、いま壊れているのに「前に成功した」で通ってしまう。
 */
async function latestCheck(
  prisma: PrismaClient,
  service: string,
  environment: IntegrationEnvironment,
): Promise<ConnectionCheckFact | null> {
  const row = await prisma.integrationConnectionCheck.findFirst({
    where: { service, environment },
    orderBy: [{ executedAt: 'desc' }],
    select: { succeeded: true, executedAt: true },
  });
  return row === null ? null : { succeeded: row.succeeded, executedAt: row.executedAt };
}
