import type { IntegrationEnvironment } from '@sengoku/domain';

import type { PrismaClient } from '../../generated/client';

/**
 * 手数料率だけを読む口。
 *
 * ⚠️ **暗号鍵を要求しない。** 率は秘密ではなく契約条件なので、復号の
 * 仕組みを通す理由が無い。`PrismaIntegrationRepository` を使い回すと、
 * 率を読むだけの経路が暗号鍵の設定に依存してしまい、鍵を置いていない
 * 配備（E2E・手元）で率が 0 に落ちる。実際にそれで
 * 「作家さまの取り分＝売上全額」が起きかけた。
 *
 * ⚠️ **書けない。** 読むだけの口にしてあるのは、率の書き換えを
 * 管理画面の経路（オーナー限定・監査記録あり）に一本化するため。
 */
export class PrismaPlatformFeeRateReader {
  constructor(private readonly prisma: PrismaClient) {}

  async readPlatformFeeRateBps(environment: IntegrationEnvironment): Promise<number> {
    const row = await this.prisma.integrationSetting.findUnique({
      where: { service_environment: { service: 'payment', environment } },
      select: { platformFeeRateBps: true },
    });
    /*
      ⚠️ **行が無ければ 0。既定値を作らない。** 0 は「無料」ではなく
         「まだ決めていない」。ここで気を利かせると、決めていないまま
         売れてしまう。
    */
    return row?.platformFeeRateBps ?? 0;
  }
}
