import type { ReactNode } from 'react';

/**
 * 管理画面の枠。
 *
 * ⚠️ **画面を隠すことは保護ではない。**
 * ここに認可判定を置いていないのは、置いても意味がないから。
 * 管理APIは直接叩けるので、保護はサーバー側のガードで行う。
 * この画面は「権限のある人が操作するための入口」に過ぎない。
 */

/**
 * ⚠️ **管理画面を静的化させない。**
 *
 * 一覧は資格情報が無いと API を呼ぶ前に打ち切る。すると Next からは
 * 「動的な処理が無いページ」に見え、**ビルド時の HTML が焼き付く**。
 * 焼き付いた画面は、あとから資格情報を入れても二度と更新されない。
 *
 * つまり管理画面が生きているかどうかが、**ビルドの瞬間に環境変数が
 * 在ったかどうか**で決まってしまう。落ちも警告も出ず、運営からは
 * 「作品が 0 件」あるいは「資格情報がありません」に見えるだけで、
 * 原因がビルド順にあるとは気づけない。
 *
 * 個々のページではなくここへ置くのは、あとから管理画面を足した人が
 * 同じ穴を踏まないようにするため。区画ごと動的にしておく。
 */
export const dynamic = 'force-dynamic';

interface MenuItem {
  readonly href: string;
  readonly label: string;
}

interface MenuGroup {
  /** ⚠️ `null` は見出し無し（先頭の 1 件だけ）。 */
  readonly heading: string | null;
  readonly items: readonly MenuItem[];
}

/**
 * 管理メニュー（2026-08-22 に横並びから side へ変更）。
 *
 * ⚠️ **束ねずに 24 件を平らに並べない。** 以前は横並びで折り返していて、
 * 画面の上 3 行が全部リンクだった。**探す場所が無い**ので、目的の項目を
 * 見つけるのに毎回すべて読むことになる。
 *
 * ⚠️ **束ねる軸は「運営が何をしたいか」。** 実装の都合（どのテーブルか、
 * どの権限か）で束ねると、運営から見て隣り合うべきものが離れる。
 *
 * ⚠️ **権限で出し分けない。** 開けない項目にも印を出さない。
 * 隠すことは保護ではないうえ、「見えないから無い」と誤解される。
 * 押せば「権限がありません」と出る——それが正しい伝え方である。
 */
const MENU: readonly MenuGroup[] = [
  {
    /*
      ⚠️ **いちばん上は運営の状況。** 朝いちばんに開く画面を束の中へ
         入れると、探さないと辿り着けない。手当てが要ることは、
         探さずに目に入るところに無ければ気づかれない。
    */
    heading: null,
    items: [{ href: '/admin', label: '運営の状況' }],
  },
  {
    heading: '売る',
    items: [
      { href: '/admin/artworks', label: '作品' },
      { href: '/admin/listings', label: '販売' },
      { href: '/admin/orders', label: '注文' },
      { href: '/admin/sales', label: '売上' },
    ],
  },
  {
    heading: '人',
    items: [
      { href: '/admin/customers', label: 'お客さま' },
      // 運営が数字と作家さまを見る（`UD-123` / `UD-124` の一部）。
      { href: '/admin/creators', label: '作家さま' },
      { href: '/admin/staff', label: 'スタッフ' },
    ],
  },
  {
    heading: 'お渡し',
    items: [
      { href: '/admin/entitlements', label: '受取権' },
      { href: '/admin/wallet-deliveries', label: 'お届け' },
      { href: '/admin/notifications', label: '知らせ' },
    ],
  },
  {
    /*
      ⚠️ **返金まわりを 1 か所に集める。** 申し出・争い・精算・支払いは、
         運営から見れば「お金を返す／渡す」の一続きである。実装は別々でも、
         探す場所は 1 つでよい。
    */
    heading: 'お金',
    items: [
      { href: '/admin/refund-requests', label: '返金のお申し出' },
      { href: '/admin/disputes', label: 'カード会社との争い' },
      { href: '/admin/settlement-settings', label: '返金と精算' },
      { href: '/admin/payouts', label: 'お支払い' },
    ],
  },
  {
    heading: '設定',
    items: [
      { href: '/admin/integrations', label: '外部サービス' },
      { href: '/admin/payment-credentials', label: '決済の鍵' },
      { href: '/admin/legal', label: '規約・法務' },
      { href: '/admin/operations-alerts', label: '異常のお知らせ' },
    ],
  },
  {
    heading: '点検',
    items: [
      { href: '/admin/consistency', label: '記録の食い違い' },
      { href: '/admin/production', label: '本番販売の準備' },
      { href: '/admin/audit-logs', label: '操作の記録' },
    ],
  },
  {
    heading: null,
    items: [{ href: '/', label: '公開ページ' }],
  },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sengoku-admin">
      {/*
        ⚠️ **たたむ仕掛けを入れていない。** 折りたたみは JavaScript か
           `<details>` が要るが、`<details>` は画面幅で開閉の既定を
           変えられない（属性は媒体問い合わせで切り替わらない）。
           狭い画面で開いたまま、広い画面で閉じたままのどちらかになる。
           束ねて 2 列にすれば、たたまなくても本文まで届く。
      */}
      <nav className="sengoku-admin__nav" aria-label="管理メニュー">
        {MENU.map((group) => (
          <div className="sengoku-admin__group" key={group.heading ?? group.items[0]?.href}>
            {group.heading === null ? null : (
              <h2 className="sengoku-admin__group-heading">{group.heading}</h2>
            )}
            <ul className="sengoku-admin__menu">
              {group.items.map((item) => (
                <li key={item.href}>
                  <a href={item.href}>{item.label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {/*
        ⚠️ **本文を包んでおく。** 包まないと、格子の子が本文の要素の数だけ
           増え、2 列目以降が崩れる。
      */}
      <div className="sengoku-admin__body">{children}</div>
    </div>
  );
}
