import type { LegalDocumentKind, LegalDocumentVersion, TokushohoFields } from '../legal/document';
import type { ConsentRequiredKind, LegalConsentRecord } from '../legal/consent';

/**
 * 法務文書の保管庫。
 *
 * ⚠️ **削除の口を置かない。** 置くと、いつか「古いから」と消される。
 * 消えて困るのは消したあとで、そのときにはもう戻せない。
 *
 * ⚠️ **更新の口は下書きにしか効かない。** 公開済みの版を書き換える口を
 * 作らない。実装側でも `WHERE status = 'draft'` を条件に入れ、
 * 呼び出し側の判定だけに頼らない。
 */

export interface CreateLegalDraftCommand {
  readonly kind: LegalDocumentKind;
  readonly title: string;
  readonly bodyText: string | null;
  readonly tokushoho: TokushohoFields | null;
  readonly createdByAccountId: string;
}

export interface SaveLegalDraftCommand {
  readonly id: string;
  readonly title: string;
  readonly bodyText: string | null;
  readonly tokushoho: TokushohoFields | null;
}

export interface PublishLegalVersionCommand {
  readonly id: string;
  readonly effectiveFrom: Date;
  readonly publishedByAccountId: string;
  readonly publishedAt: Date;
  /** この版から再同意を求めるか（`UD-126`）。 */
  readonly requiresReconsent: boolean;
}

export interface LegalDocumentRepository {
  /**
   * その種類の版を、新しい順に返す。
   *
   * ⚠️ **下書きも含めて返す。** 管理画面が使う。公開ページは
   * `effectiveVersion` を通すので、下書きが混ざっても表に出ない。
   */
  listVersions(kind: LegalDocumentKind): Promise<readonly LegalDocumentVersion[]>;

  findById(id: string): Promise<LegalDocumentVersion | null>;

  /**
   * その種類の下書き。無ければ `null`。
   *
   * ⚠️ **種類ごとに 1 つだけ。** 2 つ以上あると、どちらを直しているのか
   * 分からなくなる。DB 側にも部分一意索引を置いて、こちらの判定だけに
   * 頼らない。
   */
  findDraft(kind: LegalDocumentKind): Promise<LegalDocumentVersion | null>;

  /**
   * いま施行されている版。無ければ `null`。
   *
   * ⚠️ **`now` を引数で受け取る。** 実装が自分で現在時刻を作ると、
   * 試験で施行日をまたげない。
   */
  findEffective(kind: LegalDocumentKind, now: Date): Promise<LegalDocumentVersion | null>;

  create(command: CreateLegalDraftCommand): Promise<LegalDocumentVersion>;

  /** 下書きだけを書き換える。公開済みなら `null`。 */
  saveDraft(command: SaveLegalDraftCommand): Promise<LegalDocumentVersion | null>;

  /** 下書きだけを公開する。すでに公開済みなら `null`。 */
  publish(command: PublishLegalVersionCommand): Promise<LegalDocumentVersion | null>;

  /* --- 改定の知らせ（`UD-127`）--- */

  /**
   * 知らせをまだ積んでいない、公開済みで再同意が要る版。
   *
   * ⚠️ **掃き寄せ（cron）が使う。** 公開の直後に積むのが本筋だが、
   * そこで落ちると誰にも届かない。**公開は取り消せない**ので、
   * 拾い直す口が要る。
   */
  listVersionsAwaitingNotices(limit: number): Promise<readonly LegalDocumentVersion[]>;

  /**
   * その文書の、**その版より前に同意した人**のアカウントID。
   *
   * ⚠️ **一度も同意していない方は含まない。** 再同意のしようが無い。
   * ⚠️ **同じ版に同意済みの方も含まない。** 「もう同意しています」という
   * 知らせになる。
   * ⚠️ **停止中のアカウントは外さない。** ログインできないので再同意は
   * できないが、これは**その方が当事者である約束についての連絡**である。
   * こちらの都合で止めている相手に、黙って中身を変えたことにしない。
   */
  listAccountsConsentedBefore(input: {
    readonly kind: LegalDocumentKind;
    readonly beforeVersion: number;
  }): Promise<readonly string[]>;

  /**
   * 積み終えた印を立てる。
   *
   * ⚠️ **途中で落ちたら立てない。** 立たなければ掃き寄せが拾い直す。
   * 積み直しは安全である——同じ（種別・版・アカウント）は積む側の
   * UNIQUE が重複として弾く。
   */
  markNoticesEnqueued(input: { readonly id: string; readonly now: Date }): Promise<void>;
}

/**
 * 同意の記録（`UD-126`）。
 *
 * ⚠️ **書き換えも削除もしない。** 同意は起きた出来事で、あとから
 * 無かったことにはできない。撤回したいときは、退会として別に扱う。
 */
export interface RecordConsentCommand {
  readonly accountId: string;
  readonly kind: ConsentRequiredKind;
  readonly versionId: string;
  readonly version: number;
  readonly consentedAt: Date;
}

export interface LegalConsentRepository {
  /**
   * その人の直近の同意。まだ無ければ `null`。
   *
   * ⚠️ **「同意済みか」ではなく「どの版か」を返す。** 真偽値だと、
   * 改定したあとに何に同意したのか分からなくなる。
   */
  findLatestConsent(
    accountId: string,
    kind: ConsentRequiredKind,
  ): Promise<LegalConsentRecord | null>;

  /**
   * 同意した版より後に施行された版のうち、再同意の印が立っているものがあるか。
   *
   * ⚠️ **「新しい版があるか」ではない。** 印が立っているものだけを見る。
   */
  hasPendingReconsent(
    kind: ConsentRequiredKind,
    consentedVersion: number,
    now: Date,
  ): Promise<boolean>;

  /**
   * 同意を記録する。
   *
   * ⚠️ **同じ版へ二重に押しても増やさない。** 画面の二度押しや
   * 再読み込みで行が増えると、いつ同意したのかが読めなくなる。
   */
  recordConsent(command: RecordConsentCommand): Promise<LegalConsentRecord>;
}
