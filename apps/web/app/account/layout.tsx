import { ACCOUNT_COPY } from '../../src/account-copy';

/**
 * 買った方のマイページ（P0-3）。
 *
 * ⚠️ **静的化させない。** ご注文とお受け取りの状態は刻々と変わる。
 * ビルド時の値で固められると、「お支払いが済んでいません」と出続ける。
 *
 * ⚠️ **検索に出さない。** ご自分の買い物の記録であって、読み物ではない。
 */
export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/*
        ⚠️ **並びを変えない。** よく使う順に置いてある。スマートフォンでは
           折り返して 2 行になるので、左上がいちばん押しやすい。
      */}
      <nav className="sengoku-admin__nav" aria-label={ACCOUNT_COPY.homeTitle}>
        <a href="/account">{ACCOUNT_COPY.homeTitle}</a>
        <a href="/account/orders">{ACCOUNT_COPY.toOrders}</a>
        <a href="/account/collectibles">{ACCOUNT_COPY.toCollectibles}</a>
        <a href="/account/settings">{ACCOUNT_COPY.toSettings}</a>
      </nav>
      {children}
    </>
  );
}
