import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 共通顧客ID（`common_user_id`）の紐付け。
 *
 * ⚠️ **本システムは `common_user_id` を発行しない。**
 * 発行元は代理店システム（共通顧客HUB）のみ。
 * ここにあるのは「外から受け取った値をどう受け入れるか」の判断だけで、
 * 生成する関数は**意図的に存在しない**。
 *
 * ⚠️ **`common_user_id` を本システムの主キーにしない。**
 * 外部が発行した値を主キーにすると、相手の都合で自分のデータが壊れる。
 * 本システムの人物識別は `accounts.id` のまま変えない。
 */

/** 紐付けの状態。 */
export const COMMON_USER_STATUSES = [
  /** まだ解決を試みていない。 */
  'UNRESOLVED',
  /** 解決を試みたが完了していない。再試行の対象。 */
  'PENDING',
  /** 解決済み。`commonUserId` が入っている。 */
  'RESOLVED',
  /**
   * 人が確認するまで動かさない状態。次のいずれか。
   *  - 既存の値と異なる値が返った
   *  - 本システムが検証していない属性で一致した
   *  - 名寄せ候補が残っている（同一人物が重複した可能性）
   *
   * 理由は `lastError` で区別する。
   */
  'CONFLICT',
  /** 再試行の上限を超えた。人手での対応が要る。 */
  'ERROR',
] as const;
export type CommonUserStatus = (typeof COMMON_USER_STATUSES)[number];

/**
 * `common_user_id` の形式。
 *
 * 代理店システムの契約で `cu_` ＋ 32 桁の hex と定められている。
 * 形を確認するのは、取り違えた値（たとえば自社の account id）を
 * そのまま保存してしまう事故を防ぐため。
 */
const COMMON_USER_ID_PATTERN = /^cu_[0-9a-f]{32}$/;

export function isCommonUserId(value: string): boolean {
  return COMMON_USER_ID_PATTERN.test(value);
}

/** 解決結果の照合根拠（代理店システムの `matched_by`）。 */
export const MATCHED_BY_VALUES = [
  'common_user_id',
  'system_account_link',
  'service_user_mapping',
  'identity:line',
  'identity:email',
  'identity:phone',
  'identity:wallet',
  'created',
] as const;
export type MatchedBy = (typeof MATCHED_BY_VALUES)[number];

/**
 * 補完に使ってよい照合根拠。
 *
 * ⚠️ **`identity:*` を受け入れない。**
 * これはメール・電話・ウォレットなど、**本システムが発行していない値**での一致を意味する。
 * その値が本当にこの利用者のものであることを本システムは確かめていないので、
 * 受け入れると他人の `common_user_id` に紐付く経路ができる。
 *
 * 受け入れるのは、本システムの `accounts.id` を鍵にした一致だけ。
 * 自分が発行した鍵での一致なら、構成上つねに同じ人物を指す。
 */
const ACCEPTABLE_MATCHES: readonly MatchedBy[] = [
  'common_user_id',
  'system_account_link',
  'service_user_mapping',
  'created',
];

export function isAcceptableMatch(matchedBy: MatchedBy): boolean {
  return ACCEPTABLE_MATCHES.includes(matchedBy);
}

/** アカウントが持つ紐付け情報。 */
export interface CommonUserLink {
  readonly accountId: string;
  readonly commonUserId: string | null;
  readonly status: CommonUserStatus;
  readonly linkedAt: Date | null;
  readonly lastError: string | null;
  readonly attemptCount: number;
  /** 次に再試行してよい時刻。`null` は「いま試してよい」。 */
  readonly nextAttemptAt: Date | null;
}

/** 代理店システムからの応答のうち、判断に使う部分。 */
export interface CommonUserResolution {
  readonly commonUserId: string;
  readonly matchedBy: MatchedBy;
  /**
   * `ok` 以外は**同一人物が重複した可能性がある**という意味。
   * 例: `unverified_candidate_not_auto_merged`
   */
  readonly identityMatchStatus: string;
}

/** 失敗の分類。再試行してよいかどうかが変わる。 */
export type CommonUserFailureKind =
  /** 通信できなかった・時間切れ・相手が 5xx。**時間をおけば直りうる。** */
  | 'transient'
  /** 相手が 4xx。送っている内容が悪いので、同じ内容で再送しても直らない。 */
  | 'permanent';

/** 再試行の上限。超えたら人手に回す。 */
export const MAX_LINK_ATTEMPTS = 5;

/**
 * 再試行の間隔（分）。
 *
 * 指数的に伸ばすのは、相手が落ちているときに叩き続けて
 * 復旧を妨げないため。
 */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240] as const;

export function backoffMinutes(attemptCount: number): number {
  const index = Math.min(Math.max(attemptCount - 1, 0), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[index] ?? 240;
}

/** まだ解決していないアカウントの初期状態。 */
export function unresolvedLink(accountId: string): CommonUserLink {
  return {
    accountId,
    commonUserId: null,
    status: 'UNRESOLVED',
    linkedAt: null,
    lastError: null,
    attemptCount: 0,
    nextAttemptAt: null,
  };
}

/** いま解決を試みてよいか。 */
export function isDueForAttempt(link: CommonUserLink, now: Date): boolean {
  if (link.status === 'RESOLVED' || link.status === 'CONFLICT' || link.status === 'ERROR') {
    return false;
  }
  if (link.nextAttemptAt === null) {
    return true;
  }
  return link.nextAttemptAt.getTime() <= now.getTime();
}

/**
 * 解決結果を受け入れる。
 *
 * ⚠️ **既に値を持っているアカウントに、違う値を上書きしない。**
 * 上書きすると、受取先が黙って別人に変わる。
 * 気付ける形にするため `CONFLICT` で止め、人の判断を待つ。
 */
export function applyResolution(
  link: CommonUserLink,
  resolution: CommonUserResolution,
  now: Date,
): Result<CommonUserLink, DomainError> {
  if (!isCommonUserId(resolution.commonUserId)) {
    return err(
      domainError('COMMON_USER_ID_INVALID', 'common_user_id does not match the contracted format'),
    );
  }

  if (!isAcceptableMatch(resolution.matchedBy)) {
    // 未検証の属性で一致した結果は受け入れない（上の ACCEPTABLE_MATCHES 参照）。
    return ok({
      ...link,
      status: 'CONFLICT',
      lastError: `unacceptable match: ${resolution.matchedBy}`,
      attemptCount: link.attemptCount + 1,
      nextAttemptAt: null,
    });
  }

  if (link.commonUserId !== null && link.commonUserId !== resolution.commonUserId) {
    return ok({
      ...link,
      // 既存の値は残したまま止める。消すと復旧の手がかりが無くなる。
      status: 'CONFLICT',
      lastError: 'resolved id differs from the stored id',
      attemptCount: link.attemptCount + 1,
      nextAttemptAt: null,
    });
  }

  if (resolution.identityMatchStatus !== 'ok') {
    // ⚠️ **名寄せ候補が残っている＝同一人物が重複した可能性がある。**
    //
    // 代理店システムは、未検証のメール・電話・ウォレットが一致しても
    // 自動統合せず、この状態を返す。つまり「この人物が本当に一人なのか、
    // まだ確定していない」という意味になる。
    //
    // 記録だけ残して RESOLVED へ進めると、確定していない人物あてに
    // 受取先が決まってしまう。Claim は取り返しがつかないので、
    // 曖昧なまま通さず、人の確認を待つ。
    //
    // ID そのものは保存する。運用で中身を確認するときの手がかりになる。
    return ok({
      ...link,
      commonUserId: resolution.commonUserId,
      status: 'CONFLICT',
      linkedAt: null,
      lastError: `identity_match_status=${resolution.identityMatchStatus}`,
      attemptCount: link.attemptCount + 1,
      nextAttemptAt: null,
    });
  }

  return ok({
    ...link,
    commonUserId: resolution.commonUserId,
    status: 'RESOLVED',
    linkedAt: now,
    lastError: null,
    attemptCount: link.attemptCount + 1,
    nextAttemptAt: null,
  });
}

/**
 * 解決に失敗した。
 *
 * ⚠️ **失敗しても購入・認証を止めない。**
 * ここが返すのは「次にいつ試すか」だけで、利用者の操作は続行させる。
 */
export function applyFailure(
  link: CommonUserLink,
  kind: CommonUserFailureKind,
  reason: string,
  now: Date,
): CommonUserLink {
  const attemptCount = link.attemptCount + 1;

  // 相手が 4xx を返す場合、同じ内容で送り直しても結果は変わらない。
  // 叩き続けても復旧しないので、人手に回す。
  if (kind === 'permanent' || attemptCount >= MAX_LINK_ATTEMPTS) {
    return {
      ...link,
      status: 'ERROR',
      lastError: reason,
      attemptCount,
      nextAttemptAt: null,
    };
  }

  return {
    ...link,
    status: 'PENDING',
    lastError: reason,
    attemptCount,
    nextAttemptAt: new Date(now.getTime() + backoffMinutes(attemptCount) * 60_000),
  };
}

/**
 * Claim に使える状態か。
 *
 * Claim は受取先を確定させる操作なので、解決済み以外では通さない。
 * `CONFLICT` と `ERROR` も通さない。**曖昧なまま渡さない**ため。
 */
export function isUsableForClaim(link: CommonUserLink): boolean {
  return link.status === 'RESOLVED' && link.commonUserId !== null;
}
