/**
 * 同じ方が 2 つのアカウントを持っている可能性（実運営 指示書 P1-1）。
 *
 * 同じ人が別の認証手段（メールと外部サービスなど）で入ると、こちらには
 * 別人として見える。買った品が 2 つのアカウントに分かれ、片方でしか
 * 受け取れない——という問い合わせになる。
 *
 * ⚠️ **候補を出すだけ。統合はしない**（指示書 §11）。本人確認をしていない
 * 付け替えは、他人の持ち物を渡すことと同じである。**「たぶん同じ人」で
 * 品物を移す口を作らない。**
 *
 * ⚠️ **「候補」を「同一人物」と読ませない。** 画面の文言も型の名前も、
 * 確定していないことが伝わるようにする。読み違えたまま統合の判断をされると、
 * 取り返しがつかない。
 */

/** どこが一致したか。⚠️ 強い順に並べてある。 */
export const DUPLICATE_SIGNALS = [
  /**
   * 照合用のメール値が同じ。
   *
   * ⚠️ **同じ鍵で変換した値どうしの一致なので、元のアドレスも同じ。**
   * いちばん強い手がかりだが、それでも同一人物とは限らない
   * （共用のアドレス、引き継いだアドレス）。
   */
  'email_hash',
  /**
   * 共通顧客IDが同じ。
   *
   * ⚠️ **代理店システムが「同じ人」と判断した値。** こちらの判断ではない。
   * 相手が間違えていれば、こちらも間違える。
   */
  'common_user_id',
] as const;
export type DuplicateSignal = (typeof DUPLICATE_SIGNALS)[number];

export interface DuplicateCandidate {
  readonly accountId: string;
  readonly maskedEmail: string | null;
  readonly commonUserId: string | null;
  readonly status: 'active' | 'suspended';
  readonly orderCount: number;
  readonly entitlementCount: number;
  /** 一致した手がかり。⚠️ 2 つとも一致することもある。 */
  readonly signals: readonly DuplicateSignal[];
  readonly createdAt: Date;
}

/** 手がかりの強さ。⚠️ 数が多いほど強い、ではなく、種類で決まる。 */
const SIGNAL_WEIGHT: Readonly<Record<DuplicateSignal, number>> = {
  email_hash: 2,
  common_user_id: 1,
};

/**
 * 候補を強い順に並べる。
 *
 * ⚠️ **1 件に絞らない。** 「いちばん近いのはこれです」と 1 件だけ出すと、
 * それが正しいものとして扱われる。**判断するのは人**で、こちらは
 * 材料を並べるところまで。
 */
export function rankDuplicateCandidates(
  candidates: readonly DuplicateCandidate[],
): readonly DuplicateCandidate[] {
  return [...candidates].sort((a, b) => {
    const byWeight = weightOf(b.signals) - weightOf(a.signals);
    if (byWeight !== 0) {
      return byWeight;
    }
    // ⚠️ 同点は作られた順。並びが実行のたびに変わると、見比べができない。
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

function weightOf(signals: readonly DuplicateSignal[]): number {
  return signals.reduce((total, signal) => total + SIGNAL_WEIGHT[signal], 0);
}

/** 手がかりの言い換え。⚠️ 「同一人物」と書かない。 */
export const DUPLICATE_SIGNAL_LABELS: Readonly<Record<DuplicateSignal, string>> = {
  email_hash: 'ご連絡先が一致',
  common_user_id: '共通顧客IDが一致',
};
