import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import { artworkStateMachine, type ArtworkStatus } from '../state/machines';
import { availableSupply, type SupplyCounters } from '../supply/supply';

/**
 * 作品。
 *
 * ここに置くのは「作品として成立しているか」の判断だけで、
 * 永続化も HTTP も知らない。api 層がリポジトリと組み合わせて使う。
 */
export interface Artwork extends SupplyCounters {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly imageKey: string | null;
  /** サーバー側で中身を検査して判定した MIME タイプ。 */
  readonly imageContentType: string | null;
  readonly imageByteSize: number | null;
  /**
   * 画像の内容ハッシュ（`sha256:<hex>`）。保存時に**中身から**計算する。
   * Wallet へ渡す表示情報の同一性確認に使う（PR-NW04 §23）。
   */
  readonly imageHash: string | null;
  readonly status: ArtworkStatus;
}

export const ARTWORK_TITLE_MAX = 120;
export const ARTWORK_DESCRIPTION_MAX = 4000;
/**
 * 1 作品あたりの発行上限の上限値。
 *
 * 上限を置くのは、受取権が 1 枚 1 レコードで作られるため、
 * 発行上限がそのまま書き込み量の上限になるから。
 * 桁を 1 つ間違えた登録で DB を埋め尽くさせない。
 */
export const ARTWORK_MAX_SUPPLY_LIMIT = 1_000_000;

export interface CreateArtworkInput {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly imageKey?: string | null;
  readonly maxSupply: number;
}

function validateTitle(title: string): DomainError | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return domainError('ARTWORK_NOT_AVAILABLE', 'title must not be empty');
  }
  if (trimmed.length > ARTWORK_TITLE_MAX) {
    return domainError('ARTWORK_NOT_AVAILABLE', 'title is too long');
  }
  return null;
}

function validateMaxSupply(maxSupply: number): DomainError | null {
  if (!Number.isSafeInteger(maxSupply) || maxSupply < 1) {
    return domainError('INVALID_QUANTITY', 'maxSupply must be a positive integer');
  }
  if (maxSupply > ARTWORK_MAX_SUPPLY_LIMIT) {
    return domainError('INVALID_QUANTITY', 'maxSupply exceeds the allowed maximum');
  }
  return null;
}

/** 作品を下書きとして作る。公開は別操作。 */
export function createArtworkDraft(input: CreateArtworkInput): Result<Artwork, DomainError> {
  const titleError = validateTitle(input.title);
  if (titleError !== null) {
    return err(titleError);
  }
  const supplyError = validateMaxSupply(input.maxSupply);
  if (supplyError !== null) {
    return err(supplyError);
  }
  if ((input.description ?? '').length > ARTWORK_DESCRIPTION_MAX) {
    return err(domainError('ARTWORK_NOT_AVAILABLE', 'description is too long'));
  }

  return ok({
    id: input.id,
    slug: input.slug,
    title: input.title.trim(),
    description: input.description ?? '',
    imageKey: input.imageKey ?? null,
    imageContentType: null,
    imageByteSize: null,
    imageHash: null,
    maxSupply: input.maxSupply,
    reservedCount: 0,
    issuedCount: 0,
    status: 'draft',
  });
}

export interface UpdateArtworkInput {
  readonly title?: string;
  readonly description?: string;
  readonly maxSupply?: number;
}

/**
 * 作品を更新する。
 *
 * ⚠️ **発行上限は公開後に変更できない。**
 *
 * 増やせば、既に購入した人が前提にしていた希少性が後から変わる。
 * 減らせば、発行済みの枚数を下回りうる。どちらも購入者との約束を
 * 一方的に書き換える行為になる。
 *
 * これは保守的な既定であって、事業判断が済んだものではない（`UD-205`）。
 * 「公開後の増枠を認めるか」が決まったら、ここを緩める。
 */
export function updateArtwork(
  artwork: Artwork,
  input: UpdateArtworkInput,
): Result<Artwork, DomainError> {
  if (input.title !== undefined) {
    const titleError = validateTitle(input.title);
    if (titleError !== null) {
      return err(titleError);
    }
  }
  if (input.description !== undefined && input.description.length > ARTWORK_DESCRIPTION_MAX) {
    return err(domainError('ARTWORK_NOT_AVAILABLE', 'description is too long'));
  }

  if (input.maxSupply !== undefined && input.maxSupply !== artwork.maxSupply) {
    if (artwork.status !== 'draft') {
      return err(
        domainError(
          'ARTWORK_SUPPLY_IMMUTABLE',
          'maxSupply cannot change once the artwork is published',
        ),
      );
    }
    const supplyError = validateMaxSupply(input.maxSupply);
    if (supplyError !== null) {
      return err(supplyError);
    }
    // 下書きであっても、既に引き当てられている数を下回る値は許さない。
    // 下書き段階では通常 0 だが、状態の取り違えがあっても破綻させないため。
    if (input.maxSupply < artwork.reservedCount + artwork.issuedCount) {
      return err(
        domainError('INSUFFICIENT_SUPPLY', 'maxSupply cannot be lower than the allocated count'),
      );
    }
  }

  return ok({
    ...artwork,
    title: input.title === undefined ? artwork.title : input.title.trim(),
    description: input.description ?? artwork.description,
    maxSupply: input.maxSupply ?? artwork.maxSupply,
  });
}

/**
 * 作品を公開する。
 *
 * 公開は「販売の準備が整った」という宣言なので、
 * 表示に必要な最低限が揃っていることを条件にする。
 * 揃っていない作品を公開できてしまうと、購入者に不完全な画面を見せることになる。
 */
export function publishArtwork(artwork: Artwork): Result<Artwork, DomainError> {
  const transition = artworkStateMachine.transition(artwork.status, 'published');
  if (!transition.ok) {
    return transition;
  }
  if (artwork.title.trim().length === 0) {
    return err(domainError('ARTWORK_NOT_AVAILABLE', 'title is required before publishing'));
  }
  if (artwork.imageKey === null) {
    return err(domainError('ARTWORK_NOT_AVAILABLE', 'image is required before publishing'));
  }
  return ok({ ...artwork, status: transition.value });
}

/** 作品を非公開にする。既存の受取権や注文には影響しない。 */
export function archiveArtwork(artwork: Artwork): Result<Artwork, DomainError> {
  const transition = artworkStateMachine.transition(artwork.status, 'archived');
  if (!transition.ok) {
    return transition;
  }
  return ok({ ...artwork, status: transition.value });
}

/** 公開カタログに出してよい作品か。 */
export function isPubliclyVisible(artwork: Artwork): boolean {
  return artwork.status === 'published';
}

/** まだ売れる在庫が残っているか。 */
export function hasRemainingSupply(artwork: Artwork): boolean {
  return availableSupply(artwork) > 0;
}
