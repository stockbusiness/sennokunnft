import type { Role } from './authorization';

/**
 * 認証トークンの検証境界。
 *
 * 検証方式（共有シークレット HS256 か JWKS による非対称鍵か）は
 * **未決定（UD-801）**。どちらの実装でも差し替えられるようポート化している。
 */
export interface VerifiedIdentity {
  /** 認証プロバイダ側のユーザーID（JWT の `sub`）。 */
  readonly subject: string;
  readonly provider: string;
  readonly expiresAt: Date;
  /**
   * トークンが発行された時刻（JWT の `iat`）。無ければ `undefined`。
   *
   * ⚠️ **「いま本人が操作している」ことの根拠に使う**（`UD-118` の再認証）。
   * 取り返しのつかない操作の前に、発行から一定時間内であることを求める。
   * ⚠️ **認可の根拠にしない。** 新しいトークンであることは、権限があることを
   * 意味しない。権限は DB のロールとオーナーの印で決める。
   */
  readonly issuedAt?: Date;
  /**
   * 認証プロバイダが確認済みのメールアドレス（あれば）。
   *
   * ⚠️ **権限の判断に使わない。** 使ってよいのは
   * 「招待の宛先と同じ人か」の突き合わせだけ（`UD-803`）。
   * ここからロールを導くと、認証プロバイダ側の設定ひとつで
   * 権限昇格の経路になる。
   *
   * ⚠️ **確認済みのものだけを入れること。** 本人が自由に書ける欄を
   * そのまま入れると、宛先を騙って招待を横取りできる。
   */
  readonly email?: string;
  /**
   * 認証の強さ（Supabase の `aal` クレーム・`UD-801` の段階導入 段 1）。
   *
   * `aal1` はパスワードやマジックリンクだけ、`aal2` は二要素まで済んでいる。
   * 読めない・載っていないときは `undefined`。
   *
   * ⚠️ **これで誰も拒否しない**（段 1）。いま使うのは、本番販売ガードが
   * 「オーナーが二要素で入った記録」を残すためだけ。拒否を入れるのは
   * オーナーが登録を済ませたあと（段 3）。順序を飛ばすと、
   * **オーナーが自分の管理画面から締め出される**——人事権を持つのは
   * オーナーだけなので、締め出されると DB を直接触る以外に戻る道がない。
   *
   * ⚠️ **権限の根拠にしない。** 二要素で入っていることは、権限が
   * あることを意味しない。権限は DB のロールとオーナーの印で決める。
   */
  readonly assuranceLevel?: 'aal1' | 'aal2';
}

export type TokenVerificationFailure =
  | 'malformed'
  | 'invalid_signature'
  | 'unsupported_algorithm'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'expired'
  | 'missing_subject';

export type TokenVerificationResult =
  | { readonly ok: true; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly failure: TokenVerificationFailure };

export interface TokenVerifierPort {
  verify(token: string): Promise<TokenVerificationResult>;
}

/**
 * アプリケーション内のアカウント。
 *
 * **ロールの正は本システムの DB に置く。**
 * JWT のクレームからロールを読まないのは、認証プロバイダ側の任意項目には
 * 利用者が改変しうる経路があり、そこを信用すると権限昇格につながるため
 * （AUTHORIZATION_DESIGN.md §1.3）。
 */
export interface AccountRecord {
  readonly id: string;
  readonly authProvider: string;
  readonly authSubject: string;
  readonly role: Role;
  readonly status: 'active' | 'suspended';
  /** 人に権限を配れるか（`UD-803`）。正は DB。 */
  readonly isOwner: boolean;
  /**
   * 照合用のメール値（`UD-121`）。無い、または変換できない配備では `null`。
   *
   * ⚠️ **平文ではない。** 元へ戻せない値で、問い合わせのときに
   * 「聞いたアドレスを同じ手順で変換して一致を探す」ためだけに持つ。
   * ⚠️ **認可に使わない。** 誰であるかは `id` が決める。
   */
  readonly emailHash: string | null;
  /**
   * 二要素で入った最後の時刻（P0-7 の 8 番目）。
   *
   * ⚠️ **「入ったことがある」であって、いまの設定ではない。**
   */
  readonly lastAal2At?: Date | null;
}

export interface AccountLookupPort {
  findByAuthSubject(provider: string, subject: string): Promise<AccountRecord | null>;
  /**
   * 初回アクセス時にアカウントを作る（Just-In-Time provisioning）。
   * **作成されるロールは常に `buyer`。** 昇格は運営操作でのみ行う。
   *
   * @param emailHash 照合用のメール値（`UD-121`）。変換できないなら `null`。
   *   ⚠️ **平文を渡さない。** 呼び出し側で変換してから渡すこと。
   */
  provision(provider: string, subject: string, emailHash: string | null): Promise<AccountRecord>;

  /**
   * 照合用のメール値を覚え直す（`UD-121`）。
   *
   * ⚠️ **値が変わったときだけ呼ぶこと。** 毎回書くと、読むだけの要求が
   * すべて書き込みになる。
   * ⚠️ **`null` で上書きしない。** 鍵の無い配備を一度通しただけで、
   * 既に持っていた照合値が消える。実装は `null` を無視する。
   */
  rememberEmailHash(accountId: string, emailHash: string | null): Promise<void>;

  /**
   * 二要素で入ったことを覚える（P0-7 の 8 番目・`UD-801` の段 1）。
   *
   * ⚠️ **毎回書かない。** 読むだけの要求まで書き込みになる。呼ぶのは
   * 記録が無いか、十分に古いときだけ（`MFA_RECORD_INTERVAL_MS`）。
   * ⚠️ **消さない側へ倒す。** `aal1` で入り直したからといって、
   * 過去の記録を消さない。二要素を外したことは、こちらからは分からない
   * ——判定の側で期限を切る。
   */
  rememberMfa(accountId: string, at: Date): Promise<void>;
}

/**
 * 二要素の記録を書き直す間隔。
 *
 * ⚠️ **短くしない。** 要求のたびに書くと、読むだけの画面が全部
 * 書き込みになる。判定は日の単位で見るので、1 時間で十分細かい。
 */
export const MFA_RECORD_INTERVAL_MS = 60 * 60 * 1000;
