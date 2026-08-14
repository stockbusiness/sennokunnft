import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import express from 'express';
import type { AccountLookupPort, TokenVerifierPort } from '@sengoku/auth';
import type {
  ArtworkRepository,
  ClaimRepositoryPort,
  ClaimTokenPort,
  RateLimiterPort,
  IdempotencyStore,
  AuditLogPort,
  ClockPort,
  IdGeneratorPort,
  ListingRepository,
  StoragePort,
} from '@sengoku/domain';
import type { SenNoKuniHmacVerifier } from '@sengoku/integrations';
import type { Logger } from '@sengoku/observability';
import { AuthGuard } from './auth/auth.guard';
import { ClaimController } from './claim/claim.controller';
import { ClaimService } from './claim/claim.service';
import { CLAIM_HMAC_CONFIG, SenNoKuniHmacGuard, type ClaimHmacConfig } from './claim/hmac.guard';
import {
  CLAIM_RATE_LIMIT_CONFIG,
  ClaimRateLimitGuard,
  type ClaimRateLimitConfig,
} from './claim/rate-limit.guard';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { IdempotencyService } from './common/idempotency';
import { AdminCatalogController } from './catalog/admin-catalog.controller';
import { AdminCatalogService } from './catalog/admin-catalog.service';
import { CatalogController, PublicListingController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { ArtworkImageService, type StorageKeyFactory } from './catalog/image.service';
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
  readonly idempotency: IdempotencyStore;
  readonly tokenVerifier: TokenVerifierPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly storage: StoragePort;
  readonly audit: AuditLogPort;
  readonly generateStorageKey: StorageKeyFactory;
  /**
   * Claim（OVEW Wallet 連携）。
   *
   * ⚠️ **既定は無効。** 有効化するのは、相手側の署名器が v1.1 FINAL へ揃い、
   * 固定ベクトルが両システムで一致してから。
   */
  readonly claim?: {
    readonly enabled: boolean;
    readonly claims: ClaimRepositoryPort;
    readonly tokens: ClaimTokenPort;
    readonly verifier: SenNoKuniHmacVerifier | null;
    readonly logger: Logger;
    readonly rateLimiter: RateLimiterPort;
    /** 1 分あたりの上限（鍵IDごと）。用途で枠を分ける。 */
    readonly getPerMinute: number;
    readonly postPerMinute: number;
  };
}

/**
 * アプリケーションのルートモジュール。
 *
 * 機能ごとにコントローラを分けてあるので、
 * Phase 3 以降で注文・受取を足してもここが肥大化しない。
 */
/**
 * 画像アップロードで受け付ける本文の上限。
 *
 * ドメイン側の上限（5MB）より少し大きくしてある。
 * ここで先に切ると Express 既定の 413（HTML）が返り、
 * 統一したエラー契約から外れてしまうため、
 * **判定はドメイン側に任せて、こちらは暴走を止めるだけ**にする。
 */
const RAW_BODY_LIMIT = '8mb';

@Module({})
export class AppModule implements NestModule {
  /**
   * 画像は生のバイト列で受け取る。
   *
   * JSON パーサに通さないのは、画像をテキストとして解釈させないため。
   * 対象を画像の MIME に限定しているので、他のエンドポイントには影響しない。
   */
  configure(consumer: MiddlewareConsumer): void {
    // ⚠️ **すべての経路へ最初に適用する。**
    //    ここより後に置いたミドルウェアのログにも相関IDが乗る。
    consumer.apply(CorrelationMiddleware).forRoutes('*');
    consumer
      .apply(express.raw({ type: ['image/*', 'application/octet-stream'], limit: RAW_BODY_LIMIT }))
      .forRoutes('api/v1/admin/artworks/:id/image');
  }

  static register(deps: AppDependencies): DynamicModule {
    // ⚠️ **依存が無いときは、経路ごと生やさない。**
    //    「登録はするが呼ばれたら落ちる」形にすると、Nest は起動時に
    //    すべての provider を作るため、Claim を使わない構成まで道連れに落ちる。
    //    実際にそれで既存の API テストが全滅した。
    const claim = deps.claim;
    return {
      module: AppModule,
      controllers: [
        HealthController,
        CatalogController,
        PublicListingController,
        AdminCatalogController,
        ...(claim === undefined ? [] : [ClaimController]),
      ],
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
          useFactory: () =>
            new AdminCatalogService(
              deps.artworks,
              deps.listings,
              deps.ids,
              deps.clock,
              deps.storage,
              deps.audit,
            ),
        },
        {
          provide: ArtworkImageService,
          useFactory: () =>
            new ArtworkImageService(
              deps.artworks,
              deps.storage,
              deps.generateStorageKey,
              deps.audit,
            ),
        },
        {
          provide: IdempotencyService,
          useFactory: () => new IdempotencyService(deps.idempotency, deps.clock),
        },
        ...(claim === undefined
          ? []
          : [
              {
                provide: ClaimService,
                useFactory: (idempotency: IdempotencyService) =>
                  new ClaimService(claim.claims, claim.tokens, deps.clock, idempotency),
                inject: [IdempotencyService],
              },
              SenNoKuniHmacGuard,
              ClaimRateLimitGuard,
              {
                provide: CLAIM_RATE_LIMIT_CONFIG,
                useFactory: (): ClaimRateLimitConfig => ({
                  limiter: claim.rateLimiter,
                  clock: deps.clock,
                  getPerMinute: claim.getPerMinute,
                  postPerMinute: claim.postPerMinute,
                }),
              },
              {
                provide: CLAIM_HMAC_CONFIG,
                useFactory: (): ClaimHmacConfig => ({
                  verifier: claim.verifier,
                  clock: deps.clock,
                  logger: claim.logger,
                  // 既定は無効。有効化は相手側の署名器が揃ってから。
                  enabled: claim.enabled,
                }),
              },
            ]),
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
