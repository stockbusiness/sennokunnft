import { Injectable } from '@nestjs/common';
import type { LivenessResponse, ReadinessCheck, ReadinessResponse } from '@sengoku/contracts';

/** readiness が確認する依存。Phase 1 では DB のみを想定している。 */
export interface DependencyProbe {
  readonly name: string;
  check(): Promise<{ ok: boolean; durationMs: number }>;
}

export const SERVICE_NAME = 'api';

/**
 * ヘルスチェックの判定。
 *
 * NestJS のデコレータが付いているのは注入のためだけで、
 * 中身は HTTP を知らない素の関数として書いてある。
 * 判定ロジックをコントローラに書かないのは、テストのために
 * HTTP を起動する必要をなくすため。
 */
@Injectable()
export class HealthService {
  private readonly startedAtMs: number;

  constructor(
    private readonly version: string,
    private readonly probes: readonly DependencyProbe[] = [],
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.startedAtMs = this.nowMs();
  }

  /**
   * Liveness。**外部依存を確認しない。**
   *
   * DB 障害で liveness まで失敗させると、コンテナが再起動を繰り返し、
   * DB 復旧後の立ち上がりを妨げる。
   */
  liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: this.version,
      uptimeSec: Math.floor((this.nowMs() - this.startedAtMs) / 1000),
    };
  }

  /**
   * Readiness。依存が使える場合のみ ok を返す。
   *
   * ⚠️ 応答に接続先・ホスト名・依存サービスの詳細を含めない。
   * ヘルスチェックは認証なしで到達できるため、内部構成の偵察に使われうる。
   */
  async readiness(): Promise<ReadinessResponse> {
    const checks: ReadinessCheck[] = [];

    for (const probe of this.probes) {
      const result = await probe.check();
      checks.push({
        name: probe.name,
        status: result.ok ? 'pass' : 'fail',
        durationMs: result.durationMs,
      });
    }

    const allPass = checks.every((check) => check.status === 'pass');
    return { status: allPass ? 'ok' : 'degraded', service: SERVICE_NAME, checks };
  }
}
