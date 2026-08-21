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

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sengoku-admin">
      <nav className="sengoku-admin__nav" aria-label="管理メニュー">
        {/*
          ⚠️ **いちばん左は運営の状況。** 朝いちばんに開く画面を端に置くと、
             探さないと辿り着けない。手当てが要ることは、探さずに目に入る
             ところに無ければ気づかれない。
        */}
        <a href="/admin">運営の状況</a>
        <a href="/admin/artworks">作品</a>
        <a href="/admin/listings">販売</a>
        <a href="/admin/orders">注文</a>
        <a href="/admin/customers">お客さま</a>
        {/* 運営が数字と作家さまを見る（`UD-123` / `UD-124` の一部）。 */}
        <a href="/admin/creators">作家さま</a>
        <a href="/admin/sales">売上</a>
        {/*
          ⚠️ 出しっぱなしでよい。開けるのはオーナーだけで、
             ほかの人には「権限がありません」と出る。隠すことは保護ではない。
        */}
        <a href="/admin/staff">スタッフ</a>
        <a href="/admin/entitlements">受取権</a>
        <a href="/admin/wallet-deliveries">お届け</a>
        <a href="/admin/notifications">知らせ</a>
        <a href="/admin/integrations">外部サービス</a>
        <a href="/admin/payment-credentials">決済の鍵</a>
        <a href="/admin/settlement-settings">返金と精算</a>
        <a href="/admin/payouts">お支払い</a>
        <a href="/admin/legal">規約・法務</a>
        <a href="/admin/consistency">記録の食い違い</a>
        {/*
          ⚠️ **出しっぱなしでよい。** 記録を残せるのはオーナーだけで、
             ほかの人には「権限がありません」と出る。隠すことは保護ではない。
        */}
        <a href="/admin/production">本番販売の準備</a>
        <a href="/admin/audit-logs">操作の記録</a>
        <a href="/">公開ページ</a>
      </nav>
      {children}
    </div>
  );
}
