import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthService, type DependencyProbe } from './health/health.service';

export interface AppModuleOptions {
  readonly version: string;
  /** readiness が確認する依存。テストでは空にできる。 */
  readonly probes?: readonly DependencyProbe[];
}

/**
 * アプリケーションのルートモジュール。
 *
 * Phase 1 ではヘルスチェックのみを公開する。
 * カタログ・注文・受取の各機能は、Phase 2 以降で
 * それぞれ独立したモジュールとして追加する
 * （機能ごとにモジュールを分けることで、後から足しても
 *  ルートモジュールが肥大化しない構造にしてある）。
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useFactory: () => new HealthService(options.version, options.probes ?? []),
        },
      ],
    };
  }
}
