import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { LivenessResponse } from '@sengoku/contracts';
import { HealthService } from './health.service';

/**
 * ヘルスチェックのエンドポイント。
 *
 * liveness と readiness を分けている理由は HealthService の注釈を参照。
 * ここでは HTTP ステータスへの対応付けだけを行う。
 */
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('healthz')
  @HttpCode(200)
  liveness(): LivenessResponse {
    return this.health.liveness();
  }

  @Get('readyz')
  async readiness(@Res() response: Response): Promise<void> {
    const result = await this.health.readiness();
    // 依存が落ちているときに 200 を返すと、ロードバランサが
    // 処理できないインスタンスへトラフィックを流し続けてしまう。
    response.status(result.status === 'ok' ? 200 : 503).json(result);
  }
}
