import { PageHeader } from '@sengoku/ui';

/**
 * 作品の新規登録。
 *
 * 現時点では手順の案内のみ。フォームからの送信は次段階で実装する。
 * 中途半端に「押せるが何も起きないボタン」を置かないのは、
 * 動くと思って操作した運営が、失敗に気付けないため。
 */
export default function NewArtworkPage() {
  return (
    <>
      <PageHeader title="作品を新しく登録する" />
      <p>現在、作品の登録は API から行います。</p>
      <pre className="sengoku-code">
        {`POST /api/v1/admin/artworks
Authorization: Bearer <運営のトークン>
Content-Type: application/json

{
  "slug": "sengoku-scroll-01",
  "title": "戦国絵巻 其の一",
  "description": "作品の説明",
  "maxSupply": 100
}`}
      </pre>
      <p>
        登録後、画像を <code>POST /api/v1/admin/artworks/:id/image</code>{' '}
        で登録すると公開できるようになります。
      </p>
      <p>
        <a href="/admin/artworks">一覧へ戻る</a>
      </p>
    </>
  );
}
