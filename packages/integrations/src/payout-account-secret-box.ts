import type { PayoutAccountCipherPort, SealedSecret } from '@sengoku/domain';
import type { AeadSecretBox } from './aead-secret-box';

/**
 * お振込先の口座番号を包む・解く（P1-3）。
 *
 * ⚠️ **結び付ける相手は作家さまのアカウントID。** 塞ぎたいのは
 * **別の作家さまの行へ暗号文を貼り替えて支払先を差し替えること**である。
 * サービスと環境で結び付けても、この攻撃は防げない。
 *
 * ⚠️ **暗号の中身は `AeadSecretBox` を使い回す。** 方式を 2 つ持つと、
 * 鍵の交換のときに片方だけ古いままになる。
 */
export class PayoutAccountSecretBox implements PayoutAccountCipherPort {
  constructor(private readonly box: AeadSecretBox) {}

  seal(plaintext: string, accountId: string): SealedSecret {
    return this.box.sealWithAad(plaintext, boundTo(accountId));
  }

  open(sealed: SealedSecret, accountId: string): string | null {
    return this.box.openWithAad(sealed, boundTo(accountId));
  }
}

/**
 * 結び付け情報。
 *
 * ⚠️ **接頭辞を付ける。** 付けないと、たまたま同じ形の別の識別子と
 * ぶつかったときに、用途をまたいで復号できてしまう。
 */
function boundTo(accountId: string): string {
  return `payout_account:${accountId}`;
}
