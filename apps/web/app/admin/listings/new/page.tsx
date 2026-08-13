import { PageHeader } from '@sengoku/ui';

export default function NewListingPage() {
  return (
    <>
      <PageHeader title="販売を新しく作る" />
      <p>現在、販売の作成は API から行います。作品を公開してから作成してください。</p>
      <pre className="sengoku-code">
        {`POST /api/v1/admin/listings
Authorization: Bearer <運営のトークン>
Content-Type: application/json

{
  "artworkId": "<作品のID>",
  "priceAmount": 12000,
  "priceCurrency": "JPY"
}`}
      </pre>
      <p>
        作成後、<code>POST /api/v1/admin/listings/:id/activate</code> で販売を開始します。
      </p>
      <p>
        <a href="/admin/listings">一覧へ戻る</a>
      </p>
    </>
  );
}
