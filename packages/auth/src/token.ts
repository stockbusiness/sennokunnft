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
}

export interface AccountLookupPort {
  findByAuthSubject(provider: string, subject: string): Promise<AccountRecord | null>;
  /**
   * 初回アクセス時にアカウントを作る（Just-In-Time provisioning）。
   * **作成されるロールは常に `buyer`。** 昇格は運営操作でのみ行う。
   */
  provision(provider: string, subject: string): Promise<AccountRecord>;
}
