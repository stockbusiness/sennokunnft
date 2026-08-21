import { NextResponse } from 'next/server';
import { fetchSalesReportCsv } from '../../../../src/admin-client';

/**
 * 売上レポートの CSV を受け取る（`UD-123` の一部）。
 *
 * ⚠️ **ブラウザから API を直接叩かせない。** 運営用の資格情報はサーバー側に
 * しか無い。ここが仲立ちする。
 *
 * ⚠️ **静的化させない。** 中身は毎日変わる。
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('granularity');
  // ⚠️ 受け取った値をそのまま API へ渡さない。ここで 2 つに閉じる。
  const granularity = raw === 'monthly' ? 'monthly' : 'daily';
  const result = await fetchSalesReportCsv(granularity);

  if (!result.ok) {
    /*
      ⚠️ **失敗を CSV として返さない。** 表計算で開いたときに、エラーの
         文言が数字に見えてしまう。状態コードで返す。
    */
    const status =
      result.reason === 'unauthorized' ? 403 : result.reason === 'rejected' ? 400 : 502;
    return NextResponse.json({ error: { code: 'SALES_REPORT_CSV_UNAVAILABLE' } }, { status });
  }

  /*
    ⚠️ **BOM は API が付けている。** ここで足すと二重になり、
       1 列目の見出しが読めなくなる。
  */
  return new NextResponse(result.data.body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="sales-report-${granularity}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
