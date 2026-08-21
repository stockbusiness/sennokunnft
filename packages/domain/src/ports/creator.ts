import type { SealedSecret } from './integration';
import type { PayoutAccountType } from '../creator/payout-account';
import type { CreatorLink } from '../creator/profile';
import type { PayoutLineDraft } from '../settlement/payout';

/**
 * 作家さま運営が必要とする口（P1-2）。
 *
 * ⚠️ **誰の分かを引数で受け取る形にしてある**が、**呼び出し側は必ず
 * トークンのアカウントを渡す**こと。要求から受け取ると、そこが他人の
 * 売上を覗く道になる。API 側でそれを縛っている。
 */

/** 保存されているプロフィール。⚠️ 画像は鍵で持つ（URL ではない）。 */
export interface CreatorProfileRecord {
  readonly accountId: string;
  readonly shopName: string | null;
  readonly bio: string | null;
  readonly links: readonly CreatorLink[];
  readonly iconKey: string | null;
  readonly coverKey: string | null;
  readonly invoiceNumber: string | null;
}

export interface CreatorProfilePort {
  find(accountId: string): Promise<CreatorProfileRecord | null>;
  save(input: {
    readonly accountId: string;
    readonly shopName: string | null;
    readonly bio: string | null;
    readonly links: readonly CreatorLink[];
    readonly invoiceNumber: string | null;
    readonly now: Date;
  }): Promise<CreatorProfileRecord>;
  /** 画像の鍵だけを差し替える。⚠️ ほかの項目に触れない。 */
  saveImageKey(input: {
    readonly accountId: string;
    readonly slot: 'icon' | 'cover';
    readonly key: string;
    readonly now: Date;
  }): Promise<void>;
}

/**
 * 締めた精算の明細。
 *
 * ⚠️ **見込みの明細（`buildPayoutDraft` の結果）と同じ形にしてある。**
 * 形が違うと、画面が「締めた月」と「締めていない月」で 2 通りになる。
 */
export interface CreatorEarningsPort {
  /** 締めた精算の明細を、見込みと同じ形で返す。 */
  linesOf(payoutId: string): Promise<readonly PayoutLineDraft[]>;
}

/**
 * お振込先を包む・解く（P1-3）。
 *
 * ⚠️ **`SecretCipherPort` と分けてある。** あちらは外部連携の資格情報用で、
 * 結び付け情報が「サービスと環境」になっている。お振込先で塞ぎたいのは
 * **別の作家さまの行へ貼り替えて支払先を差し替えること**なので、
 * 結び付ける相手はアカウントIDである。
 *
 * ⚠️ **復号を「取得」と同じ形にしない。** 復号できる口が読み取り系に
 * 見えると、いつか一覧や詳細から呼ばれる。呼ぶ先を絞れるよう口を分ける。
 */
export interface PayoutAccountCipherPort {
  seal(plaintext: string, accountId: string): SealedSecret;
  /** 鍵が違う・改ざん・別の作家さまの行なら `null`。⚠️ 理由は返さない。 */
  open(sealed: SealedSecret, accountId: string): string | null;
}

/** 保管しているお振込先。⚠️ **番号は包んだまま持つ。** */
export interface PayoutAccountRecord {
  readonly creatorAccountId: string;
  readonly bankName: string;
  readonly branchName: string;
  readonly accountType: PayoutAccountType;
  readonly sealedAccountNumber: SealedSecret;
  readonly maskedAccountNumber: string;
  readonly accountHolderKana: string;
  readonly updatedAt: Date;
}

export interface PayoutAccountPort {
  find(creatorAccountId: string): Promise<PayoutAccountRecord | null>;
  /**
   * 登録・差し替える。⚠️ **作家さま 1 人につき 1 件。**
   *
   * @returns 差し替えだったか（`true`）、初めての登録だったか（`false`）。
   *          ⚠️ **知らせの文面が変わる**ので、呼ぶ側が知る必要がある。
   */
  save(record: PayoutAccountRecord): Promise<{ readonly replaced: boolean }>;
}
