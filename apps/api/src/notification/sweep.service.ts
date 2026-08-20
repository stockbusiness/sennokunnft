import { Injectable } from '@nestjs/common';
import { formatSerialNumber } from '@sengoku/domain';
import { BuyerNotifier } from './buyer-notifier';

/** 「届いた」「止まっている」を数え上げる口。⚠️ 実装は `@sengoku/database`。 */
export interface NotificationSweepSource {
  listDeliveredWithoutNotice(limit: number): Promise<
    readonly {
      readonly entitlementId: string;
      readonly accountId: string;
      readonly orderNumber: string;
      readonly artworkTitle: string;
      readonly serialNo: number;
    }[]
  >;
  listStalledWithoutNotice(limit: number): Promise<
    readonly {
      readonly entitlementId: string;
      readonly accountId: string;
      readonly orderNumber: string;
      readonly artworkTitle: string;
      readonly serialNo: number;
    }[]
  >;
}

export interface NotificationSweepResult {
  readonly delivered: number;
  readonly stalled: number;
}

/**
 * お届けの結果を知らせる（P0-4）。
 *
 * ⚠️ **配送ワーカーから積まない。** どちらの出来事もワーカーの側で起きるが、
 * そこへ口を生やすと、ワーカーが落ちていた時間ぶんが永久に抜ける。
 * **いまの状態から導ける**ことは、状態から導く。
 *
 * ⚠️ **何度走らせても増えない。** 積む側が種別と対象で一意にしてある。
 */
@Injectable()
export class NotificationSweepService {
  constructor(
    private readonly source: NotificationSweepSource,
    private readonly notifier: BuyerNotifier,
  ) {}

  async sweep(limit: number): Promise<NotificationSweepResult> {
    const delivered = await this.source.listDeliveredWithoutNotice(limit);
    for (const row of delivered) {
      await this.notifier.entitlementDelivered({
        entitlementId: row.entitlementId,
        accountId: row.accountId,
        orderNumber: row.orderNumber,
        artworkTitle: row.artworkTitle,
        // ⚠️ 送るときだけ文字列にする。DB は整数のまま持つ。
        serialNumber: formatSerialNumber(row.serialNo),
      });
    }

    const stalled = await this.source.listStalledWithoutNotice(limit);
    for (const row of stalled) {
      await this.notifier.walletDeliveryStalled({
        entitlementId: row.entitlementId,
        accountId: row.accountId,
        orderNumber: row.orderNumber,
        artworkTitle: row.artworkTitle,
      });
    }

    return { delivered: delivered.length, stalled: stalled.length };
  }
}
