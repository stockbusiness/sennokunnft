/**
 * 一覧の「続きを読む位置」。
 *
 * ⚠️ **件数飛ばし（OFFSET）にしない。** 一覧は新しい順に並ぶうえ、
 * 見ているあいだにも行が増える。件数で飛ばすと、増えたぶんだけ
 * 次のページの先頭が後ろへずれ、**見ていない行が飛ばされる**。
 * 「並び順の最後に見た値」を持てば、増えても飛ばされない。
 *
 * ⚠️ **時刻だけで飛ばさない。** 同じ時刻の行が複数あると、その並びの
 * 途中から続きを読むことになり、残りが飛ばされる。行IDまで含める。
 */
export interface ListCursor {
  readonly at: Date;
  readonly id: string;
}

/**
 * カーソルを文字列にする。
 *
 * ⚠️ **中身を秘密にする仕掛けではない。** 並び順の値をそのまま繋いだだけで、
 * 誰でも読める。読めても困らない値（時刻と行ID）しか入れていない。
 * 「読めないから安全」と誤解されないよう、暗号化も符号化もしない。
 */
export function encodeListCursor(cursor: ListCursor): string {
  return `${cursor.at.toISOString()}_${cursor.id}`;
}

/** 文字列からカーソルへ戻す。読めない値は `null`（先頭から読み直す）。 */
export function decodeListCursor(raw: string): ListCursor | null {
  const separator = raw.indexOf('_');
  if (separator <= 0) {
    return null;
  }
  const at = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || id === '') {
    return null;
  }
  return { at, id };
}
