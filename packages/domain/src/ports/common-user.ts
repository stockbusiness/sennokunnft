import type { CommonUserFailureKind, CommonUserResolution } from '../identity/common-user';

/**
 * 共通顧客HUB（代理店システム）との境界。
 *
 * ⚠️ **本システムから `common_user_id` を発行する口を用意しない。**
 * このポートに「作る」操作は無く、`resolve` しかない。
 * 発行できる関数が存在しなければ、うっかり発行することもできない。
 */

export interface ResolveCommonUserInput {
  /** 本システムを表す固定値。相手側で連携元を識別するために使う。 */
  readonly systemKey: string;
  /**
   * 本システムのアカウントID。
   *
   * ⚠️ **鍵はこれだけにする。** メール・電話・ウォレットを照合材料に混ぜない。
   * それらは本システムが検証していない値であり、送ると
   * 他人の検証済み ID に当たって紐付く経路ができる。
   */
  readonly externalUserId: string;
  /**
   * 見つからないときに作らせるか。
   *
   * ⚠️ 相手側の既定は `true`。**照会のつもりで省略すると人物が新規作成される。**
   * そのため、このポートでは省略できない必須項目にしてある。
   */
  readonly createIfMissing: boolean;
}

export type ResolveCommonUserResult =
  | { readonly ok: true; readonly resolution: CommonUserResolution }
  | {
      readonly ok: false;
      readonly kind: CommonUserFailureKind;
      /** ⚠️ 応答本文をそのまま入れない。個人情報が混ざりうる。 */
      readonly reason: string;
    };

export interface CommonUserDirectoryPort {
  resolve(input: ResolveCommonUserInput): Promise<ResolveCommonUserResult>;
}
