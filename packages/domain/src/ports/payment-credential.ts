import type { IntegrationEnvironment } from '../integration/service';
import type { PaymentCredentialGeneration } from '../payment/credential';
import type { SealedSecret } from './integration';

/**
 * 決済資格情報の世代の保管庫（`UD-118`）。
 *
 * ⚠️ **削除の口を置かない。** 消すと、その世代で処理した決済の返金経路が
 * 消える。DB 側も `payments.credential_id` の `ON DELETE RESTRICT` で縛る。
 *
 * ⚠️ **平文を返す口と、画面向けの口を分ける。** 一覧や状態表示から
 * 復号が呼べる形にすると、いつか秘密が応答へ載る。
 */

export interface RegisterCredentialCommand {
  readonly provider: string;
  readonly environment: IntegrationEnvironment;
  readonly label: string | null;
  readonly apiVersion: string | null;
  readonly secretKey: SealedSecret;
  readonly webhookSecret: SealedSecret;
  readonly registeredByAccountId: string;
}

export interface RecordCredentialCheckCommand {
  readonly id: string;
  readonly succeeded: boolean;
  /** 成功したときだけ入る。⚠️ **秘密ではない。** */
  readonly accountRef: string | null;
  readonly checkedAt: Date;
}

export interface ActivateCredentialCommand {
  readonly id: string;
  /** 受付を降りる世代。1 本目なら `null`。 */
  readonly steppedDownId: string | null;
  readonly activatedByAccountId: string;
  readonly activatedAt: Date;
}

/**
 * 復号済みの資格情報。
 *
 * ⚠️ **この型を画面向けの経路へ持ち出さない。** 使ってよいのは、
 * 決済事業者へ送るアダプタと署名検証だけ。
 */
export interface OpenedPaymentCredential {
  readonly id: string;
  readonly generation: number;
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiVersion: string | null;
}

export interface PaymentCredentialRepository {
  /** 画面と判定が使う一覧。⚠️ 鍵を含まない。 */
  list(
    provider: string,
    environment: IntegrationEnvironment,
  ): Promise<readonly PaymentCredentialGeneration[]>;

  findById(id: string): Promise<PaymentCredentialGeneration | null>;

  register(command: RegisterCredentialCommand): Promise<PaymentCredentialGeneration>;

  recordCheck(command: RecordCredentialCheckCommand): Promise<PaymentCredentialGeneration | null>;

  /**
   * 世代を有効化し、旧世代の受付を降ろす。
   *
   * ⚠️ **1 トランザクションで行う。** 分けると、受付世代が 2 つある瞬間か
   * 0 の瞬間ができる。前者は入金先が不定になり、後者は販売が止まる。
   */
  activate(command: ActivateCredentialCommand): Promise<PaymentCredentialGeneration | null>;

  setAcceptsNewPayments(id: string, accepts: boolean): Promise<PaymentCredentialGeneration | null>;

  retire(id: string, retiredAt: Date): Promise<PaymentCredentialGeneration | null>;

  /** 知らせが届いた時刻を記録する。⚠️ 署名の中身は残さない。 */
  touchWebhookReceived(id: string, receivedAt: Date): Promise<void>;

  /**
   * 鍵を復号して返す。
   *
   * ⚠️ **呼んでよいのは送信アダプタと署名検証だけ。** 画面向けの経路から
   * 呼ばれていないことを、読む人が確かめられるよう口を分けてある。
   */
  open(id: string): Promise<OpenedPaymentCredential | null>;

  /**
   * 署名検証で試す世代を、鍵つきで返す（新しい順・上限つき）。
   *
   * ⚠️ **`retired` も含める。** 切り替え後も旧アカウントの知らせは届く。
   */
  openForVerification(
    provider: string,
    environment: IntegrationEnvironment,
    limit: number,
  ): Promise<readonly OpenedPaymentCredential[]>;
}
