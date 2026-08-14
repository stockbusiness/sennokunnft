import { beforeEach, describe, expect, it } from 'vitest';
import {
  advanceCommonUserLink,
  applyFailure,
  applyResolution,
  backoffMinutes,
  isCommonUserId,
  isDueForAttempt,
  isUsableForClaim,
  MAX_LINK_ATTEMPTS,
  sweepCommonUserLinks,
  unresolvedLink,
  type CommonUserLink,
  type CommonUserLinkRepository,
  type LinkDependencies,
  type ResolveCommonUserInput,
  type ResolveCommonUserResult,
} from '../src/index';

/**
 * 共通顧客ID の紐付け（実装指示書 §5・§22.1）。
 *
 * ⚠️ 最も重いのは「外部の障害で購入を止めない」ことと、
 * 「一度決まった紐付けを黙って書き換えない」こと。
 */

const NOW = new Date('2026-06-01T00:00:00.000Z');
const CU_A = 'cu_' + 'a'.repeat(32);
const CU_B = 'cu_' + 'b'.repeat(32);

function link(overrides: Partial<CommonUserLink> = {}): CommonUserLink {
  return { ...unresolvedLink('account-1'), ...overrides };
}

function resolution(commonUserId = CU_A, overrides = {}) {
  return {
    commonUserId,
    matchedBy: 'system_account_link' as const,
    identityMatchStatus: 'ok',
    ...overrides,
  };
}

describe('common_user_id の形式', () => {
  it('cu_ + 32桁hex を受け入れる', () => {
    expect(isCommonUserId(CU_A)).toBe(true);
  });

  it('自社の account id のような値を拒否する', () => {
    // 取り違えてそのまま保存する事故を防ぐ。
    expect(isCommonUserId('00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isCommonUserId('cu_TOOSHORT')).toBe(false);
    expect(isCommonUserId(`cu_${'A'.repeat(32)}`)).toBe(false);
  });
});

describe('解決の受け入れ（§22.1 新規・既存）', () => {
  it('新規解決を受け入れて RESOLVED になる', () => {
    const result = applyResolution(link(), resolution(CU_A, { matchedBy: 'created' }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('RESOLVED');
    expect(result.value.commonUserId).toBe(CU_A);
    expect(result.value.linkedAt).toEqual(NOW);
  });

  it('既存解決（同じ値の再送）は RESOLVED のまま', () => {
    // §22.1「同一Account再送」。何度呼んでも同じ結果になる。
    const first = applyResolution(link(), resolution(CU_A), NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = applyResolution(first.value, resolution(CU_A), NOW);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.status).toBe('RESOLVED');
    expect(second.value.commonUserId).toBe(CU_A);
  });

  it('契約と違う形式の値は受け入れない', () => {
    const result = applyResolution(link(), resolution('not-a-common-user-id'), NOW);
    expect(result.ok).toBe(false);
  });

  it('名寄せ候補が残っていたら RESOLVED にしない', () => {
    // identity_match_status が ok でない＝同一人物が重複した可能性がある。
    // 確定していない人物あてに受取先を決めさせない。
    const result = applyResolution(
      link(),
      resolution(CU_A, { identityMatchStatus: 'unverified_candidate_not_auto_merged' }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('CONFLICT');
    expect(result.value.linkedAt).toBeNull();
    // 理由は残す。運用で中身を確認できるようにするため。
    expect(result.value.lastError).toContain('unverified_candidate_not_auto_merged');
    // ID も残す。確認するときの手がかりになる。
    expect(result.value.commonUserId).toBe(CU_A);
  });

  it('名寄せ候補が残っていたら Claim に使えない', () => {
    const result = applyResolution(
      link(),
      resolution(CU_A, { identityMatchStatus: 'unverified_candidate_not_auto_merged' }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isUsableForClaim(result.value)).toBe(false);
  });

  it('名寄せ候補が残っていたら再試行もしない', () => {
    // 相手の状態が変わらないかぎり同じ結果になる。人の確認を待つ。
    const result = applyResolution(
      link(),
      resolution(CU_A, { identityMatchStatus: 'unverified_candidate_not_auto_merged' }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDueForAttempt(result.value, new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('ok なら余計な記録を残さない', () => {
    const result = applyResolution(link(), resolution(CU_A), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('RESOLVED');
    expect(result.value.lastError).toBeNull();
  });
});

describe('Conflict 時に自動上書きしない（§22.1 の最重要項目）', () => {
  it('既存と異なる値が返ったら CONFLICT にして値を変えない', () => {
    // 上書きすると受取先が黙って別人に変わる。
    const resolved = applyResolution(link(), resolution(CU_A), NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const conflicting = applyResolution(resolved.value, resolution(CU_B), NOW);
    expect(conflicting.ok).toBe(true);
    if (!conflicting.ok) return;

    expect(conflicting.value.status).toBe('CONFLICT');
    // 既存の値がそのまま残っていること。
    expect(conflicting.value.commonUserId).toBe(CU_A);
  });

  it('未検証の属性で一致した結果は受け入れない', () => {
    // identity:email などは、本システムが検証していない値での一致。
    // 受け入れると他人の common_user_id に紐付く経路ができる。
    for (const matchedBy of ['identity:email', 'identity:phone', 'identity:wallet'] as const) {
      const result = applyResolution(link(), resolution(CU_A, { matchedBy }), NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.status, matchedBy).toBe('CONFLICT');
      expect(result.value.commonUserId, matchedBy).toBeNull();
    }
  });

  it('CONFLICT になったら再試行の対象にしない', () => {
    const conflicted = link({ status: 'CONFLICT', commonUserId: CU_A });
    expect(isDueForAttempt(conflicted, NOW)).toBe(false);
  });
});

describe('失敗の扱い（§22.1 timeout / 5xx / 4xx）', () => {
  it('一時的な失敗は PENDING にして時間をおく', () => {
    const failed = applyFailure(link(), 'transient', 'timeout', NOW);
    expect(failed.status).toBe('PENDING');
    expect(failed.nextAttemptAt).not.toBeNull();
    expect(failed.attemptCount).toBe(1);
  });

  it('4xx は再試行せず ERROR にする', () => {
    // 同じ内容で送り直しても結果は変わらない。叩き続けても復旧しない。
    const failed = applyFailure(link(), 'permanent', 'rejected_400', NOW);
    expect(failed.status).toBe('ERROR');
    expect(failed.nextAttemptAt).toBeNull();
  });

  it('再試行の上限を超えたら ERROR にする', () => {
    let current = link();
    for (let index = 0; index < MAX_LINK_ATTEMPTS; index += 1) {
      current = applyFailure(current, 'transient', 'upstream_500', NOW);
    }
    expect(current.attemptCount).toBe(MAX_LINK_ATTEMPTS);
    expect(current.status).toBe('ERROR');
  });

  it('間隔は試行ごとに広がる', () => {
    expect(backoffMinutes(1)).toBeLessThan(backoffMinutes(2));
    expect(backoffMinutes(2)).toBeLessThan(backoffMinutes(3));
  });

  it('次回時刻が来るまで再試行しない', () => {
    const failed = applyFailure(link(), 'transient', 'timeout', NOW);
    expect(isDueForAttempt(failed, NOW)).toBe(false);
    const later = new Date(NOW.getTime() + 24 * 60 * 60_000);
    expect(isDueForAttempt(failed, later)).toBe(true);
  });
});

describe('Claim に使えるか', () => {
  it('RESOLVED のときだけ使える', () => {
    const resolved = link({ status: 'RESOLVED', commonUserId: CU_A });
    expect(isUsableForClaim(resolved)).toBe(true);
  });

  it('PENDING / CONFLICT / ERROR では使えない', () => {
    for (const status of ['UNRESOLVED', 'PENDING', 'CONFLICT', 'ERROR'] as const) {
      expect(isUsableForClaim(link({ status, commonUserId: CU_A })), status).toBe(false);
    }
  });
});

// --- 経路全体 ---------------------------------------------------------------

class FakeLinkRepository implements CommonUserLinkRepository {
  private readonly rows = new Map<string, CommonUserLink>();

  seed(value: CommonUserLink): void {
    this.rows.set(value.accountId, value);
  }

  get(accountId: string): CommonUserLink | undefined {
    return this.rows.get(accountId);
  }

  findByAccountId(accountId: string): Promise<CommonUserLink | null> {
    return Promise.resolve(this.rows.get(accountId) ?? null);
  }

  listDue(now: Date, limit: number): Promise<readonly CommonUserLink[]> {
    const due = [...this.rows.values()].filter((row) => isDueForAttempt(row, now));
    return Promise.resolve(due.slice(0, limit));
  }

  save(value: CommonUserLink, expectedAttemptCount: number): Promise<boolean> {
    const current = this.rows.get(value.accountId);
    if (current === undefined || current.attemptCount !== expectedAttemptCount) {
      return Promise.resolve(false);
    }
    this.rows.set(value.accountId, value);
    return Promise.resolve(true);
  }
}

function fakeDirectory(results: ResolveCommonUserResult[]) {
  const calls: ResolveCommonUserInput[] = [];
  return {
    calls,
    port: {
      resolve(input: ResolveCommonUserInput): Promise<ResolveCommonUserResult> {
        calls.push(input);
        const next = results.shift();
        if (next === undefined) {
          throw new Error('想定より多く呼ばれた');
        }
        return Promise.resolve(next);
      },
    },
  };
}

describe('解決の経路', () => {
  let repo: FakeLinkRepository;

  beforeEach(() => {
    repo = new FakeLinkRepository();
    repo.seed(unresolvedLink('account-1'));
  });

  function deps(directory: LinkDependencies['directory']): LinkDependencies {
    return {
      links: repo,
      directory,
      clock: { now: () => NOW },
      systemKey: 'sennokuni-nft-market',
    };
  }

  it('本システムの account id だけを鍵として送る', async () => {
    // ⚠️ メール・電話・ウォレットを混ぜない。混ぜると他人へ紐付く経路ができる。
    const directory = fakeDirectory([{ ok: true, resolution: resolution(CU_A) }]);
    await advanceCommonUserLink(deps(directory.port), 'account-1');

    expect(directory.calls).toHaveLength(1);
    expect(directory.calls[0]?.externalUserId).toBe('account-1');
    expect(Object.keys(directory.calls[0] ?? {}).sort()).toEqual([
      'createIfMissing',
      'externalUserId',
      'systemKey',
    ]);
  });

  it('外部が落ちていても例外を投げない（購入を止めない）', async () => {
    // §5.3 / §22.1「外部障害時購入可能」。呼び出し元へ失敗を伝播させない。
    const directory = fakeDirectory([{ ok: false, kind: 'transient', reason: 'timeout' }]);
    const outcome = await advanceCommonUserLink(deps(directory.port), 'account-1');

    expect(outcome.kind).toBe('pending');
    expect(repo.get('account-1')?.status).toBe('PENDING');
  });

  it('4xx なら人手に回す', async () => {
    const directory = fakeDirectory([{ ok: false, kind: 'permanent', reason: 'rejected_422' }]);
    const outcome = await advanceCommonUserLink(deps(directory.port), 'account-1');

    expect(outcome.kind).toBe('attention');
    expect(repo.get('account-1')?.status).toBe('ERROR');
  });

  it('解決済みのアカウントは再度問い合わせない', async () => {
    repo.seed(
      link({ accountId: 'account-1', status: 'RESOLVED', commonUserId: CU_A, linkedAt: NOW }),
    );
    const directory = fakeDirectory([]);
    const outcome = await advanceCommonUserLink(deps(directory.port), 'account-1');

    expect(outcome.kind).toBe('skipped');
    expect(directory.calls).toHaveLength(0);
  });

  it('別の試行が先に書き込んでいたら、こちらの結果を捨てる', async () => {
    // 同時に走った古い結果が新しい結果を踏み潰さないこと。
    const directory = {
      resolve: (): Promise<ResolveCommonUserResult> => {
        // 問い合わせのあいだに別経路が書き込んだ状況を作る。
        repo.seed(link({ accountId: 'account-1', status: 'PENDING', attemptCount: 3 }));
        return Promise.resolve({ ok: true, resolution: resolution(CU_A) });
      },
    };
    const outcome = await advanceCommonUserLink(deps(directory), 'account-1');

    expect(outcome.kind).toBe('superseded');
    expect(repo.get('account-1')?.attemptCount).toBe(3);
  });

  it('掃き出しは対象の件数だけ処理する', async () => {
    repo.seed(unresolvedLink('account-2'));
    const directory = fakeDirectory([
      { ok: true, resolution: resolution(CU_A) },
      { ok: true, resolution: resolution(CU_B) },
    ]);

    const outcomes = await sweepCommonUserLinks(deps(directory.port), 10);
    expect(outcomes.filter((item) => item.kind === 'resolved')).toHaveLength(2);
  });

  it('掃き出しは RESOLVED を対象にしない', async () => {
    repo.seed(
      link({ accountId: 'account-1', status: 'RESOLVED', commonUserId: CU_A, linkedAt: NOW }),
    );
    const directory = fakeDirectory([]);
    const outcomes = await sweepCommonUserLinks(deps(directory.port), 10);
    expect(outcomes).toHaveLength(0);
  });
});
