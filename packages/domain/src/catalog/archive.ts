import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';
import { archiveArtwork, type Artwork } from './artwork';
import { endListing, type Listing } from './listing';

/**
 * 作品を非公開にするとき、その作品の有効な出品も一緒に終了する。
 *
 * ⚠️ **「非公開なのに販売中の出品がある」状態を作らない。**
 *
 * 出品側にはトリガがあり、非公開の作品に対して有効な出品を**作る**ことはできない。
 * しかし作品側には何も無かったため、`published → archived` にするだけで
 * 「有効な出品が非公開の作品を指している」状態が成立してしまっていた。
 * トリガが防ごうとしていた状態そのものを、別の入口から作れていたことになる。
 *
 * 「運用で出品も終了する」では守れない。手順は忘れられるし、
 * 途中で落ちれば片方だけが適用される。
 * そのため、
 *
 *   1. ここ（ドメイン）で両方の遷移をまとめて決める
 *   2. リポジトリが**同一トランザクション**で書き込む
 *   3. DB のトリガが、それ以外の経路をすべて拒否する
 *
 * の 3 段で守る。1 と 2 は正しい手順を楽にするためのもので、
 * 保証しているのは 3 だけである。
 */

export interface ArchivedCatalogEntry {
  readonly artwork: Artwork;
  /** 終了させる出品。すでに終了・下書きのものは含まない。 */
  readonly endedListings: readonly Listing[];
}

/** 出品を「有効」とみなす状態。DB の部分ユニーク索引と同じ定義。 */
function isEffective(listing: Listing): boolean {
  return listing.status === 'active' || listing.status === 'scheduled';
}

export function archiveArtworkAndEndListings(
  artwork: Artwork,
  listings: readonly Listing[],
): Result<ArchivedCatalogEntry, DomainError> {
  const archived = archiveArtwork(artwork);
  if (!archived.ok) {
    return archived;
  }

  const endedListings: Listing[] = [];
  for (const listing of listings) {
    if (!isEffective(listing)) {
      continue;
    }
    // 呼び出し側が他作品の出品を混ぜて渡してきたら、黙って終了させない。
    // 巻き込みで別の作品の販売を止めるのは、取り返しがつきにくい事故になる。
    if (listing.artworkId !== artwork.id) {
      return err(
        domainError(
          'ARTWORK_NOT_AVAILABLE',
          'listing does not belong to the artwork being archived',
        ),
      );
    }
    const ended = endListing(listing);
    if (!ended.ok) {
      return ended;
    }
    endedListings.push(ended.value);
  }

  return ok({ artwork: archived.value, endedListings });
}
