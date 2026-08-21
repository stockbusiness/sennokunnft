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

  /* --- 売上（P1-2）--- */
  earningsTitle: '売上とお振込',
  /*
    ⚠️ **「見込み」と「確定」を言葉で分ける。** 同じ顔で出すと、
       締めたあとに数字が動いたときに「話が違う」になる。
  */
  earningsDescription:
    '今月ぶんの見込みと、締めたあとのお支払いの記録です。今月ぶんは、月が終わるまで動きます。',
  earningsCurrentTitle: '今月ぶん（見込み）',
  earningsCurrentHint:
    'まだ締めていないため、これから増えることも、ご返金があって減ることもあります。',
  earningsNextTitle: '次回のお振込',
  earningsNoNextPayout: '次回のお振込のご予定はありません',
  /*
    ⚠️ **「0円をお振込します」と読ませない。** 最低支払額に満たない分は
       消えるのではなく、次の月へ繰り越される。そこまで言い切る。
  */
  earningsNoNextPayoutHint:
    '売上が最低支払額に満たないときは、その分を次の月へ繰り越します。なくなるわけではありません。',
  earningsByArtworkTitle: '作品ごとの売れ行き',
  earningsNoSales: 'まだ売上がありません',
  earningsNoSalesHint: '作品が売れると、こちらに出ます。',
  earningsHistoryTitle: 'これまでのお支払い',
  earningsNoHistory: 'まだ締めた月がありません',
  earningsNoHistoryHint: '月が締まると、こちらに記録が残ります。',
  earningsDetailTitle: '明細',
  earningsCsvLink: '明細を CSV で受け取る',
  /*
    ⚠️ **買った方の情報が入らないことを、こちらから言う。** 聞かれる前に
       書いておくほうが、余計なご心配をかけずに済む。
  */
  earningsCsvHint: 'Excel などで開けます。お買い上げくださった方のお名前やご連絡先は含まれません。',
  earningsOpenRefundNotice: 'ご返金をお受けできる期間が残っています',
  earningsOpenRefundHint:
    'この期間が終わるまで、金額が確定しません。ご返金があった分は差し引かれます。',
  earningsClawbackNote: '※ ご返金があった分は、売れた数から引かずに別に出しています。',

  /* --- お店の情報（P1-2）--- */
  shopTitle: 'お店の情報',
  shopDescription: '作品ページに出るお店の情報です。あとから変更できます。',
  fieldShopName: 'お店の名前',
  fieldShopNameHint: '60文字まで。お名前と別に、屋号を出したいときにお使いください。',
  fieldBio: 'ご紹介',
  fieldBioHint: '2000文字まで。作品づくりのことなどを書けます。',
  fieldLinks: 'SNS・ウェブサイト',
  fieldLinksHint:
    '5件まで。`https://` で始まるものだけお使いいただけます（`http://` は登録できません）。',
  fieldInvoiceNumber: 'インボイス登録番号',
  /*
    ⚠️ **「無いと売れない」と読ませない。** 免税事業者の方もいらっしゃる。
       任意であることを先に書く。
  */
  fieldInvoiceNumberHint:
    '任意です。登録されている方のみ、T から始まる13桁の数字でご入力ください（例: T1234567890123）。登録がなくても販売できます。',
  submitShop: 'この内容で保存する',
  shopSaved: '保存しました',

  setupTitle: 'ご準備の状況',
  setupDone: '済',
  setupTodo: 'これから',
  setupOptional: '任意',
  salesTermsTitle: '販売規約',
  salesTermsPending: 'まだご同意いただいていません',
  salesTermsPendingHint: 'お作りしているところです。用意ができ次第、こちらでご案内します。',
  /*
    ⚠️ **「準備中」と正直に出す**（P1-3）。「未登録」とだけ出すと、
       登録する場所を探させてしまう。まだ無いことをこちらから言う。
  */
  payoutAccountTitle: 'お振込先',
  payoutAccountPending: 'まだご登録いただけません（準備中）',
  payoutAccountPendingHint:
    'お振込先をご登録いただく仕組みを、いま用意しています。整い次第こちらでご案内しますので、いまは何もなさらなくて大丈夫です。',

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
    case 'CREATOR_PROFILE_INVALID':
      /*
        ⚠️ **どの項目がどう悪かったかを断定しない。** 検証の中身を写すと、
           判定の詳細が外へ出る。直しに行ける場所だけを伝える。
      */
      return 'お店の情報を受け付けられませんでした。文字数、`https://` で始まるお住所か、インボイス登録番号の形（Tと13桁の数字）をご確認ください。';
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

/**
 * 締めの状態を、作家さまに伝わる言葉にする。
 *
 * ⚠️ **`estimate` を「確定」と読ませない。** 締めるまでは動く。
 * ⚠️ **`paid` は「お振込みしました」。** こちらの記録であって、着金の
 * 確認ではない（実際に届いたかを機械は確かめられない）。
 */
export function earningsStateLabel(state: 'estimate' | 'draft' | 'confirmed' | 'paid'): string {
  switch (state) {
    case 'estimate':
      return '見込み';
    case 'draft':
      return '集計中';
    case 'confirmed':
      return 'お支払い予定';
    case 'paid':
      return 'お振込み済み';
  }
}

/**
 * 締めの状態の色。
 *
 * ⚠️ **色だけで伝えない。** 必ず言葉（`earningsStateLabel`）と一緒に出す。
 * ⚠️ **見込みを `success` にしない。** まだ決まっていないものを、
 * 決まったものと同じ顔にしない。
 */
export function earningsStateTone(
  state: 'estimate' | 'draft' | 'confirmed' | 'paid',
): 'neutral' | 'success' {
  return state === 'paid' ? 'success' : 'neutral';
}

/**
 * `2026-08` を `2026年8月` にする。
 *
 * ⚠️ **読めない値はそのまま返す。** 勝手に置き換えると、
 * 「どの月の話か分からない」より悪い「別の月に見える」を作る。
 */
export function formatPeriodKey(periodKey: string): string {
  const matched = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (matched === null) {
    return periodKey;
  }
  const year = matched[1] ?? '';
  const month = Number.parseInt(matched[2] ?? '', 10);
  return Number.isNaN(month) ? periodKey : `${year}年${String(month)}月`;
}
