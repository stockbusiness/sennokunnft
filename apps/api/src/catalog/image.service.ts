import { Injectable, NotFoundException } from '@nestjs/common';
import type { UploadImageResponse } from '@sengoku/contracts';
import {
  extensionFor,
  inspectImage,
  type ArtworkRepository,
  type DomainError,
  type Result,
  type StoragePort,
  type AuditLogPort,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/** 保存キーの生成。実装は `@sengoku/integrations`（CSPRNG を使う）。 */
export type StorageKeyFactory = (prefix: string, extension: string) => string;

/**
 * 作品画像の登録。
 *
 * 検証の順序に意味がある:
 *  1. 作品が存在するか
 *  2. **中身を検査する**（拡張子や申告 Content-Type は判定に使わない）
 *  3. ランダムなキーで保存する
 *  4. 作品を更新する
 *  5. 旧画像を消す
 *
 * 5 を最後にしているのは、途中で失敗したときに
 * 「新しい画像が保存できていないのに古い画像が消えた」状態を作らないため。
 * 逆順にすると、失敗時に作品が画像なしで残る。
 */
@Injectable()
export class ArtworkImageService {
  constructor(
    private readonly artworks: ArtworkRepository,
    private readonly storage: StoragePort,
    private readonly generateKey: StorageKeyFactory,
    private readonly audit: AuditLogPort,
  ) {}

  async upload(input: {
    artworkId: string;
    actorAccountId: string;
    bytes: Uint8Array;
    declaredContentType: string | undefined;
  }): Promise<UploadImageResponse> {
    const artwork = await this.artworks.findById(input.artworkId);
    if (artwork === null) {
      throw new NotFoundException();
    }

    // ⚠️ 判定は中身のマジックナンバーで行う。
    //    拡張子・申告 Content-Type は照合にしか使わない。
    const inspection = unwrapDomain(
      inspectImage({ bytes: input.bytes, declaredContentType: input.declaredContentType }),
    );

    // ⚠️ 利用者のファイル名は使わない。CSPRNG によるランダムキー。
    const key = this.generateKey('artworks', extensionFor(inspection.contentType));
    const stored = await this.storage.put({
      key,
      bytes: input.bytes,
      contentType: inspection.contentType,
    });

    const previousKey = artwork.imageKey;
    await this.artworks.update({
      ...artwork,
      imageKey: stored.key,
      imageContentType: stored.contentType,
      imageByteSize: stored.byteSize,
    });

    await this.audit.record({
      actorAccountId: input.actorAccountId,
      action: previousKey === null ? 'artwork.image.attach' : 'artwork.image.replace',
      targetType: 'artwork',
      targetId: artwork.id,
      // ⚠️ 画像そのものやファイル名は残さない。何が起きたかだけを残す。
      summary: {
        previousKey,
        newKey: stored.key,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
      },
    });

    // 置換なら旧オブジェクトを消す。失敗しても業務は成立しているので、
    // ここで例外を投げて全体を失敗させない（孤児は運用で回収する）。
    if (previousKey !== null && previousKey !== stored.key) {
      await this.storage.remove(previousKey).catch(() => undefined);
    }

    return {
      imageKey: stored.key,
      imageUrl: this.storage.publicUrl(stored.key),
      contentType: stored.contentType,
      byteSize: stored.byteSize,
    };
  }
}

function unwrapDomain<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    throw new DomainErrorException(result.error.code);
  }
  return result.value;
}
