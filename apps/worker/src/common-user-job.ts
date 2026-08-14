import { sweepCommonUserLinks, type LinkDependencies } from '@sengoku/domain';
import type { JobHandler, RunnerLogger } from './runner';

/**
 * 共通顧客ID の解決を進めるジョブ。
 *
 * ⚠️ **利用者の操作の外で動かす。**
 * 解決は外部システムへの呼び出しを伴うため、購入やログインの経路に置くと
 * 相手の障害がそのまま利用者の失敗になる。ここで非同期に片付ける。
 *
 * ⚠️ **1 巡で処理する件数に上限を置く。**
 * 上限が無いと、相手が復旧した直後に溜まっていた全件を一気に送りつけ、
 * 復旧しかけた相手をもう一度落とす。
 */
export interface CommonUserJobOptions {
  readonly deps: LinkDependencies;
  readonly logger: RunnerLogger;
  readonly batchSize: number;
}

export function createCommonUserLinkJob(options: CommonUserJobOptions): JobHandler {
  return {
    name: 'common-user-link',
    async runOnce(): Promise<number> {
      const outcomes = await sweepCommonUserLinks(options.deps, options.batchSize);

      const counts = { resolved: 0, pending: 0, attention: 0, other: 0 };
      for (const outcome of outcomes) {
        if (outcome.kind === 'resolved') counts.resolved += 1;
        else if (outcome.kind === 'pending') counts.pending += 1;
        else if (outcome.kind === 'attention') counts.attention += 1;
        else counts.other += 1;
      }

      if (outcomes.length > 0) {
        // ⚠️ common_user_id そのものはログに出さない。件数だけを残す。
        options.logger.info(counts, '共通顧客IDの解決を進めました');
      }
      if (counts.attention > 0) {
        // 競合・上限超過は自動で解けない。気付ける形にして人へ渡す。
        options.logger.error(
          { attention: counts.attention },
          '人手での確認が必要な紐付けがあります',
        );
      }

      return outcomes.length;
    },
  };
}
