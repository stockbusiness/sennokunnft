import type { ListCursor } from '../shared/cursor';

/**
 * 監査ログの閲覧（管理画面・外部連携 指示書 §5）。
 *
 * 記録する側は `AuditLogPort` にある。こちらは**読む側**で、
 * 「誰が・いつ・何を・どれに対して行ったか」を運用が辿るためのもの。
 */

/** 監査ログの 1 行。 */
export interface AuditLogEntryRecord {
  readonly id: string;
  /** `null` はシステムによる自動操作。 */
  readonly actorAccountId: string | null;
  /**
   * 操作した人の連絡先。
   *
   * ⚠️ **見せる相手を絞る。** スタッフ一覧（`staff.view`）を
   * オーナーだけに開いたのと同じ理由で、ここでも業務用の連絡先を
   * 誰にでも見せない。読み出す側が `null` を入れて落とす。
   */
  readonly actorEmail: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  /** 何が起きたかの要約。⚠️ 出す前に `redactAuditSummary` を通す。 */
  readonly summary: Record<string, unknown>;
  readonly occurredAt: Date;
}

export interface AuditLogQuery {
  /** 操作名での絞り込み。前方一致（`staff` で `staff.invite` も拾う）。 */
  readonly actionPrefix: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly actorAccountId: string | null;
  readonly cursor: AuditLogCursor | null;
  readonly limit: number;
  /**
   * 操作した人の連絡先を読むか。
   *
   * ⚠️ **「読んでから出すか決める」ではなく、出さないなら読まない。**
   * 配送本文を SELECT しないのと同じ理由。取ってしまえば、その値は
   * プロセスのメモリに乗り、例外やログの出力対象になりうる。
   */
  readonly includeActorContact: boolean;
}

/** 続きを読む位置。並び順は「発生時刻の新しい順、同時刻なら行IDの降順」。 */
export type AuditLogCursor = ListCursor;

export interface AuditLogPage {
  readonly items: readonly AuditLogEntryRecord[];
  readonly nextCursor: AuditLogCursor | null;
}

export const AUDIT_LOG_PAGE_SIZE = 30;
export const AUDIT_LOG_MAX_PAGE_SIZE = 100;

/** 要約の値が長すぎるときに切り詰める長さ。 */
const MAX_SUMMARY_VALUE_LENGTH = 200;

/** 伏せたことを示す印。空文字にすると「値が無い」と読み違えられる。 */
export const REDACTED_MARK = '***';

/**
 * 監査ログの要約から連絡先を伏せる。
 *
 * ⚠️ **鍵名の一覧（許可リスト）で判定しない。** 新しい操作を足した人が
 * 一覧へ書き足すのを忘れると、その項目は黙って表示されるか、黙って消える。
 * どちらも気づけない。値の形で判定すれば、**これから足される項目にも効く**。
 *
 * ⚠️ **これは最後の受け皿であって、方針ではない。** 方針は
 * 「要約へ個人情報を入れない」。実際にはスタッフ招待の宛先だけは
 * 残す必要があり（誰を招いたか辿れないと誤招待に対処できない）、
 * その 1 件のためにここがある。ほかの秘匿値（トークン・鍵・署名）は
 * そもそも記録していないので、ここでは扱わない。
 *
 * @param includeContact 連絡先をそのまま出してよいか（オーナーのみ真）
 */
export function redactAuditSummary(
  summary: Record<string, unknown>,
  options: { readonly includeContact: boolean },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(summary)) {
    result[key] = redactValue(value, options.includeContact);
  }
  return result;
}

function redactValue(value: unknown, includeContact: boolean): unknown {
  if (typeof value === 'string') {
    if (!includeContact && looksLikeContact(value)) {
      return REDACTED_MARK;
    }
    return value.length > MAX_SUMMARY_VALUE_LENGTH
      ? `${value.slice(0, MAX_SUMMARY_VALUE_LENGTH)}…`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, includeContact));
  }
  if (value !== null && typeof value === 'object') {
    const nested: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      nested[key] = redactValue(item, includeContact);
    }
    return nested;
  }
  return value;
}

/**
 * メールアドレスらしい文字列か。
 *
 * ⚠️ **厳密な検証にしない。** ここでの誤りの重さは左右で違う。
 * 取りこぼせば連絡先が表示され、取りすぎても業務値がひとつ伏せ字になるだけ。
 * だから「`@` の後ろに `.` がある」程度のゆるい判定で、広めに拾う。
 */
function looksLikeContact(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0) {
    return false;
  }
  return value.indexOf('.', at) > at + 1;
}
