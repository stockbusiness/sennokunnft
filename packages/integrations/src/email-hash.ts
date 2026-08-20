import { createHmac } from 'node:crypto';
import type { EmailHashPort } from '@sengoku/domain';

/**
 * 照合用のメール値を作るアダプタ（`UD-121`）。
 *
 * ⚠️ **平文は戻り値にも例外にもログにも出さない。** ここへ渡ってくるのは
 * 問い合わせで聞き取ったアドレスそのもので、本システムが保持しないと
 * 決めた値（`UD-503`）である。通り道になるだけで、残してはいけない。
 */
export class HmacEmailHasher implements EmailHashPort {
  /**
   * @param pepper 照合用の鍵。**無い配備では `null`** を渡す。
   *   ⚠️ 既定値を持たせない。既定の鍵は鍵が無いのと同じで、
   *   その値を知る全員が任意のアドレスの一致を確かめられる。
   */
  constructor(private readonly pepper: string | null) {}

  hash(email: string): string | null {
    if (this.pepper === null || this.pepper.length === 0) {
      // ⚠️ 素のハッシュへ落とさない。理由は `EmailHashPort` の注記を参照。
      return null;
    }
    const normalized = normalizeEmail(email);
    if (normalized === null) {
      return null;
    }
    return createHmac('sha256', this.pepper).update(normalized, 'utf8').digest('hex');
  }
}

/**
 * 照合の前にそろえる形。
 *
 * ⚠️ **ドメイン部分の大文字小文字だけを吸収する。** 送り手側の慣習
 * （`.` を無視する・`+` 以降を捨てる等）は**真似しない**。あれは特定の
 * 事業者の運用であって規格ではなく、他所では `a.b@` と `ab@` が
 * **別人**である。まとめた瞬間に、他人の注文が同じ人として並ぶ。
 *
 * ⚠️ ローカル部（`@` の手前）は規格上、大文字小文字を区別しうる。
 * それでも小文字へそろえているのは、問い合わせで聞き取った文字を
 * そのまま打ち込む運用で、控えの大文字小文字まで一致させるのは
 * 現実的でないため。**この判断でごく一部の一致漏れが起きうる**ことを
 * 承知のうえで、照合できないより一致させる側に倒している。
 */
export function normalizeEmail(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) {
    return null;
  }
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    return null;
  }
  return trimmed.toLowerCase();
}
