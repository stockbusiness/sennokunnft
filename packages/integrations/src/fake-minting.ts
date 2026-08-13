import { createHash } from 'node:crypto';
import type { MintRequest, MintStatus, MintSubmission, MintingPort } from '@sengoku/domain';

/**
 * 開発・テスト用の擬似発行プロバイダ。
 *
 * ✅ 本番ブロックチェーンへ接続しない。秘密鍵を扱わない。
 * ネットワーク通信を一切行わないため、テストが決定論的かつ高速になる。
 *
 * チェーン選定（UD-501）とカストディ方式（UD-502）が未決定であり、
 * 実プロバイダのアダプタは**決定されるまで実装しない**。
 * 返す識別子はすべて不透明な文字列で、実在のチェーン形式を模倣していない。
 */
export class FakeMintingAdapter implements MintingPort {
  public readonly provider = 'fake';

  /** 冪等キー → 依頼内容。同一キーの再依頼で新しい発行を作らない。 */
  private readonly submissions = new Map<string, { request: MintRequest; ref: string }>();
  private readonly failFor: ReadonlySet<string>;

  /**
   * @param failingEntitlementIds 失敗させる受取権ID（再試行の検証用）
   */
  constructor(failingEntitlementIds: readonly string[] = []) {
    this.failFor = new Set(failingEntitlementIds);
  }

  submit(request: MintRequest): Promise<MintSubmission> {
    if (this.failFor.has(request.entitlementId)) {
      return Promise.resolve({
        submissionRef: `fake-failed-${request.idempotencyKey}`,
        state: 'failed',
      });
    }

    // 冪等キーが同じなら、既存の依頼をそのまま返す（多重発行を作らない）。
    const existing = this.submissions.get(request.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve({ submissionRef: existing.ref, state: 'succeeded' });
    }

    const ref = `fake-sub-${this.deterministicRef(request.idempotencyKey)}`;
    this.submissions.set(request.idempotencyKey, { request, ref });
    return Promise.resolve({ submissionRef: ref, state: 'succeeded' });
  }

  getStatus(submissionRef: string): Promise<MintStatus> {
    if (submissionRef.startsWith('fake-failed-')) {
      return Promise.resolve({ state: 'failed', errorCode: 'FAKE_PROVIDER_REJECTED' });
    }

    const entry = [...this.submissions.values()].find((item) => item.ref === submissionRef);
    if (entry === undefined) {
      return Promise.resolve({ state: 'failed', errorCode: 'SUBMISSION_NOT_FOUND' });
    }

    const token = this.deterministicRef(entry.request.entitlementId);
    return Promise.resolve({
      state: 'succeeded',
      // 値の形式はチェーン非依存。決定後に実プロバイダのアダプタへ差し替える。
      chainRef: 'fake:local',
      contractRef: 'fake:collection',
      tokenRef: token,
      txRef: `fake-tx-${token}`,
    });
  }

  /** 依頼数を確認するための、テスト向けの覗き窓。 */
  submissionCount(): number {
    return this.submissions.size;
  }

  private deterministicRef(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }
}
