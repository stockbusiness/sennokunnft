import type { SealedSecret } from '@sengoku/domain';
import type { AeadSecretBox } from './aead-secret-box';

/**
 * 知らせの受け口の URL を包む・解く（`UD-1102` の一部）。
 *
 * ⚠️ **`SecretCipherPort` と分けてある。** 結び付ける相手を「環境」に
 * している——**staging の行から本番の受け口の暗号文を貼り替えても解けない**
 * ようにするため。貼り替えられると、本番の異常が試験用の受け口へ流れる
 * （＝本番の担当者が気づけない）。
 *
 * ⚠️ **暗号の中身は使い回す。** 方式を 2 つ持つと、鍵の交換のときに
 * 片方だけ古いままになる。
 */
export class AlertWebhookSecretBox {
  constructor(private readonly box: AeadSecretBox) {}

  seal(plaintext: string, environment: string): SealedSecret {
    return this.box.sealWithAad(plaintext, boundTo(environment));
  }

  /** 鍵が違う・改ざん・別の環境の行なら `null`。⚠️ 理由は返さない。 */
  open(sealed: SealedSecret, environment: string): string | null {
    return this.box.openWithAad(sealed, boundTo(environment));
  }
}

function boundTo(environment: string): string {
  return `operations_alert_webhook:${environment}`;
}
