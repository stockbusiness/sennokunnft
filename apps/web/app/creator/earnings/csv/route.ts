import { NextResponse } from 'next/server';
import { fetchMyEarningsCsv } from '../../../../src/creator-client';

/**
 * 明細の CSV を受け取る。
 *
 * ⚠️ **ブラウザから API を直接叩かせない。** 資格情報はサーバー側にしか
 * 無い。ここが仲立ちする。
 *
 * ⚠️ **誰の分かを問い合わせで受け取らない。** アカウントは API がトークン
 * から決める。`periodKey` だけを通す（形は API 側が検証する）。
 *
 * ⚠️ **静的化させない。** 締めのたびに中身が変わる。
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const periodKey = new URL(request.url).searchParams.get('periodKey');
  const result = await fetchMyEarningsCsv(periodKey ?? undefined);

  if (!result.ok) {
    /*
      ⚠️ **失敗を CSV として返さない。** 表計算で開いたときに、
         エラーの文言が明細に見えてしまう。状態コードで返す。
    */
    const status =
      result.reason === 'unauthorized' ? 403 : result.reason === 'rejected' ? 400 : 502;
    return NextResponse.json({ error: { code: 'EARNINGS_CSV_UNAVAILABLE' } }, { status });
  }

  /*
    ⚠️ **BOM は API が付けている。** ここで足すと二重になり、
       1 列目の見出しが読めなくなる。
  */
  return new NextResponse(result.data.body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="earnings.csv"',
      // ⚠️ 売上は本人だけのもの。中間で持たせない。
      'cache-control': 'no-store',
    },
  });
}
