import type { ClockPort } from '../ports/index';
import type { CommonUserDirectoryPort } from '../ports/common-user';
import type { CommonUserLinkRepository } from '../ports/common-user-link';
import { applyFailure, applyResolution, isDueForAttempt, type CommonUserLink } from './common-user';

/**
 * 紐付けを 1 件進める。
 *
 * ⚠️ **この関数は失敗を投げない。**
 * 呼び出し元はログイン直後や購入直後で、
 * ここで例外を出すと**外部の障害がそのまま利用者の操作を止める。**
 * 指示書 §5.3 の「同期外部呼び出しで購入を止めない」がこれにあたる。
 *
 * 返すのは「何が起きたか」だけで、呼び出し元はそれを見ても見なくてもよい。
 */
export type LinkOutcome =
  /** 解決できた。 */
  | { readonly kind: 'resolved'; readonly link: CommonUserLink }
  /** まだ解決していない。時間をおいて再試行する。 */
  | { readonly kind: 'pending'; readonly link: CommonUserLink }
  /** 人手での対応が要る（競合・上限超過・契約違反の応答）。 */
  | { readonly kind: 'attention'; readonly link: CommonUserLink }
  /** いま試す番ではない、または対象外。 */
  | { readonly kind: 'skipped' }
  /** 別の試行が先に書き込んだ。こちらの結果は捨てる。 */
  | { readonly kind: 'superseded' };

export interface LinkDependencies {
  readonly links: CommonUserLinkRepository;
  readonly directory: CommonUserDirectoryPort;
  readonly clock: ClockPort;
  readonly systemKey: string;
}

export async function advanceCommonUserLink(
  deps: LinkDependencies,
  accountId: string,
): Promise<LinkOutcome> {
  const link = await deps.links.findByAccountId(accountId);
  if (link === null) {
    return { kind: 'skipped' };
  }

  const now = deps.clock.now();
  if (!isDueForAttempt(link, now)) {
    return { kind: 'skipped' };
  }

  const expected = link.attemptCount;
  const result = await deps.directory.resolve({
    systemKey: deps.systemKey,
    externalUserId: link.accountId,
    // 解決と同時に相手側へ人物を作らせる。
    // ⚠️ 省略すると相手の既定（true）が効くので、明示する。
    createIfMissing: true,
  });

  if (!result.ok) {
    const failed = applyFailure(link, result.kind, result.reason, now);
    const saved = await deps.links.save(failed, expected);
    if (!saved) {
      return { kind: 'superseded' };
    }
    return failed.status === 'ERROR'
      ? { kind: 'attention', link: failed }
      : { kind: 'pending', link: failed };
  }

  const applied = applyResolution(link, result.resolution, now);
  if (!applied.ok) {
    // 応答が契約と違った。相手の問題なので、時間をおいて再試行する。
    const failed = applyFailure(link, 'transient', applied.error.code, now);
    const saved = await deps.links.save(failed, expected);
    return saved ? { kind: 'pending', link: failed } : { kind: 'superseded' };
  }

  const saved = await deps.links.save(applied.value, expected);
  if (!saved) {
    return { kind: 'superseded' };
  }
  if (applied.value.status === 'CONFLICT') {
    return { kind: 'attention', link: applied.value };
  }
  return { kind: 'resolved', link: applied.value };
}

/**
 * 再試行の掃き出し。
 *
 * cron でも常駐ワーカーでも呼べるように、1 回分の処理だけを行う。
 * どちらの起動方式になるかは `UD-1101` が未決定のため、
 * **どちらでも動く形にしておく。**
 */
export async function sweepCommonUserLinks(
  deps: LinkDependencies,
  limit: number,
): Promise<readonly LinkOutcome[]> {
  const due = await deps.links.listDue(deps.clock.now(), limit);
  const outcomes: LinkOutcome[] = [];
  for (const link of due) {
    // 1 件ずつ順に処理する。相手へ同時に大量の要求を送らないため。
    outcomes.push(await advanceCommonUserLink(deps, link.accountId));
  }
  return outcomes;
}
