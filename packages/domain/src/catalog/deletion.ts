import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';
import { type Artwork } from './artwork';
import { type Listing } from './listing';

/**
 * 作品を消してよいかを判定する。
 *
 * ⚠️ **「消す」と「公開をやめる」は別の操作。**
 *
 * 公開をやめる（`archived`）のは表示を止めるだけで、行は残る。
 * 消すのは行そのものを無くすので、**取り消せない**。
 * 運営が誤って押したときに取り返しがつかないのは後者だけなので、
 * 消せる条件をここで狭く決める。
 *
 * 消してよいのは、次の 3 つをすべて満たすときだけ:
 *
 *  1. 公開中でない — 公開中の作品を 1 操作で消せると、
 *     「公開ページから作品が消えた」を誰も止められない。
 *     先に公開停止させることで、必ず 2 段階を踏ませる。
 *  2. お支払い待ちが 0 件 — 誰かが買おうとしている最中の作品を
 *     足元から消すことになる。
 *  3. 発行済みが 0 件 — 買った人の手元にある物の出どころを消すことになる。
 *     注文明細は購入時点の題名を控えているが（スナップショット原則）、
 *     作品そのものが消えれば、問い合わせに答えられなくなる。
 *
 * ⚠️ **この判定は最後の砦ではない。** 注文明細・受取権からの外部キーは
 * `Restrict` なので、条件をすり抜けても DB が拒否する。
 * ここで見ているのは「拒否される前に、分かる言葉で止める」ため。
 *
 * 🟡 **この条件は仮決定（`UD-113`）。** 「発行済みがある作品を運営判断で
 * 消せるようにするか」は事業側の決定が要る。決まるまでは狭いほうに倒す。
 */

export interface DeletableCatalogEntry {
  readonly artwork: Artwork;
  /** 一緒に消す出品。作品より先に消さないと外部キーに弾かれる。 */
  readonly deletedListings: readonly Listing[];
}

export function prepareArtworkDeletion(
  artwork: Artwork,
  listings: readonly Listing[],
): Result<DeletableCatalogEntry, DomainError> {
  if (artwork.status === 'published') {
    return err(
      domainError('ARTWORK_NOT_DELETABLE', 'published artwork must be archived before deletion'),
    );
  }
  if (artwork.reservedCount > 0) {
    return err(domainError('ARTWORK_NOT_DELETABLE', 'artwork has reserved supply'));
  }
  if (artwork.issuedCount > 0) {
    return err(domainError('ARTWORK_NOT_DELETABLE', 'artwork has issued supply'));
  }

  for (const listing of listings) {
    // 呼び出し側が他作品の出品を混ぜて渡してきたら、黙って消さない。
    // 巻き込みで別の作品の販売を消すのは、取り返しがつかない事故になる。
    if (listing.artworkId !== artwork.id) {
      return err(
        domainError(
          'ARTWORK_NOT_DELETABLE',
          'listing does not belong to the artwork being deleted',
        ),
      );
    }
  }

  return ok({ artwork, deletedListings: listings });
}
