import type { ReissuableEntitlement } from '../entitlement/reissue';
import type { WalletClaimableEntitlement } from '../entitlement/wallet-claim';

/** Claim の照会結果。作品名は `GET` の応答に必要なので一緒に取る。 */
export interface ClaimLookupResult {
  readonly entitlement: WalletClaimableEntitlement;
  /** 購入者のアカウントID。受取を確定するときに記録する。 */
  readonly purchaserAccountId: string;
  readonly cardName: string;
}

/** 受取確定の結果。 */
export type ClaimConfirmOutcome =
  /** この呼び出しが確定させた。 */
  | { readonly kind: 'claimed' }
  /**
   * 確定できなかった。
   *
   * 判定した時点では受け取り可能だったが、書き込むまでの隙間に
   * 別の要求が確定させた、という意味。**失敗ではなく競合。**
   */
  | { readonly kind: 'raced' };

/**
 * Claim の永続化。
 *
 * ⚠️ **`confirmClaim` は「読んでから書く」実装にしてはならない。**
 * 状態を読んで受け取り可能だと確かめてから書くと、そのあいだに
 * 別の要求が同じ判定を通る。同時に 2 本届けば 2 本とも確定してしまう。
 * **現在の状態を条件に含めた UPDATE で、更新できた件数で決める。**
 * 実装がこれを守らないと、受取権 1 つから複数回受け取れる。
 */
export interface ClaimRepositoryPort {
  /**
   * Claim トークンのハッシュから受取権を引く。
   *
   * ⚠️ 平文のトークンは保存していない。呼び出し元がハッシュ化してから渡す。
   */
  findByTokenHash(claimTokenHash: string): Promise<ClaimLookupResult | null>;

  /** 受取を確定する。確定できたのが自分かどうかを返す。 */
  confirmClaim(input: {
    readonly entitlementId: string;
    readonly commonUserId: string;
    readonly accountId: string;
    readonly now: Date;
  }): Promise<ClaimConfirmOutcome>;

  /** 再発行の判定に必要な情報を、受取権IDから引く。 */
  findForReissue(entitlementId: string): Promise<ReissuableEntitlement | null>;

  /**
   * 受取トークンを差し替える。
   *
   * ⚠️ **差し替えられたかどうかを、呼び出し元が確実に知れること。**
   * 同時に 2 本の再発行が走ると、保存できるハッシュは 1 つだけなので、
   * 負けた側のトークンは**作られた瞬間から無効**になる。
   * それを「発行できました」と返すと、利用者は使えない URL を渡される。
   * 現在のハッシュを条件に含め、**書けた側だけが成功を名乗る**。
   *
   * 実装は「読んでから書く」にしてはならない。条件付き UPDATE の
   * 更新行数で判定すること。
   */
  rotateClaimToken(input: {
    readonly entitlementId: string;
    readonly accountId: string;
    /** 判定時に見えていたハッシュ。これと一致するときだけ差し替える。 */
    readonly expectedTokenHash: string;
    readonly newTokenHash: string;
    readonly now: Date;
  }): Promise<boolean>;
}
