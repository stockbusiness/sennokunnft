import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { AccountLookupPort, TokenVerifierPort } from '@sengoku/auth';
import type {
  ArtworkRepository,
  ClockPort,
  IdGeneratorPort,
  ListingRepository,
} from '@sengoku/domain';
import { AuthGuard } from './auth/auth.guard';
import { AdminCatalogController } from './catalog/admin-catalog.controller';
import { AdminCatalogService } from './catalog/admin-catalog.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { HealthController } from './health/health.controller';
import { HealthService, type DependencyProbe } from './health/health.service';

/**
 * アプリケーションが必要とする外部依存。
 *
 * 具体的な実装クラスではなく**ポート**を受け取る。
 * こうしておくと、テストからは Fake を、本番からは Prisma 実装を差し込める。
 * DI コンテナに実装クラスを直接登録すると、
 * コントローラのテストのたびに実 DB が必要になってしまう。
 */
export interface AppDependencies {
  readonly version: string;
  readonly probes?: readonly DependencyProbe[];
  readonly artworks: ArtworkRepository;
  readonly listings: ListingRepository;
  readonly accounts: AccountLookupPort;
  readonly tokenVerifier: TokenVerifierPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

/**
 * アプリケーションのルートモジュール。
 *
 * 機能ごとにコントローラを分けてあるので、
 * Phase 3 以降で注文・受取を足してもここが肥大化しない。
 */
@Module({})
export class AppModule {
  static register(deps: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, CatalogController, AdminCatalogController],
      providers: [
        {
          provide: HealthService,
          useFactory: () => new HealthService(deps.version, deps.probes ?? []),
        },
        {
          provide: CatalogService,
          useFactory: () => new CatalogService(deps.artworks, deps.listings, deps.clock),
        },
        {
          provide: AdminCatalogService,
          useFactory: () => new AdminCatalogService(deps.artworks, deps.listings, deps.ids),
        },
        {
          // ✅ 認可はガードで一括保護する。ルート個別にチェックを書かない。
          //    グローバル登録なので、新しいエンドポイントを足しても
          //    自動的に保護対象になる（宣言を忘れたら通らない向き）。
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) =>
            new AuthGuard(reflector, deps.tokenVerifier, deps.accounts),
          inject: [Reflector],
        },
      ],
    };
  }
}
