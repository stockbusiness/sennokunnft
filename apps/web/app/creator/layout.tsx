/**
 * 出品者向けの画面。
 *
 * ⚠️ **静的化させない。** 出品の状態は operation のたびに変わる。
 * ビルド時の値で固められると、登録したのに一覧へ出ない状態になる。
 *
 * ⚠️ **検索に出さない。** 出品の作業画面であって、読み物ではない。
 */
export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

export default function CreatorLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
