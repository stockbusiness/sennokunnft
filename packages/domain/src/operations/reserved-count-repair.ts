import {
  stillHeldQuantity,
  type ReservedCountDriftDirection,
  type ReservedCountDriftOrder,
} from './reserved-count-drift';

/**
 * 押さえのずれを直す（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24 決定）。
 *
 * ⚠️ **整合性チェックの「直さない。数えるだけ」を、ここだけ一部ひるがえす**
 * （`consistency.ts`）。ひるがえすにあたって置いた歯止めが 3 つある。
 *
 * 1. **人が押したときだけ。** 夜間の自動修復はしない。自動で直すと 0 件が
 *    常態になり、チェックが何も教えてくれなくなる——**バグを黙って洗浄する
 *    機械**になる。
 * 2. **押しても赤が消えない。** 原因が分からないまま直したものは
 *    `causeState = 'unknown'` として残り続ける。誰かが突き止めて閉じるまで
 *    管理画面に居座る。「直したから終わり」にできない。
 * 3. **人が数字を選べない。** 直す先は仮引当と受取権から**計算で出る**。
 *    決済 P0/P1 §9.3「在庫数と無関係な予約作成」の禁止に触れないのは、
 *    ここが「合わせる」であって「入れる」ではないため。
 *
 * ⚠️ **「原因が分かっていること」を押す条件にはしていない。** 機械は人が
 * 分かっているかを確かめられず、確かめるふりをすれば「不明」と書いて押す
 * 素通りの口になる。加えて、**押さえが足りない側は急ぐ**——いま売り越しが
 * 起きうる状態を、原因究明が済むまで放置させるほうが危ない。止める場所を
 * 「押せるかどうか」から「記録が消えないこと」へ移してある。
 */

/** 原因を突き止めたうえで直したのか、分からないまま急いで直したのか。 */
export const RESERVED_COUNT_REPAIR_CAUSE_STATES = ['identified', 'unknown'] as const;
export type ReservedCountRepairCauseState = (typeof RESERVED_COUNT_REPAIR_CAUSE_STATES)[number];

/**
 * 理由に求める最短の長さ。
 *
 * ⚠️ **中身は検められない。** これは「その人が分かっているか」の検査ではなく、
 * **一度手を止めさせるため**のもの。空欄で押せると、後から読む人に何も
 * 残らない。
 */
export const RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH = 10;
/** ⚠️ 上限も要る。無制限だと画面と監査ログが壊れる。 */
export const RESERVED_COUNT_REPAIR_REASON_MAX_LENGTH = 1000;

export interface ReservedCountRepairCommand {
  readonly artworkId: string;
  /**
   * 画面が見ていた押さえの数。
   *
   * ⚠️ **これが要の歯止め。** 10 時に一覧を開き 10 時 5 分に押す、その
   * あいだに正常なご注文が 1 件入っていたら、**画面が見ていた古い数字で
   * 上書きしてしまい、直すつもりが逆にずれを作る。**
   */
  readonly observedReservedCount: number;
  readonly reason: string;
  readonly causeState: ReservedCountRepairCauseState;
}

/** 行を掴んだあとの、いまの姿。 */
export interface ReservedCountRepairSubject {
  readonly reservedCount: number;
  readonly issuedCount: number;
  readonly maxSupply: number;
  /** ⚠️ あるべき値はここから数え直す。呼ぶ側に計算させない。 */
  readonly orders: readonly ReservedCountDriftOrder[];
}

/**
 * 直さない理由。
 *
 * ⚠️ **語彙を閉じる。** 画面がそれぞれに違う言い方をするため、
 * 増やすときは文言も一緒に決める。
 */
export const RESERVED_COUNT_REPAIR_REFUSALS = [
  /** 理由が書かれていない、または短すぎる／長すぎる。 */
  'reason_required',
  /** 画面を開いてから押すまでに、押さえの数が動いた。 */
  'stale_view',
  /** もうずれていない。調べているあいだに直った。 */
  'no_drift',
  /**
   * 直すと在庫の上限を超える。
   *
   * ⚠️ **これはずれではなく、すでに売り越している。** 直せば真実を
   * 書けるが、`artworks_supply_within_max` が拒む。**この口で扱うべき
   * 事態ではない**（ご注文を取り消すか上限を上げるかの判断が要る）ので、
   * DB の制約違反として出すのではなく、ここで名前を付けて止める。
   */
  'exceeds_max_supply',
] as const;
export type ReservedCountRepairRefusal = (typeof RESERVED_COUNT_REPAIR_REFUSALS)[number];

export interface ReservedCountRepairPlan {
  readonly artworkId: string;
  /** 直す前の押さえ。⚠️ 監査のために持ち回る。 */
  readonly before: number;
  /** 直したあとの押さえ。⚠️ 仮引当と受取権から数え直した値。 */
  readonly after: number;
  /** `before − after`。⚠️ 符号を保つ。 */
  readonly difference: number;
  readonly direction: ReservedCountDriftDirection;
  readonly reason: string;
  readonly causeState: ReservedCountRepairCauseState;
  /**
   * 直す前の内訳。
   *
   * ⚠️ **「12 → 9」だけでは後から何も辿れない。** どの注文が・いくつ
   * 押さえ・いくつ発行済みだったかを丸ごと焼き付けて初めて、原因を
   * 追える。修復の口を置くための条件がこれである。
   */
  readonly snapshot: readonly ReservedCountDriftOrder[];
}

export type ReservedCountRepairDecision =
  | { readonly ok: true; readonly plan: ReservedCountRepairPlan }
  | { readonly ok: false; readonly refusal: ReservedCountRepairRefusal };

/**
 * 直してよいかを決める。
 *
 * ⚠️ **順番に意味がある。** 理由（送られてきた値の検査）→ 画面の古さ
 * → ずれの有無 → 上限。古い画面から押されたときに「ずれていません」と
 * 返すと、**直ったと誤解される。**
 */
export function planReservedCountRepair(
  command: ReservedCountRepairCommand,
  subject: ReservedCountRepairSubject,
): ReservedCountRepairDecision {
  const reason = command.reason.trim();
  if (
    reason.length < RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH ||
    reason.length > RESERVED_COUNT_REPAIR_REASON_MAX_LENGTH
  ) {
    return { ok: false, refusal: 'reason_required' };
  }

  if (command.observedReservedCount !== subject.reservedCount) {
    return { ok: false, refusal: 'stale_view' };
  }

  /*
    ⚠️ **一覧と同じ算術を使う**（`stillHeldQuantity`）。別に書くと、
       画面が見せた数と違う数へ直すことになる。
  */
  const after = subject.orders.reduce((total, order) => total + stillHeldQuantity(order), 0);
  const difference = subject.reservedCount - after;
  if (difference === 0) {
    return { ok: false, refusal: 'no_drift' };
  }

  /*
    ⚠️ **増やす側だけが上限に触れる。** 減らす側は必ず通るので、
       ここは実質「押さえが足りない」場合の検査である。
  */
  if (after + subject.issuedCount > subject.maxSupply) {
    return { ok: false, refusal: 'exceeds_max_supply' };
  }

  return {
    ok: true,
    plan: {
      artworkId: command.artworkId,
      before: subject.reservedCount,
      after,
      difference,
      direction: difference > 0 ? 'over' : 'under',
      reason,
      causeState: command.causeState,
      snapshot: subject.orders,
    },
  };
}

/** 原因未特定として残っている 1 件。 */
export interface ReservedCountRepairRecord {
  readonly id: string;
  readonly artworkId: string;
  readonly artworkTitle: string;
  readonly before: number;
  readonly after: number;
  readonly difference: number;
  readonly direction: ReservedCountDriftDirection;
  readonly reason: string;
  readonly causeState: ReservedCountRepairCauseState;
  readonly snapshot: readonly ReservedCountDriftOrder[];
  readonly repairedByAccountId: string;
  readonly repairedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedByAccountId: string | null;
  readonly resolutionNote: string | null;
}

export const RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH = 10;
export const RESERVED_COUNT_REPAIR_RESOLUTION_MAX_LENGTH = 1000;

export const RESERVED_COUNT_REPAIR_RESOLVE_REFUSALS = [
  'note_required',
  /** 原因が分かったうえで直したものは、はじめから積み残しではない。 */
  'not_pending',
  /** すでに閉じている。⚠️ 二度書きさせない。 */
  'already_resolved',
] as const;
export type ReservedCountRepairResolveRefusal =
  (typeof RESERVED_COUNT_REPAIR_RESOLVE_REFUSALS)[number];

export type ReservedCountRepairResolveDecision =
  | { readonly ok: true; readonly note: string }
  | { readonly ok: false; readonly refusal: ReservedCountRepairResolveRefusal };

/**
 * 原因未特定の積み残しを閉じてよいかを決める。
 *
 * ⚠️ **閉じるのは「原因が分かった」と言うこと。** 消す操作ではないので、
 * 何が分かったのかを必ず書かせる。書けないなら、まだ閉じるときではない。
 */
export function planReservedCountRepairResolution(
  record: Pick<ReservedCountRepairRecord, 'causeState' | 'resolvedAt'>,
  note: string,
): ReservedCountRepairResolveDecision {
  const trimmed = note.trim();
  if (
    trimmed.length < RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH ||
    trimmed.length > RESERVED_COUNT_REPAIR_RESOLUTION_MAX_LENGTH
  ) {
    return { ok: false, refusal: 'note_required' };
  }
  if (record.causeState !== 'unknown') {
    return { ok: false, refusal: 'not_pending' };
  }
  if (record.resolvedAt !== null) {
    return { ok: false, refusal: 'already_resolved' };
  }
  return { ok: true, note: trimmed };
}

/**
 * まだ閉じていない、原因未特定の件数。
 *
 * ⚠️ **これがこの機能の心臓部。** 整合性チェックは修復で 0 件に戻るが、
 * この数は残る。**直したことで赤が消えるのを許さない**ためにある。
 */
export function pendingRepairCount(records: readonly ReservedCountRepairRecord[]): number {
  return records.filter((row) => row.causeState === 'unknown' && row.resolvedAt === null).length;
}
