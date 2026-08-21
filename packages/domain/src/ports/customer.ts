import type { CustomerEntitlement, CustomerSummary } from '../customer/profile';
import type { DuplicateCandidate } from '../customer/duplicate';
import type { EmailChangeStatus, IdentityVerificationMethod } from '../customer/email-change';

/**
 * 顧客サポートが必要とする事実を集める口（P1-1）。
 *
 * ⚠️ **氏名とメールアドレスの平文を返す口を作らない**（`UD-503`）。
 * 型に無ければ、実装がうっかり載せても落ちる。
 *
 * ⚠️ **持ち主を付け替える口を作らない**（指示書 §11）。口が無ければ、
 * あとから足す人がまずここを読み、理由に行き当たる。
 */
export interface CustomerDirectoryPort {
  /** 照合用のメール値で引く。⚠️ 平文では引かない（持っていない）。 */
  findByEmailHash(emailHash: string, limit: number): Promise<readonly CustomerSummary[]>;
  findByCommonUserId(commonUserId: string, limit: number): Promise<readonly CustomerSummary[]>;
  findByAccountId(accountId: string): Promise<CustomerSummary | null>;
  /** 注文番号から辿る。⚠️ 「注文番号しか控えていない」問い合わせのため。 */
  findByOrderNumber(orderNumber: string): Promise<CustomerSummary | null>;

  entitlements(accountId: string, limit: number): Promise<readonly CustomerEntitlement[]>;
  orders(accountId: string, limit: number): Promise<readonly CustomerOrderRow[]>;
  refunds(accountId: string, limit: number): Promise<readonly CustomerRefundRow[]>;
  /** 同じ方かもしれないアカウント。⚠️ **候補まで。統合はしない。** */
  duplicateCandidates(accountId: string, limit: number): Promise<readonly DuplicateCandidate[]>;
}

/** 注文 1 件。⚠️ 金額はすべて整数（円）。 */
export interface CustomerOrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly refundStatus: string;
  readonly totalAmount: number;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
}

export interface CustomerRefundRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly amount: number;
  readonly reason: string;
  readonly status: string;
  readonly createdAt: Date;
}

/** アカウント単位の申し送り。⚠️ 注文単位のメモ（`UD-121`）とは別。 */
export interface AccountNotePort {
  add(input: {
    readonly accountId: string;
    readonly authorAccountId: string;
    readonly body: string;
    readonly now: Date;
  }): Promise<string>;
  list(accountId: string, limit: number): Promise<readonly AccountNoteRecord[]>;
}

export interface AccountNoteRecord {
  readonly id: string;
  readonly authorAccountId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * ご連絡先の変更申請。
 *
 * ⚠️ **新しいアドレスの平文を受け取らない。** 伏せた表記と照合用の値まで。
 */
export interface EmailChangeRequestPort {
  open(input: {
    readonly accountId: string;
    readonly requestedMaskedEmail: string;
    readonly requestedEmailHash: string;
    readonly openedByAccountId: string;
    readonly now: Date;
  }): Promise<string>;
  findById(id: string): Promise<EmailChangeRequestRecord | null>;
  list(accountId: string, limit: number): Promise<readonly EmailChangeRequestRecord[]>;
  verify(input: {
    readonly id: string;
    readonly method: IdentityVerificationMethod;
    readonly note: string | null;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<void>;
  settle(input: {
    readonly id: string;
    readonly status: 'completed' | 'rejected';
    readonly note: string | null;
    readonly actorAccountId: string;
    readonly now: Date;
  }): Promise<void>;
}

export interface EmailChangeRequestRecord {
  readonly id: string;
  readonly accountId: string;
  /** ⚠️ 伏せた表記。元へは戻せない。 */
  readonly requestedMaskedEmail: string;
  readonly status: EmailChangeStatus;
  readonly verificationMethod: IdentityVerificationMethod | null;
  readonly verifiedByAccountId: string | null;
  readonly verifiedAt: Date | null;
  readonly settledByAccountId: string | null;
  readonly settledAt: Date | null;
  readonly note: string | null;
  readonly openedByAccountId: string;
  readonly createdAt: Date;
}
