import type { AdminArtwork, AdminListing } from '@sengoku/contracts';

/**
 * 管理画面の文言。
 *
 * 運営向けの画面なので、購入者向けほど用語を言い換えない。
 * ただし「Mint」「Wallet」といった Web3 用語は運営にも不要なので使わない。
 */
export const ADMIN_COPY = {
  artworksTitle: '作品の管理',
  artworksDescription: '登録した作品の一覧です。公開すると販売できるようになります。',
  listingsTitle: '販売の管理',
  listingsDescription: '作品ごとの販売設定です。公開済みの作品だけ販売を開始できます。',
  newArtwork: '作品を新しく登録する',
  newListing: '販売を新しく作る',
  noArtworks: 'まだ作品がありません',
  noArtworksHint: '「作品を新しく登録する」から追加してください。',
  noListings: 'まだ販売設定がありません',
  noListingsHint: '作品を公開してから販売を作成してください。',
  unavailableHint: 'しばらくしてからもう一度お試しください。',
  unavailableTitle: (reason: 'unauthorized' | 'unavailable' | 'not_found'): string =>
    reason === 'unauthorized'
      ? '管理機能を利用する権限がありません'
      : 'ただいま情報を表示できません',
  editViaApi:
    '編集・公開・販売開始の操作は、現在 API から行います。画面からの操作は次の段階で対応します。',
} as const;

export function artworkStatusLabel(status: AdminArtwork['status']): string {
  switch (status) {
    case 'draft':
      return '下書き';
    case 'published':
      return '公開中';
    case 'archived':
      return '非公開';
  }
}

export function listingStatusLabel(status: AdminListing['status']): string {
  switch (status) {
    case 'draft':
      return '下書き';
    case 'scheduled':
      return '販売予定';
    case 'active':
      return '販売中';
    case 'suspended':
      return '一時停止';
    case 'ended':
      return '販売終了';
  }
}

/** 利用者から見た表示状態。運営画面でも同じ判定結果を出す。 */
export function displayStateLabel(state: AdminListing['displayState']): string {
  switch (state) {
    case 'on_sale':
      return 'お求めいただけます';
    case 'scheduled':
      return '販売開始前';
    case 'ended':
      return '販売終了';
    case 'sold_out':
      return '完売';
    case 'not_available':
      return '購入できません';
  }
}
