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
