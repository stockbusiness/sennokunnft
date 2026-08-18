/**
 * 出品者向けの文言。
 *
 * ⚠️ **Web3 用語を出さない。** 出品する人も、暗号資産の知識を前提にしない。
 * ⚠️ **「値上がり」「利益」「投資」を書かない。** 販売の性質を誤らせる。
 */
export const CREATOR_COPY = {
  listTitle: '出品する',
  listDescription: '登録した作品の一覧です。公開して価格を決めると、店先に並びます。',

  newLink: '作品を新しく登録する',
  noArtworks: 'まだ作品がありません',
  noArtworksHint: '「作品を新しく登録する」から始めてください。',

  newTitle: '作品を登録する',
  newDescription: '作品名と画像を登録します。この時点ではまだ公開されません。',

  fieldTitle: '作品名',
  fieldTitleHint: '一覧と詳細に表示されます（120文字まで）。',
  fieldSlug: 'URL に使う文字',
  fieldSlugHint: '英小文字・数字・ハイフンのみ。あとから変更できません（例: asagiri-no-sato）。',
  fieldDescription: '説明',
  fieldDescriptionHint: '作品にこめた思いなどを書けます（4000文字まで）。',
  fieldMaxSupply: '発行する数',
  fieldMaxSupplyHint: '⚠️ 公開したあとは変更できません。慎重に決めてください。',
  fieldImage: '作品の画像',
  fieldImageHint: 'PNG・JPEG・WebP のいずれか。5MBまで。公開するには画像が必要です。',
  fieldPrice: '価格（税込・円）',
  fieldPriceHint: '1円以上の整数で入力してください。',

  submitNew: 'この内容で登録する',
  submitPublish: '公開する',
  submitArchive: '公開をやめる',
  submitListing: 'この価格で出品する',
  submitActivate: '販売を開始する',
  submitSuspend: '販売を止める',

  backToList: '← 出品一覧へ戻る',

  /**
   * ⚠️ **いまは利用者ごとのログインが無い（`UD-801` 未決定）。**
   * この前提を画面にも書いておく。書かないと、
   * 「自分だけの出品欄」だと思って使われる。
   */
  sharedAccountNotice: 'ただいまログイン機能が未実装のため、この画面はグループ内で共有されています',
  sharedAccountHint:
    '登録した作品は、合言葉を知っている方全員から見え、操作できます。ご自分専用の出品欄になるのは、ログイン機能を作ったあとです。',

  notSellableNotice: 'ご購入の受付はまだ開始できません',
  notSellableHint:
    '代金のお預かりと、出品者の方へのお支払いの仕組みが未整備のためです。いまは並べ方を確かめる段階です。',
} as const;

export function creatorErrorMessage(
  reason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable',
): string {
  switch (reason) {
    case 'unauthorized':
      return '出品する権限がありません。設定をご確認ください。';
    case 'not_found':
      return 'その作品は見つかりませんでした。';
    case 'rejected':
      // ⚠️ どの項目がどう悪かったかを断定しない。サーバー側の判定理由を
      //    画面へ写すと、検証の中身が外に出る。直し方だけを伝える。
      return '入力の内容を受け付けられませんでした。項目の説明をご確認のうえ、もう一度お試しください。';
    case 'unavailable':
      return 'ただいま処理できませんでした。しばらくしてからもう一度お試しください。';
  }
}
