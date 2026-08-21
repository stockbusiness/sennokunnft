import type { LegalDocumentKind } from '../legal/document';

/**
 * 法務文書の改定を、既存の会員へ知らせる（`UD-127`）。
 *
 * ⚠️ **「次のログインで同意していただく」だけでは足りない。** 再同意の印は
 * 次にログインするまで効かない。ログインしない方には、**約束の中身が変わる
 * ことが一度も伝わらないまま**、変わったことになる。
 *
 * ⚠️ **判断はここに集める。** 「誰に送るか」「そもそも送るか」を API の
 * 側へ書くと、掃き寄せ（cron）と公開の直後で判定が分かれ、片方だけ直した
 * ときに静かにずれる。
 */

/**
 * その版について、知らせを積むべきか。
 *
 * ⚠️ **再同意が要らない改定では送らない。** 誤字を直しただけで全員へ
 * 送ると、**次に本当に大事な改定を送ったときに読まれなくなる**。
 * 送らない判断も、送る判断と同じくらい大事である。
 *
 * ⚠️ **公開されていない版では送らない。** 下書きの段階で送ると、
 * 公開をやめたときに「戻します」と言って回ることになる。
 *
 * ⚠️ **積み終えた版では送らない。** 二重送信の最後の砦は積む側の
 * UNIQUE だが、ここで止めておけば無駄な問い合わせが走らない。
 */
/**
 * 1 回の掃き寄せで扱う版の数。
 *
 * ⚠️ **小さくしてよい。** 改定は年に何度も起きない。取りこぼしが
 * 何十件も溜まることは、そもそも異常である。
 */
export const LEGAL_NOTICE_BATCH_SIZE = 20;

export function shouldNotifyRevision(version: {
  readonly publishedAt: Date | null;
  readonly requiresReconsent: boolean;
  readonly noticesEnqueuedAt: Date | null;
}): boolean {
  if (version.publishedAt === null) {
    return false;
  }
  if (!version.requiresReconsent) {
    return false;
  }
  return version.noticesEnqueuedAt === null;
}

/**
 * 知らせを積む相手を選ぶための条件。
 *
 * ⚠️ **「その文書の、古い版に同意した人」だけ。** 一度も同意していない方へ
 * 送っても、再同意のしようが無い。会員でない方へ届く形にもしない。
 *
 * ⚠️ **停止中のアカウントも外さない。** ログインできないので再同意はでき
 * ないが、**改定の知らせは、その方が当事者である約束についての連絡**である。
 * こちらの都合で止めている相手に、黙って中身を変えたことにしない。
 */
export interface RevisionAudience {
  readonly kind: LegalDocumentKind;
  /** この版より前に同意した人が対象。⚠️ 同じ版に同意済みの人は含めない。 */
  readonly beforeVersion: number;
}

export function audienceFor(version: {
  readonly kind: LegalDocumentKind;
  readonly version: number;
}): RevisionAudience {
  return { kind: version.kind, beforeVersion: version.version };
}

/**
 * 差し込む値を組む。
 *
 * ⚠️ **本文を差し込まない。** 規約は長く、メールへ写すと版が 2 か所に
 * 増える。あとで「メールに書いてあった内容」と「公開されている内容」が
 * 食い違ったとき、どちらが約束なのか誰にも言えなくなる。**読みに行く先**
 * を渡す。
 *
 * ⚠️ **施行日を必ず入れる。** 「いつから変わるのか」の無い改定通知は、
 * 読んだ方が何もできない。
 */
export function revisionValues(input: {
  readonly documentName: string;
  readonly effectiveFrom: Date | null;
  readonly legalUrl: string;
  readonly formatDate: (value: Date) => string;
}): Readonly<Record<string, string>> {
  return {
    documentName: input.documentName,
    /*
      ⚠️ **施行日が無い版を「未定」と書かない。** 公開済みなら施行日は
         必ず入っている（ドメインがそう決めている）。ここが空になるのは
         こちらの不具合なので、そうと分かる言葉にする。
    */
    effectiveFrom:
      input.effectiveFrom === null
        ? '（日付を取得できませんでした）'
        : input.formatDate(input.effectiveFrom),
    legalUrl: input.legalUrl,
  };
}
