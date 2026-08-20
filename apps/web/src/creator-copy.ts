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
   * ⚠️ **ログイン機能を有効にしていない環境でだけ出す。**
   * 出しっぱなしにすると、ログインしている人にまで
   * 「共有されている」と誤って伝わる。
   */
  sharedAccountNotice: 'ただいまログイン機能が無効のため、この画面はグループ内で共有されています',
  sharedAccountHint:
    '登録した作品は、合言葉を知っている方全員から見え、操作できます。ご自分専用の出品欄になるのは、ログイン機能を有効にしたあとです。',

  /* --- お名前（決定 2026-08-20）--- */
  profileTitle: 'お名前',
  /*
    ⚠️ **本名を求めない。** 屋号・ペンネームで足りる。ここで本名を求めると、
       出さなくてよい情報を出させることになる。本人確認が要るのは
       お支払いの段（`UD-124`）で、そこは別の仕組みになる。
  */
  profileDescription:
    '作品ページに出るお名前です。屋号やペンネームでもかまいません（本名でなくても大丈夫です）。',
  fieldDisplayName: '作品ページに出すお名前',
  fieldDisplayNameHint:
    '40文字まで。ほかの方と同じお名前は登録できません。全角・半角や大文字・小文字の違いだけでは別のお名前とみなしません。',
  submitDisplayName: 'このお名前で登録する',
  displayNameSaved: 'お名前を登録しました',
  displayNameUnset: 'まだ登録されていません',
  /*
    ⚠️ **登録済みの表示を「変えられません」と読ませない。** あとから変えられる。
       ただし、売れた分の記録は買われた時点のお名前のまま残る。
  */
  displayNameChangeHint:
    'あとから変更できます。すでにお買い上げいただいた分の記録には、そのときのお名前が残ります。',
  displayNameMissingNotice: 'お名前がまだ登録されていません',
  displayNameMissingHint:
    '作品ページには「お名前未登録」と出ます。お名前を登録すると、作品と一緒に表示されます。',

  notSellableNotice: 'ご購入の受付はまだ開始できません',
  notSellableHint:
    '代金のお預かりと、出品者の方へのお支払いの仕組みが未整備のためです。いまは並べ方を確かめる段階です。',
} as const;

/**
 * 失敗の理由を、直し方の分かる言葉にする。
 *
 * ⚠️ **符号を先に見る。** 状態コードだけだと「入力を受け付けられません」に
 * まとまってしまい、**別の名前を考えれば済む**のか、**運営に相談すべき**なのかが
 * 伝わらない。伝わらないと、同じ名前を何度も試すことになる。
 *
 * ⚠️ **API の `message` は写さない。** 言葉はここで決める。
 */
export function creatorErrorMessage(
  reason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable',
  code?: string,
): string {
  switch (code) {
    case 'DISPLAY_NAME_TAKEN':
      return 'そのお名前は、すでに他の方がお使いです。別のお名前をご検討ください。';
    case 'DISPLAY_NAME_RESERVED':
      return '運営とまぎらわしいお名前はお使いいただけません。「運営」「公式」「事務局」などを含まないお名前をご検討ください。';
    case 'DISPLAY_NAME_INVALID':
      return 'お名前は1〜40文字でご入力ください。目に見えない文字は使えません。';
    default:
      break;
  }

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
