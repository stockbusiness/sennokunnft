import {
  sweepWalletDeliveries,
  type ClockPort,
  type WalletDeliveryOutboxPort,
  type WalletDeliverySenderPort,
} from '@sengoku/domain';
import type { JobHandler, RunnerLogger } from './runner';
import type { ResolveResult, ResolvedWalletDelivery } from './wallet-delivery-config';

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
 *
 * ⚠️ **接続先と鍵は 1 巡ごとに解決する（要決定 03）。**
 * 起動時に 1 個作って使い回すと、管理画面で鍵を交換しても再起動まで
 * 古い鍵で送り続ける。解決に失敗したときは**行を掴む前に止める**。
 * 掴んでから止めると、試行回数だけが減っていき、設定を直す前に
 * `DEAD` へ落ちる。
 */
export interface WalletDeliveryJobOptions {
  readonly outbox: WalletDeliveryOutboxPort;
  readonly clock: ClockPort;
  /** 1 巡ごとに接続先と鍵を解決する。 */
  readonly resolve: () => Promise<ResolveResult>;
  /** 解決した設定から送信アダプタを組み立てる。 */
  readonly createSender: (config: ResolvedWalletDelivery) => WalletDeliverySenderPort;
  readonly logger: RunnerLogger;
  readonly batchSize: number;
}

export function createWalletDeliveryJob(options: WalletDeliveryJobOptions): JobHandler {
  // 設定元が変わったときだけ報せる。毎巡出すと、本当の異変が埋もれる。
  let lastSource: ResolvedWalletDelivery['source'] | null = null;

  return {
    name: 'wallet-delivery',
    async runOnce(): Promise<number> {
      const resolved = await options.resolve();
      if (!resolved.ok) {
        /*
          ⚠️ **黙って 0 件を返さない。** 「送るものが無かった」と
             「送れる設定が無かった」は、見た目が同じで意味がまるで違う。
             前者と区別できないと、設定を壊したことに誰も気づけない。

          ⚠️ **止められているときは `warn`、半端なときは `error`。**
             止めるのは人が意図してやったこと。半端なのは事故。
        */
        if (resolved.reason === 'disabled') {
          options.logger.warn({}, 'Wallet 配送は管理画面から停止されています');
        } else {
          options.logger.error(
            {},
            'Wallet 配送の接続先または鍵が揃っていないため、この巡回では送りません',
          );
        }
        return 0;
      }

      if (resolved.config.source !== lastSource) {
        // ⚠️ 値は出さない。どこから読んだかだけ。
        options.logger.info(
          { source: resolved.config.source },
          'Wallet 配送の設定元が変わりました',
        );
        lastSource = resolved.config.source;
      }

      const outcomes = await sweepWalletDeliveries(
        {
          outbox: options.outbox,
          clock: options.clock,
          sender: options.createSender(resolved.config),
        },
        options.batchSize,
      );

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
