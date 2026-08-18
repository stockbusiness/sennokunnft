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
  unavailableTitle: (reason: AdminFailureReason): string =>
    reason === 'unauthorized'
      ? '管理機能を利用する権限がありません'
      : 'ただいま情報を表示できません',
  editViaApi:
    '編集・公開・販売開始の操作は、現在 API から行います。画面からの操作は次の段階で対応します。',

  // --- 作品の管理 ---------------------------------------------------------
  editHeading: '内容を直す',
  submitEdit: 'この内容に直す',
  publishHeading: '公開',
  submitPublish: '公開する',
  submitArchive: '公開をやめる',
  imageHeading: '画像',
  submitImage: '画像を登録する',
  submitImageReplace: '画像を入れ替える',
  imageHint: 'PNG・JPEG・WebP がお使いいただけます。公開するには画像が必要です。',

  deleteHeading: '削除',
  submitDelete: 'この作品を完全に消す',
  /**
   * ⚠️ **取り消せないことを、押す前に必ず書く。**
   * 「公開をやめる」と「消す」は運営から見ると近い操作に見えるが、
   * 戻せるのは前者だけ。取り違えたときの被害が違う。
   */
  deleteWarning: '消した作品は元に戻せません',
  deleteHint:
    '作品と、その販売設定がまとめて消えます。公開中のもの、お支払い待ちや発行済みがあるものは消せません。先に「公開をやめる」を押してください。',
  deleteConfirmLabel: '確認のため、下の欄に「削除」と入力してください',
  deleteConfirmWord: '削除',
  deleteConfirmMismatch: '「削除」と入力されていないため、何もしていません。',
  deleteBlockedByPublish: '公開中の作品は消せません',

  creatorColumn: '登録者',
  /**
   * ⚠️ **氏名やメールアドレスは出せない。** 本システムはメールアドレスを
   * 平文で持たない（`UD-503`）。運営が見分けられるのはアカウントIDだけ。
   */
  creatorUnknown: '（不明）',
} as const;

export type AdminFailureReason = 'unauthorized' | 'not_found' | 'rejected' | 'unavailable';

/**
 * 断られた理由を、その符号ごとの言葉に置き換える。
 *
 * ⚠️ **API の本文をそのまま出さない。** 出す言葉はここで決める。
 * 符号だけを受け取り、対応する日本語を引き当てる。
 * ここに無い符号は、当たり障りのない言い方へ落とす。
 */
const REJECTED_MESSAGES: Readonly<Record<string, string>> = {
  ARTWORK_NOT_DELETABLE:
    'この作品は削除できません。公開中のもの、お支払い待ちや発行済みがあるものは削除できません。',
  ARTWORK_SUPPLY_IMMUTABLE: '公開したあとは、発行する数を変更できません。',
  ARTWORK_NOT_PUBLISHED: 'この作品はまだ公開されていません。先に公開してください。',
  // --- スタッフ（`UD-803`）---
  STAFF_INVITE_DUPLICATE: 'その宛先には、すでに招待をお送りしています。',
  STAFF_INVITE_INVALID: 'この内容では招待できません。宛先とお任せすることをご確認ください。',
  STAFF_INVITE_NOT_OPEN: 'この招待はお使いいただけません。もう一度お送りください。',
  STAFF_INVITE_EXPIRED: 'この招待は期限が過ぎています。もう一度お送りください。',
  STAFF_ALREADY_MEMBER: 'この方はすでにスタッフです。',
  STAFF_NOT_MEMBER: 'この方はスタッフではありません。招待からお迎えください。',
  STAFF_SELF_CHANGE: 'ご自身の権限は変更できません。ほかのオーナーにお願いしてください。',
  STAFF_LAST_OWNER:
    'オーナーが居なくなるため、この変更はできません。先にもうひとりオーナーを立ててください。',
  STAFF_OWNER_MUST_BE_OPERATOR: 'オーナーにできるのは運営の方だけです。',
};

/** 操作が通らなかったときに画面へ出す言葉。理由の中身は写さない。 */
export function adminErrorMessage(reason: AdminFailureReason, code?: string): string {
  switch (reason) {
    case 'unauthorized':
      return '管理機能を利用する権限がありません。ログインし直すか、設定をご確認ください。';
    case 'not_found':
      return 'その対象は見つかりませんでした。すでに消えている可能性があります。';
    case 'rejected': {
      const known = code === undefined ? undefined : REJECTED_MESSAGES[code];
      // ⚠️ 知らない符号のときに、勝手な理由を断定しない。
      return (
        known ?? 'この操作は受け付けられませんでした。内容をご確認のうえ、もう一度お試しください。'
      );
    }
    case 'unavailable':
      return 'ただいま処理できませんでした。しばらくしてからもう一度お試しください。';
  }
}

/** アカウントIDの見分けがつく範囲だけを出す。全部出しても読めない。 */
export function shortAccountId(accountId: string | null): string {
  if (accountId === null || accountId === '') {
    return ADMIN_COPY.creatorUnknown;
  }
  return accountId.slice(0, 8);
}

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
