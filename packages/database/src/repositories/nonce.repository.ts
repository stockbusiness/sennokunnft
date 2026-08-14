import type { NonceStorePort } from '@sengoku/domain';
import type { PrismaClient } from '../../generated/client';

/**
 * nonce の記録（Prisma 実装）。
 *
 * ⚠️ **`UNIQUE(key_id, nonce)` が判定そのもの。**
 * 「SELECT して無ければ INSERT」だと、同時に届いた 2 本が
 * 両方とも隙間をすり抜けて通る。いきなり INSERT を試み、
 * 弾かれたかどうかで使用済みかを決める。
 */
export class PrismaNonceStore implements NonceStorePort {
  constructor(private readonly prisma: PrismaClient) {}

  async remember(input: {
    keyId: string;
    nonce: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // 期限切れの記録は消しておく。残し続けると表が伸び続ける。
      // 許容時間を過ぎた要求はタイムスタンプ検証で弾かれるので、
      // ここで消してもリプレイの穴にはならない。
      await tx.hmacNonce.deleteMany({
        where: { keyId: input.keyId, nonce: input.nonce, expiresAt: { lte: input.now } },
      });

      // 例外に頼らず件数で判定する。一意制約違反と他のエラーを取り違えないため。
      const created = await tx.hmacNonce.createMany({
        data: [
          {
            keyId: input.keyId,
            nonce: input.nonce,
            createdAt: input.now,
            expiresAt: input.expiresAt,
          },
        ],
        skipDuplicates: true,
      });
      return created.count === 1;
    });
  }
}
