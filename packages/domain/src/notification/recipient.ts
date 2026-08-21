/**
 * 宛先の扱い（`UD-503` を保ったまま知らせを送るための決まりごと）。
 *
 * ⚠️ **本システムは購入者のメールアドレスを平文で持たない。** 宛先は
 * 送信の瞬間に認証基盤から取り出し、送り終えたら捨てる。DB へ残すのは
 * **マスクした表記と照合用のハッシュだけ**（決定 2026-08-20）。
 *
 * ⚠️ **マスクした表記から元へ戻せると考えない。** これは運営が
 * 「どの方へ送ったか」を目で確かめるためのもので、再送の宛先には使えない。
 * 再送するときは、そのつど認証基盤から取り直す。
 */

/**
 * 宛先を伏せた表記にする。
 *
 * `tanaka@example.jp` → `t*****@e******.jp`
 *
 * ⚠️ **先頭 1 文字と末尾の TLD だけ残す。** 残しすぎると、
 * 送信履歴の一覧がそのままアドレス帳になる。残さなすぎると、
 * 問い合わせを受けた運営が本人の行を見つけられない。
 *
 * ⚠️ **アドレスとして妥当かをここで判定しない。** 判定は送信側の仕事で、
 * ここは「見せてよい形にする」だけ。妥当でない値が来ても落とさず、
 * 伏せたうえで返す——落とすと、伏せる処理そのものを飛ばす実装を誘う。
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    // `@` が無い、または端にある。⚠️ 中身を見せずに伏せる。
    return maskRun(trimmed);
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || dot === domain.length - 1) {
    return `${maskRun(local)}@${maskRun(domain)}`;
  }
  const host = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  return `${maskRun(local)}@${maskRun(host)}.${tld}`;
}

/** 先頭 1 文字だけ残し、残りを `*` にする。⚠️ 長さは元のまま残す。 */
function maskRun(value: string): string {
  if (value.length === 0) {
    return '';
  }
  if (value.length === 1) {
    return '*';
  }
  return `${value[0]!}${'*'.repeat(value.length - 1)}`;
}

/**
 * 宛先を解決した結果。
 *
 * ⚠️ **「取れなかった」と「送らないと決めた」を分ける。** 前者は障害で、
 * 後者は仕様。同じ値で返すと、監視が両方に反応するか、両方を見逃す。
 */
export type RecipientResolution =
  | { readonly kind: 'resolved'; readonly email: string }
  /** 認証基盤に問い合わせたが、その人のアドレスが分からなかった。 */
  | { readonly kind: 'unknown' }
  /** 認証基盤へ問い合わせられなかった。⚠️ **時間をおけば直りうる。** */
  | { readonly kind: 'unavailable' };
