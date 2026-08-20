import type {
  IntegrationEnvironment,
  SettlementSettings,
  SettlementSettingsRepository,
  TransferFeeBearer,
} from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * 返金・精算の設定（`UD-104` / `UD-119`）。
 *
 * ⚠️ **暗号鍵を要求しない。** 設定は秘密ではなく取り決めなので、復号の
 * 仕組みを通す理由が無い。通すと、鍵を置いていない配備で設定が読めず、
 * 返金の期限が付かないまま売れてしまう（手数料率で実際に起きかけた形）。
 */
export class PrismaSettlementSettingsRepository implements SettlementSettingsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(environment: IntegrationEnvironment): Promise<SettlementSettings | null> {
    const row = await this.prisma.settlementSettings.findUnique({ where: { environment } });
    /*
      ⚠️ **行が無ければ `null`。既定値を作らない。** ここで 14 日を返すと、
         決めていないまま売れてしまう。初期値はマイグレーションで
         一度だけ入れてある。
    */
    return row === null ? null : toSettings(row);
  }

  async save(
    environment: IntegrationEnvironment,
    settings: SettlementSettings,
  ): Promise<SettlementSettings> {
    const row = await this.prisma.settlementSettings.update({
      where: { environment },
      data: {
        refundWindowDays: settings.refundWindowDays,
        payoutOffsetMonths: settings.payoutOffsetMonths,
        minimumPayoutAmount: settings.minimumPayoutAmount,
        transferFeeBearer: settings.transferFeeBearer,
      },
    });
    return toSettings(row);
  }
}

function toSettings(row: {
  refundWindowDays: number;
  payoutOffsetMonths: number;
  minimumPayoutAmount: number;
  transferFeeBearer: string;
}): SettlementSettings {
  return {
    refundWindowDays: row.refundWindowDays,
    payoutOffsetMonths: row.payoutOffsetMonths,
    minimumPayoutAmount: row.minimumPayoutAmount,
    // ⚠️ DB の CHECK で 2 値に縛ってある。ここで既定へ倒さない。
    transferFeeBearer: row.transferFeeBearer as TransferFeeBearer,
  };
}
