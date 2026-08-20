import { permanentRedirect } from 'next/navigation';

/**
 * 旧いご注文のURL。
 *
 * ⚠️ **同じ画面を 2 つ持たない。** 中身はマイページ側（`/account/orders/[id]`）
 * に 1 つだけ置き、ここは送るだけにする。2 つ置くと、片方だけ直したときに
 * 見え方が食い違う。
 *
 * ⚠️ **消さない。** お支払いの控えやメールに、この形のURLが残っている。
 */
export default async function LegacyOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  permanentRedirect(`/account/orders/${id}`);
}
