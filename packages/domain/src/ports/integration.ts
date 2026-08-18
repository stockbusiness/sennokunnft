import type { IntegrationEnvironment, IntegrationService } from '../integration/service';
import type { IntegrationSecret, SecretPurpose } from '../integration/secret';
import type { IntegrationSettings } from '../integration/settings';

/**
 * 秘密情報の暗号化（指示書 §6.2）。
 *
 * ⚠️ **独自方式を作らない。** 実装は実績のある認証付き暗号を使う。
 * ここがポートになっているのは、鍵の取り回しをドメインから隠すためで、
 * 方式を差し替えやすくするためではない。
 *
 * ⚠️ **復号を「取得」と同じ形にしない。** 復号できる口が読み取り系に
 * 見えると、いつか一覧や詳細から呼ばれる。呼ぶ先を送信アダプタだけに
 * 絞れるよう、口を分けてある。
 */
export interface SealedSecret {
  /** 暗号文（base64）。 */
  readonly ciphertext: string;
  /** 使い捨ての値（base64）。**同じ鍵で使い回さない。** */
  readonly nonce: string;
  /** 改ざん検知の印（base64）。 */
  readonly authTag: string;
  /** どの暗号鍵で包んだか。鍵の交換に備えて必ず持つ。 */
  readonly keyVersion: string;
  /** 画面での見分け用。**平文の一部であることを忘れないこと。** */
  readonly lastFour: string;
}

export interface SecretScope {
  readonly service: IntegrationService;
  readonly environment: IntegrationEnvironment;
}

export interface SecretCipherPort {
  /**
   * 平文を包む。
   *
   * ⚠️ **`scope` を結び付け情報として使うこと。** これにより、
   * staging の暗号文を production の行へ貼り替えても復号が失敗する。
   * 行の入れ替えという、DB を触れる人にだけできる攻撃を塞ぐ。
   */
  seal(plaintext: string, scope: SecretScope): SealedSecret;
  /**
   * 包みを解く。鍵が違う・改ざんされている・`scope` が違うときは `null`。
   *
   * ⚠️ **失敗の理由を返さない。** 「鍵が違う」と「改ざんされている」を
   * 区別して返すと、総当たりの手掛かりになる。
   */
  open(sealed: SealedSecret, scope: SecretScope): string | null;
}

export interface ConnectionCheckRecord {
  readonly id: string;
  readonly service: IntegrationService;
  readonly environment: IntegrationEnvironment;
  readonly succeeded: boolean;
  readonly failureCode: string | null;
  readonly durationMs: number;
  readonly secretId: string | null;
  readonly executedByAccountId: string | null;
  readonly correlationId: string | null;
  readonly executedAt: Date;
}

/**
 * 外部連携の保管庫。
 *
 * ⚠️ **平文を返す口をここに置かない。** 一覧や詳細から呼べる形にすると、
 * いつか画面へ流れる。復号は `revealForAdapter` の 1 本だけで、
 * 名前で用途を縛ってある。
 */
export interface IntegrationRepository {
  findSettings(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationSettings | null>;
  listSettings(): Promise<readonly IntegrationSettings[]>;
  /**
   * 設定を書き戻す。**読んだときの `rowVersion` と一致しなければ書かない。**
   *
   * ⚠️ 一致しなければ `null` を返す。古い画面からの上書きを弾くため
   * （指示書 §12）。呼び出し側は競合として扱うこと。
   */
  saveSettings(
    settings: IntegrationSettings,
    expectedRowVersion: number,
    updatedByAccountId: string,
  ): Promise<IntegrationSettings | null>;

  /** 状態を問わず、その用途の資格情報を新しい順に返す。**平文は含まない。** */
  listSecrets(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<readonly IntegrationSecret[]>;
  findSecretById(id: string): Promise<IntegrationSecret | null>;
  findSecretByStatus(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    purpose: SecretPurpose,
    status: 'pending' | 'active',
  ): Promise<IntegrationSecret | null>;
  /**
   * 資格情報を包んで保存する。同じ用途に待機中があれば `null`。
   *
   * ⚠️ 平文を受け取るのはここだけ。**保存後は捨てる。**
   */
  createSecret(input: {
    readonly id: string;
    readonly service: IntegrationService;
    readonly environment: IntegrationEnvironment;
    readonly purpose: SecretPurpose;
    readonly plaintext: string;
    readonly createdByAccountId: string;
  }): Promise<IntegrationSecret | null>;
  /**
   * 新しいものを有効にし、古いものを退役させる。**1 トランザクションで書く。**
   *
   * ⚠️ 分けて書くと、途中で落ちたときに有効な資格情報が 2 件、
   * あるいは 0 件になる。どちらも送信が壊れる。
   */
  activateSecret(activated: IntegrationSecret, retired: IntegrationSecret | null): Promise<void>;
  updateSecret(secret: IntegrationSecret): Promise<IntegrationSecret>;

  /**
   * 送信アダプタのためだけに平文を取り出す。
   *
   * ⚠️ **画面・API の応答へ渡さない。** この名前は用途を縛るためにある。
   * 一覧や詳細から呼びたくなったら、それは設計を間違えている合図。
   */
  revealForAdapter(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    purpose: SecretPurpose,
  ): Promise<string | null>;

  recordConnectionCheck(record: ConnectionCheckRecord): Promise<void>;
  /** 直近の接続テスト。有効期間の判定に使う。 */
  findLatestConnectionCheck(
    service: IntegrationService,
    environment: IntegrationEnvironment,
  ): Promise<ConnectionCheckRecord | null>;
  listConnectionChecks(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    limit: number,
  ): Promise<readonly ConnectionCheckRecord[]>;
  /**
   * 接続テストの記録を無効化する（接続先を変えたとき）。
   *
   * ⚠️ 消すのではなく、以後の判定で使わないようにする。
   * 消すと「いつ何を試したか」が辿れなくなる。
   */
  invalidateConnectionChecks(
    service: IntegrationService,
    environment: IntegrationEnvironment,
    now: Date,
  ): Promise<void>;
}
