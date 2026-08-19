import type { OrderRepository } from '@sengoku/domain';
import type { JobHandler, RunnerLogger } from './runner';

/**
 * 期限切れの在庫の仮引当を解放するジョブ（決済 Phase P1・指示書 §4.4）。
 *
 * ⚠️ **利用者の操作の外で動かす。** 「誰かが商品ページを開いたときに
 * ついでに掃除する」形にすると、誰も見に来ない作品の枠が永久に戻らない。
 *
 * ⚠️ **1 巡で扱う件数に上限を置く。** 上限が無いと、長く止まっていた
 * あとの初回で全件を 1 トランザクションに抱え込み、その間ほかの注文が
 * 作品行のロックを待って詰まる。
 *
 * ⚠️ **再実行で二重に解放しない。** その保証はリポジトリ側の条件付き更新に
 * あり、ここは呼ぶだけ。ここで「解放したかどうか」を判断しようとすると、
 * 判断と更新のあいだに割り込まれる。
 */
export interface ReservationReleaseJobOptions {
  readonly orders: OrderRepository;
  readonly logger: RunnerLogger;
  readonly now: () => Date;
  readonly batchSize: number;
}

export function createReservationReleaseJob(options: ReservationReleaseJobOptions): JobHandler {
  return {
    name: 'reservation-release',
    async runOnce(): Promise<number> {
      const released = await options.orders.releaseExpiredReservations(
        options.now(),
        options.batchSize,
      );
      if (released.length > 0) {
        // ⚠️ 購入者・作品名・金額はログに出さない。追跡に要るのは件数と注文ID。
        options.logger.info(
          { releasedCount: released.length, orderIds: released.map((entry) => entry.orderId) },
          '期限切れのお取り置きを解放しました',
        );
      }
      return released.length;
    },
  };
}
