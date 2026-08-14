import { sweepWalletDeliveries, type WalletDeliveryDependencies } from '@sengoku/domain';
import type { JobHandler, RunnerLogger } from './runner';

/**
 * OVEW Wallet への配送を進めるジョブ。
 *
 * ⚠️ **利用者の操作の外で動かす。**
 * 配送は外部システムへの呼び出しを伴う。受取の経路に置くと、
 * 相手の障害がそのまま利用者の受取失敗になる。
 *
 * ⚠️ **1 巡で送る件数に上限を置く。**
 * 上限が無いと、相手が復旧した直後に溜まっていた全件を一気に送りつけ、
 * 復旧しかけた相手をもう一度落とす。
 */
export interface WalletDeliveryJobOptions {
  readonly deps: WalletDeliveryDependencies;
  readonly logger: RunnerLogger;
  readonly batchSize: number;
}

export function createWalletDeliveryJob(options: WalletDeliveryJobOptions): JobHandler {
  return {
    name: 'wallet-delivery',
    async runOnce(): Promise<number> {
      const outcomes = await sweepWalletDeliveries(options.deps, options.batchSize);

      const counts = { delivered: 0, retrying: 0, failed: 0, dead: 0 };
      for (const outcome of outcomes) {
        if (outcome.decision.next === 'DELIVERED') counts.delivered += 1;
        else if (outcome.decision.next === 'PENDING') counts.retrying += 1;
        else if (outcome.decision.next === 'FAILED') counts.failed += 1;
        else counts.dead += 1;
      }

      if (outcomes.length > 0) {
        // ⚠️ 本文・common_user_id・イベントIDはログに出さない。件数だけを残す。
        options.logger.info(counts, 'Wallet への配送を進めました');
      }
      if (counts.failed > 0 || counts.dead > 0) {
        // 自動では解けない。気付ける形にして人へ渡す。
        // `FAILED`（送る内容が悪い）と `DEAD`（相手が復旧しない）は
        // 運用でやることが違うので、分けたまま報せる。
        options.logger.error(
          { failed: counts.failed, dead: counts.dead },
          '人手での確認が必要な配送があります',
        );
      }

      return outcomes.length;
    },
  };
}
