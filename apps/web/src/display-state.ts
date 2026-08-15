/**
 * 表示状態を、利用者向けの言い回しに直す。
 *
 * ⚠️ **判定はここでしない。** どの状態かはサーバーが決めて `displayState`
 * として渡してくる。画面側で条件を組み直すと、表示と購入可否が食い違い、
 * 「買えると書いてあるのに買えない」が起きる。ここは言葉に直すだけ。
 *
 * 一覧と詳細で同じ関数を使う。片方だけ言い回しを変えると、
 * 一覧と詳細で違うことが書いてある状態になる。
 */
const LABELS: Record<string, string> = {
  on_sale: '販売中',
  scheduled: '販売開始前です',
  ended: '販売は終了しました',
  sold_out: '完売しました',
  not_available: 'ただいま販売しておりません',
};

/** 未知の状態でも画面を落とさず、当たり障りのない言い方にする。 */
export function displayStateLabel(displayState: string): string {
  return LABELS[displayState] ?? 'ただいまお求めいただけません';
}
