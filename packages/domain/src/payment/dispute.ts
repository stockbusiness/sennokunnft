import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * チャージバック（決済の争い）を、業務の事象へ正規化する。
 *
 * ⚠️ **争いが起きたことと、返金されたことは別である。** 申し立てを受けた
 * 時点では、まだ何も返っていない。ここで受取権を取り消すと、**こちらが
 * 勝ったときに、取り上げたものを返せない**（外部のウォレットへ渡した
 * ものは、こちらからは戻せない）。
 *
 * ⚠️ **決着（敗訴）ではじめて返金として扱う。** そのときにはもう引かれて
 * いる。こちらの都合で「対象外」にしても、事実は変わらない。
 *
 * ⚠️ **事業者固有の型をここへ持ち込まない。** Stripe の SDK 型は
 * `@sengoku/integrations` の Adapter で止める。
 */

export const DISPUTE_STATUSES = [
  /**
   * 事前の警告。**まだ争いではない。**
   *
   * ⚠️ **お金は動いていない。** Stripe の `warning_*` がここに来る。
   * カード会社が調べ始めただけで、申し立てにならずに消えることもある。
   * 争いと同じ扱いにすると、消えた警告のぶんまで精算を止めてしまう。
   */
  'warning',
  /** 申し立てを受けた。**期限までに証拠を出す必要がある。** */
  'needs_response',
  /** 証拠を出し、審理中。 */
  'under_review',
  /** こちらが勝った。**返金にならない。** */
  'won',
  /** こちらが負けた。**もう引かれている。** */
  'lost',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** 争いの決着。 */
export const DISPUTE_OUTCOMES = ['warning', 'open', 'won', 'lost'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

const OUTCOME_BY_STATUS: Readonly<Record<DisputeStatus, DisputeOutcome>> = {
  warning: 'warning',
  needs_response: 'open',
  under_review: 'open',
  won: 'won',
  lost: 'lost',
};

export function disputeOutcome(status: DisputeStatus): DisputeOutcome {
  return OUTCOME_BY_STATUS[status];
}

/**
 * まだ決着していないか。
 *
 * ⚠️ **警告は「開いている」に数えない。** 数えると、申し立てにならずに
 * 消える警告のぶんまで精算を止め、作家さまへのお支払いが理由なく遅れる。
 */
export function isDisputeOpen(status: DisputeStatus): boolean {
  return disputeOutcome(status) === 'open';
}

/** 決着したか（勝ち負けがついたか）。 */
export function isDisputeClosed(status: DisputeStatus): boolean {
  const outcome = disputeOutcome(status);
  return outcome === 'won' || outcome === 'lost';
}

/**
 * この状態で、返金として記録すべきか。
 *
 * ⚠️ **敗訴のときだけ。** 争いが起きただけでは返金ではない。
 */
export function shouldRecordRefund(status: DisputeStatus): boolean {
  return status === 'lost';
}

/**
 * 状態を進めてよいか。
 *
 * ⚠️ **決着からは戻さない。** 事業者の知らせは前後して届く。`closed` の
 * あとに `created` が届いたとき、素直に上書きすると**決着した争いが
 * 開き直る**——そして精算が理由なく止まり続ける。
 *
 * ⚠️ **同じ状態への更新は許す。** 再送で落ちる形にすると、事業者へ
 * 5xx を返し続けることになる。
 */
export function canAdvanceDispute(
  from: DisputeStatus,
  to: DisputeStatus,
): Result<true, DomainError> {
  if (from === to) {
    return ok(true);
  }
  if (isDisputeClosed(from)) {
    return err(domainError('DISPUTE_NOT_ACTIONABLE', 'dispute already closed'));
  }
  /*
    ⚠️ **警告へは戻さない。** 申し立てを受けたあとに警告の知らせが
       遅れて届くことがある。戻すと「まだ争いではない」ことになり、
       精算の歯止めが外れる。
  */
  if (to === 'warning') {
    return err(domainError('DISPUTE_NOT_ACTIONABLE', 'cannot go back to warning'));
  }
  return ok(true);
}

/**
 * 事業者が言う争いの理由。
 *
 * ⚠️ **許可リストを通す。** 事業者の文字列をそのまま保存すると、
 * 知らない値が画面と集計に流れ込む。カード会社の事情はこちらの語彙ではない。
 */
export const DISPUTE_REASONS = [
  'fraudulent',
  'product_not_received',
  'product_unacceptable',
  'duplicate',
  'subscription_canceled',
  'unrecognized',
  'credit_not_processed',
  'general',
  /** 許可リストに無い値。⚠️ 捨てずに「知らない」として残す。 */
  'unknown',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export function toSafeDisputeReason(raw: string | null | undefined): DisputeReason {
  if (raw === null || raw === undefined) {
    return 'unknown';
  }
  return (DISPUTE_REASONS as readonly string[]).includes(raw) ? (raw as DisputeReason) : 'unknown';
}

/**
 * 一覧で見たときの急ぎ具合（2026-08-22）。
 *
 * ⚠️ **色を決めるためだけの区分である。** 業務の状態（`DisputeStatus`）と
 * 混ぜない。混ぜると、色を変えたいだけのときに状態遷移の規則を触ることになる。
 */
export const DISPUTE_URGENCIES = ['overdue', 'due_soon', 'open', 'closed'] as const;
export type DisputeUrgency = (typeof DISPUTE_URGENCIES)[number];

/**
 * その争いが、いまどれだけ急ぐか。
 *
 * ⚠️ **期限を過ぎたものを「決着」に混ぜない。** 過ぎると自動的に負けるが、
 * 事業者からの知らせが届くまで状態は `needs_response` のままである。
 * 「もう手遅れかもしれない」ことは、決着とは別に見えている必要がある。
 *
 * ⚠️ **期限を持たない争いは「急ぎ」に数えない。** 決着した争いや警告には
 * 期限が無いことがある。分からないものを急ぎにすると**毎日赤いままになり**、
 * 本当に急ぐものが埋もれる。
 *
 * ⚠️ **警告は `closed` へ寄せない。** まだ何も決まっていない。ただし
 * 急ぎでもない——`open` に置き、色を付けない側で扱う。
 */
export function disputeUrgency(
  input: {
    readonly status: DisputeStatus;
    readonly evidenceDueAt: Date | null;
  },
  now: Date,
  dueSoonBefore: Date,
): DisputeUrgency {
  if (isDisputeClosed(input.status)) {
    return 'closed';
  }
  if (input.evidenceDueAt === null) {
    return 'open';
  }
  if (input.evidenceDueAt.getTime() <= now.getTime()) {
    return 'overdue';
  }
  return input.evidenceDueAt.getTime() <= dueSoonBefore.getTime() ? 'due_soon' : 'open';
}
