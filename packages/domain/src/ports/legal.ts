import type { LegalDocumentKind, LegalDocumentVersion, TokushohoFields } from '../legal/document';

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
}
