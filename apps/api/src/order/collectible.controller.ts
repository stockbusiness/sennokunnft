import { Controller, ForbiddenException, Get, Inject, Query } from '@nestjs/common';
import { collectibleListQuerySchema, type CollectibleListResponse } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { toPublicClaimStatus, type CollectibleRepository, type StoragePort } from '@sengoku/domain';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';

/** 注入の合図。⚠️ interface は実行時に消えるので、型では注入できない。 */
export const COLLECTIBLE_CONFIG = Symbol('sengoku:collectible-config');

export interface CollectibleConfig {
  readonly repository: CollectibleRepository;
  readonly storage: StoragePort;
}

/**
 * ご自分が受け取ったもの（P0-3）。
 *
 * ⚠️ **誰の分かをトークンからだけ取る。** 問い合わせ文字列で渡せる形に
 * すると、そこが他人の持ち物を覗く道になる。
 *
 * ⚠️ **内部の状態をそのまま返さない。** `issued` / `claimed` は運営の言葉で、
 * 買った方には「いま何が起きているか」が伝わらない。公開状態
 * （`toPublicClaimStatus`）へ写してから返す。
 */
@Controller('api/v1/collectibles')
export class CollectibleController {
  constructor(@Inject(COLLECTIBLE_CONFIG) private readonly config: CollectibleConfig) {}

  @Get()
  @RequireAction('order.view')
  async list(
    @CurrentActor() actor: Actor,
    @Query() rawQuery: unknown,
  ): Promise<CollectibleListResponse> {
    const query = parseOrThrow(collectibleListQuerySchema, rawQuery);
    const accountId = requireAccountId(actor);

    const page = await this.config.repository.listForAccount({
      accountId,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });

    return {
      items: page.items.map((row) => ({
        entitlementId: row.entitlementId,
        artworkId: row.artworkId,
        artworkSlug: row.artworkSlug,
        artworkTitle: row.artworkTitle,
        creatorName: row.creatorName,
        /*
          ⚠️ **URL はサーバーが解決する。** キーを返して画面側で組み立てると、
             公開ドメインの設定が 2 か所になる。
        */
        imageUrl: row.imageKey === null ? null : this.config.storage.publicUrl(row.imageKey),
        serialNo: row.serialNo,
        acquiredAt: row.acquiredAt.toISOString(),
        status: toPublicClaimStatus(row.status, row.deliveryStatus),
        orderNumber: row.orderNumber,
        orderId: row.orderId,
      })),
      nextCursor: page.nextCursor,
    };
  }
}

function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    // ガードが通しているので通常は来ない。来たら開かない側へ倒す。
    throw new ForbiddenException();
  }
  return actor.accountId;
}
