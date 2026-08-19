import type { RandomPort } from '../ports/index';

/**
 * 注文番号（指示書 §4.1・§5.1）。
 *
 * ⚠️ **連番にしない。** 連番だと、他人の注文番号を推測できるうえ、
 * 「今日までに何件売れたか」が外から数えられる。
 *
 * ⚠️ **内部IDの代わりにしない。** これは人が読み上げ、問い合わせで使う番号。
 * 参照の正は `orders.id`（UUID）のまま。
 *
 * 形は `SNK-YYYYMMDD-XXXXXXXX`。日付を入れてあるのは、
 * 問い合わせのときに「いつごろの注文か」が番号だけで分かるようにするため。
 */

/**
 * 番号に使う文字。
 *
 * ⚠️ **読み違えやすい字を外してある**（`0/O`、`1/I/L`）。
 * 電話で伝える場面がある。伝え間違いは、間違った注文を触ることに繋がる。
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const RANDOM_LENGTH = 8;

export function generateOrderNumber(now: Date, random: RandomPort): string {
  const yyyymmdd = [
    now.getUTCFullYear().toString().padStart(4, '0'),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0'),
  ].join('');

  /*
    ⚠️ **`Math.random()` を使わない。** 推測されると、他人の注文番号を
       当てられる。乱数は CSPRNG をポート越しに受け取る。
  */
  const bytes = random.bytes(RANDOM_LENGTH);
  let suffix = '';
  for (const byte of bytes) {
    suffix += ALPHABET[byte % ALPHABET.length];
  }

  return `SNK-${yyyymmdd}-${suffix}`;
}

/** 番号の形。画面や検索で軽く弾くために使う。 */
export const ORDER_NUMBER_PATTERN = /^SNK-\d{8}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

export function isOrderNumber(value: string): boolean {
  return ORDER_NUMBER_PATTERN.test(value);
}
