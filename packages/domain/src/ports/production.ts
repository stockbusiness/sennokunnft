import type { AttestationFact, ProductionReadinessFacts } from '../production/readiness';
import type { AttestationKind, RecordAttestationCommand } from '../production/attestation';

/**
 * 本番販売ガードが必要とする事実を集める口（P0-7）。
 *
 * ⚠️ **判定を持たせない。** ここは集めるだけで、満たしているかどうかは
 * ドメインが決める。集める側が判定すると、しきい値を変えるのに
 * SQL を触ることになる。
 *
 * ⚠️ **秘密を返さない。** 鍵の値も署名鍵も、有無と確認の結果しか要らない。
 */
export interface ProductionReadinessPort {
  /**
   * 10 条件の材料を集める。
   *
   * ⚠️ **`environment` を要求から受け取らない。** プロセスの環境を渡す。
   * 要求から選べると、staging の状態で本番の判定を通せてしまう。
   */
  facts(now: Date): Promise<ProductionReadinessFacts>;
}

/**
 * 人が残す証跡の口。
 *
 * ⚠️ **更新も削除も無い。** 追記と、直近 1 件を読むことだけ。
 * 口が無ければ、あとから足す人が「消せるようにしよう」と考える前に、
 * ここを見て理由に行き当たる。
 */
export interface AttestationPort {
  record(command: RecordAttestationCommand, now: Date): Promise<string>;
  /** その種別の直近 1 件。⚠️ 「どこかに成功がある」ではなく「最新が成功か」。 */
  latest(kind: AttestationKind): Promise<AttestationFact | null>;
  /** 一覧（新しい順）。⚠️ 押した記録は隠さない。 */
  list(limit: number): Promise<readonly AttestationRecord[]>;
}

/** 画面に出す 1 件。⚠️ 秘密を含めない。 */
export interface AttestationRecord {
  readonly id: string;
  readonly kind: AttestationKind;
  readonly succeeded: boolean;
  readonly credentialId: string;
  readonly attestedByAccountId: string;
  readonly note: string | null;
  readonly attestedAt: Date;
}
