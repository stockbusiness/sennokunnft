# API_DESIGN.md — API設計

記法は [README.md](./README.md) に従う。

✅ **事実:** Phase 2 時点で実装済みのエンドポイントは、ヘルスチェック・公開カタログ・管理カタログ。
注文・決済・受取（Claim）は Phase 3 以降の契約定義であり、まだ実装していない。

---

## 1. 方針

🟡 **仮決定:**

| 項目           | 決定                                                                                | 根拠                                                                      |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| スタイル       | REST（JSON）                                                                        | 単純で、Webhook・外部連携との相性がよい。GraphQL は運用コストに見合わない |
| バージョニング | URL パス `/api/v1/...`                                                              | 外部システムから参照されるため、破壊的変更を明示的に切り替えられる        |
| 命名           | リソースは複数形・ケバブケース、フィールドは `camelCase`                            | TypeScript との整合                                                       |
| 日時           | ISO 8601（UTC、`Z` 終端）                                                           |                                                                           |
| 金額           | `{ "amount": 12000, "currency": "JPY" }`（`amount` は整数・最小通貨単位）           | ✅ 浮動小数点禁止                                                         |
| ページング     | カーソル方式（`cursor` + `limit`）                                                  | 件数増加時にオフセットずれを起こさない                                    |
| 検証           | すべて zod スキーマでサーバー側検証（`packages/validation` / `packages/contracts`） | ✅ 指示                                                                   |

---

## 2. エラーレスポンス規約

✅ **事実:** すべてのエラーは次の形式で返す。

```json
{
  "error": {
    "code": "INSUFFICIENT_SUPPLY",
    "message": "在庫が不足しています",
    "details": [{ "field": "quantity", "issue": "exceeds_available" }],
    "requestId": "01J8Z7..."
  }
}
```

- `code` は機械可読な安定した文字列。**HTTPステータスだけに意味を持たせない**。
- `message` は利用者向け。**内部実装の詳細・スタックトレース・SQLを含めない**。
- `requestId` は相関IDで、ログと突き合わせられる。

### 2.1 ドメインエラー → HTTP マッピング

| ドメインエラー               | HTTP | 備考                                               |
| ---------------------------- | ---- | -------------------------------------------------- |
| （バリデーション失敗）       | 400  | `VALIDATION_ERROR`                                 |
| （未認証）                   | 401  | `UNAUTHENTICATED`                                  |
| （権限不足）                 | 403  | `FORBIDDEN`                                        |
| `ARTWORK_NOT_AVAILABLE`      | 404  | 存在秘匿のため 403 ではなく 404                    |
| `LISTING_NOT_ACTIVE`         | 409  |                                                    |
| `INSUFFICIENT_SUPPLY`        | 409  |                                                    |
| `INVALID_QUANTITY`           | 400  |                                                    |
| `ORDER_NOT_PENDING`          | 409  |                                                    |
| `ENTITLEMENT_NOT_CLAIMABLE`  | 409  |                                                    |
| `ENTITLEMENT_OWNER_MISMATCH` | 403  |                                                    |
| `CLAIM_TOKEN_INVALID`        | 404  | **403 にしない**（トークンの存在有無を漏らさない） |
| `MINT_ALREADY_EXISTS`        | 409  |                                                    |
| `IDEMPOTENCY_CONFLICT`       | 409  |                                                    |
| `IDEMPOTENCY_IN_PROGRESS`    | 409  | 同じ操作を実行中。二重実行を避けるため待たせる     |
| （レート制限）               | 429  | `RATE_LIMITED`                                     |
| （想定外）                   | 500  | `INTERNAL_ERROR`。詳細はログのみ                   |

🟡 **仮決定:** `CLAIM_TOKEN_INVALID` を 404 にするのは、
「有効なトークンが存在するか」を攻撃者に教えないため（列挙攻撃対策）。

---

## 3. 冪等性

🟡 **仮決定:** 状態を変える POST / PATCH は `Idempotency-Key` ヘッダを受け付ける。

Phase 2 のカタログ操作では**任意**にしてある。作り直しがきく操作なので、
必須にして運用を硬くする利点が小さい。
一方、取り返しのつかない**注文（Phase 3）では必須**にする。

✅ **事実:** 保存先は DB（`idempotency_keys` の `UNIQUE(actor_account_id, key)`）。
プロセス内メモリに置かない。メモリだと台数を増やした瞬間に効かなくなり、
しかも**その事実が外からは見えない**。

### 「探してから書く」ではなく「先に占有する」

⚠️ 探す → 無い → 実行する、という順番は 1 本ずつ来る前提でしか正しくない。
同時に 2 本来ると、両方が「無い」を見て**両方実行してしまう**。
読み取りと書き込みのあいだの隙間は `if` では塞げない。

そこで、先に一意制約で場所を取り（`claim`）、取れた 1 本だけが実行する。

| 状況                           | 応答                                     |
| ------------------------------ | ---------------------------------------- |
| 占有できた                     | 実行して結果を返す                       |
| 同一キー＋同一内容・実行済み   | 前回の結果を再返却（201/200 と同じ本文） |
| 同一キー＋同一内容・**実行中** | `409 IDEMPOTENCY_IN_PROGRESS`            |
| 同一キー＋**異なる**内容       | `409 IDEMPOTENCY_CONFLICT`               |

- キーの有効期間は 🟡 24時間
- **本体が失敗したら占有を解放する。** 解放しないと、一度失敗しただけのキーが
  期限切れまで塞がり、利用者がやり直せなくなる
- **結果の記録に失敗しても解放しない。** 本体は成功しているので、解放すると
  やり直しで本体がもう一度走る。塞がったままなら「やり直せない」で済むが、
  解放すると「二重に実行される」。取り返しのつかない操作では後者のほうが重い

```http
POST /api/v1/orders
Idempotency-Key: 01J8Z7Q4...
```

---

## 3-2. Claim API の契約（OVEW Wallet 連携）

✅ **確定（2026-08-14 回答書）。** 相手システムと合わせた契約なので、
**片方だけ変えると通信が成立しない。** 変更は両システム同時に行う。

### パス

```http
GET  /api/collectible-claims/{token}
POST /api/collectible-claims/{token}/confirm
```

⚠️ 旧案の `/api/v1/claims/{token}` は**採用しない**。

### 認証（`UD-1005` 確定: HMAC 必須）

✅ **`POST` も `GET` も HMAC 必須。**

この API は本文で `common_user_id` を受け取るが、
**`common_user_id` は識別子であって資格情報ではない。**
呼び出し元が OVEW Wallet であることを検証しなければ、この値は自己申告にすぎず、
受入条件「Claim はログイン必須」を本システム側で確認する手段が無くなる。

| ヘッダ                  | 内容           |
| ----------------------- | -------------- |
| `X-SenNoKuni-Key-Id`    | 鍵の識別子     |
| `X-SenNoKuni-Timestamp` | UNIX 秒        |
| `X-SenNoKuni-Nonce`     | 使い捨て値     |
| `X-SenNoKuni-Signature` | `sha256=<hex>` |
| `Idempotency-Key`       | 再送の識別     |
| `X-Correlation-Id`      | 追跡用         |

正準文字列（千ノ国共通 v1.1 FINAL）:

```
key_id \n timestamp \n nonce \n METHOD \n path \n raw_body
```

- アルゴリズムは HMAC-SHA256
- `path` に**クエリ文字列を含めない**
- `raw_body` は**受信した生の文字列**。`GET` は空文字
- ⚠️ **JSON を parse して stringify した文字列で署名しない。**
  キー順や空白が変わり、送信側と受信側で別の文字列になる
- タイムスタンプは前後 5 分まで。**未来方向のずれも弾く**
- nonce は使い捨て。**再利用は拒否する**（リプレイ攻撃対策）

### 冪等性（2026-08-14 完成指示書 §4 で確定）

✅ **`POST .../confirm` は `Idempotency-Key` を必須とする。** 省略は `400`。

⚠️ **`nonce` と `Idempotency-Key` は役割が違う。混同しない。**

| 仕組み            | 防ぐもの                                                     |
| ----------------- | ------------------------------------------------------------ |
| `nonce`           | **同じ署名の要求**をそのまま録画・再送されること             |
| `Idempotency-Key` | **正規の相手が新しい署名で送り直した**ときの業務上の二重実行 |

DB は更新できたが応答だけが失われた場合、相手は**新しい nonce で**送り直す。
署名としては正当なので `nonce` では止まらない。ここを止めるのが `Idempotency-Key`。

| 状況                 | 応答                          |
| -------------------- | ----------------------------- |
| 同一キー・同一内容   | 最初の結果をそのまま返す      |
| 同一キー・異なる内容 | `409 IDEMPOTENCY_CONFLICT`    |
| 処理中               | `409 IDEMPOTENCY_IN_PROGRESS` |

⚠️ **保留（`common_user_pending`）は結果として記録しない。**
記録すると、同じキーで送り直したときに**解決後も `PENDING` が返り続ける。**
保留は状態を変えていないので、記録せず解放しても二重実行にならない。

⚠️ **知らないトークンでは冪等キーを占有しない。**
先に占有すると、存在しないトークンを送るだけで
正規の要求が同じキーを使えなくなる。

### 相関ID（同 §5）

`X-Correlation-Id` を受け取り、そのリクエストの全ログへ付け、応答ヘッダへ返す。
未指定のときだけサーバー側で発番する。

⚠️ **受け取った値をそのまま信用しない。**
改行や制御文字が入ると**ログの行を偽装できる。**
`^[A-Za-z0-9._-]{8,128}$` を外れた値は採用せず、こちらで発番する。

### 状態（`UD-1007` 確定）

```
PENDING / DELIVERY_PENDING / DELIVERED / EXPIRED / REVOKED
```

内部の Claim 状態と Wallet への配送状態を合成した値であり、
**公開する状態はこの 5 値のみ**とする。

### `GET` の応答

✅ **最小形式。** 画像 URL とシリアル番号は返さない。

```json
{ "status": "PENDING", "card_name": "作品名", "expires_at": null }
```

> 画像とシリアルは Claim 確定後の `entitlement.granted` で Wallet へ渡す。
> この切り分けにより、**`UD-508`（画像の保存先）が Claim API のブロッカーから外れる。**

### `POST` の応答

| 状況                               | HTTP  | 本文                                                       |
| ---------------------------------- | ----- | ---------------------------------------------------------- |
| 受理した                           | `202` | `{ "status": "DELIVERY_PENDING" }`                         |
| 購入者の `common_user_id` が未解決 | `202` | `{ "status": "PENDING", "reason": "common_user_pending" }` |

⚠️ **未解決は失敗ではない。** 受取権は失効させず、解決後に再度 Claim できる。

### エラー（本システム標準の封筒）

✅ **Claim API だけ独自形式にしない。** 全 API 共通の `{ error: { code, message } }` を使う。

```json
{
  "error": {
    "code": "COMMON_USER_MISMATCH",
    "message": "この受取りは、ご購入されたご本人のアカウントでお受け取りください。"
  }
}
```

| HTTP          | `error.code`              |
| ------------- | ------------------------- |
| `400`         | `VALIDATION_ERROR`        |
| `404`         | `CLAIM_TOKEN_INVALID`     |
| `410`         | `CLAIM_EXPIRED`           |
| `409`         | `CLAIM_REVOKED`           |
| `409`         | `COMMON_USER_MISMATCH`    |
| `409`         | `CLAIM_PROCESSING`        |
| `409`         | `IDEMPOTENCY_CONFLICT`    |
| `409`         | `IDEMPOTENCY_IN_PROGRESS` |
| `401` / `403` | 署名の検証に失敗（下記）  |

> ❓ **要確認:** 2026-08-14 の完成指示書 §8 は 404 の符号を `CLAIM_NOT_FOUND` と表記している。
> 本文書（Q1〜Q7 で確定・凍結済み）は `CLAIM_TOKEN_INVALID`。
> **相手システムと合わせた綴りなので、片方だけ変えると通信が成立しない。**
> Wallet 側の必須テスト・分類のいずれにも 404 が現れないため、
> **凍結済みの `CLAIM_TOKEN_INVALID` を維持している。**
> 変更が必要なら両システム同時に行う。

⚠️ **署名の失敗理由を応答に含めない。**
「鍵が違う」「タイムスタンプがずれている」「nonce が使用済み」を伝えると、
攻撃者にどこまで合っていたかを教えることになる。ログにのみ残す。

---

## 4. エンドポイント一覧

### 4.1 Phase 1 実装分（システム）

| メソッド | パス       | 認証 | 説明                                                            |
| -------- | ---------- | ---- | --------------------------------------------------------------- |
| GET      | `/healthz` | 不要 | **Liveness。** プロセスが生きていれば 200。外部依存を確認しない |
| GET      | `/readyz`  | 不要 | **Readiness。** DB 等の依存が使える場合のみ 200、不可なら 503   |

🟡 **仮決定:** liveness と readiness を分離する。
理由: DB 障害時に liveness まで失敗させるとコンテナが無限再起動し、復旧を妨げるため。

`GET /healthz` 応答:

```json
{ "status": "ok", "service": "api", "version": "0.1.0", "uptimeSec": 42 }
```

`GET /readyz` 応答（劣化時）:

```json
{
  "status": "degraded",
  "checks": [{ "name": "database", "status": "fail", "durationMs": 5001 }]
}
```

> ⚠️ ヘルスチェック応答に**接続文字列・ホスト名・バージョン詳細などの内部情報を含めない**。

### 4.2 Phase 2 以降（契約のみ・未実装）

#### カタログ（公開）

| メソッド | パス                      | 認証 | 説明                               |
| -------- | ------------------------- | ---- | ---------------------------------- |
| GET      | `/api/v1/artworks`        | 不要 | 公開作品一覧（カーソルページング） |
| GET      | `/api/v1/artworks/{slug}` | 不要 | 作品詳細＋有効な出品               |

#### 購入（要ログイン）

| メソッド | パス                                   | 認証            | 説明                                           |
| -------- | -------------------------------------- | --------------- | ---------------------------------------------- |
| POST     | `/api/v1/orders`                       | buyer           | 注文作成（在庫仮引当）。`Idempotency-Key` 必須 |
| GET      | `/api/v1/orders/{id}`                  | buyer(自分のみ) | 注文照会                                       |
| POST     | `/api/v1/orders/{id}/checkout-session` | buyer(自分のみ) | 決済セッション作成。決済画面URLを返す          |

`POST /api/v1/orders` リクエスト:

```json
{ "listingId": "01J8...", "quantity": 1 }
```

応答 201:

```json
{
  "order": {
    "id": "01J8...",
    "status": "pending",
    "total": { "amount": 12000, "currency": "JPY" },
    "reservedUntil": "2026-01-01T00:30:00Z",
    "lines": [
      {
        "artworkTitle": "作品名（注文時点のスナップショット）",
        "unitPrice": { "amount": 12000, "currency": "JPY" },
        "quantity": 1
      }
    ]
  }
}
```

> ✅ **決済完了の判定を応答に含めない。** `status` が `paid` になるのは Webhook 受信後のみ。
> フロントは成功画面到達をもって完了扱いにせず、注文照会をポーリングする。

#### 受取（要ログイン）

| メソッド | パス                                    | 認証            | 説明                                       |
| -------- | --------------------------------------- | --------------- | ------------------------------------------ |
| GET      | `/api/v1/claims/{claimToken}`           | buyer           | Claim 対象の内容確認（**状態を変えない**） |
| POST     | `/api/v1/claims/{claimToken}/accept`    | buyer           | Claim 実行。`Idempotency-Key` 必須         |
| GET      | `/api/v1/me/collection`                 | buyer           | 受取済み作品一覧                           |
| GET      | `/api/v1/me/collection/{entitlementId}` | buyer(自分のみ) | 受取済み作品詳細（発行状況を含む）         |

🟡 **仮決定:** Claim は GET（確認）と POST（実行）を分離する。
理由: メールクライアントやチャットアプリのリンクプリフェッチによって
**GET だけで Claim が確定してしまう事故**を防ぐため。

`POST /api/v1/claims/{claimToken}/accept` 応答 200:

```json
{
  "entitlement": {
    "id": "01J8...",
    "status": "claimed",
    "artworkTitle": "作品名",
    "serialNo": 7,
    "claimedAt": "2026-01-01T00:00:00Z"
  },
  "issuance": { "status": "queued" }
}
```

> `issuance.status` は `queued` / `processing` / `succeeded` / `failed`。
> **Claim の成功と Mint の成功を分けて表現する。** Mint は非同期であり、
> Claim 応答時点では完了していない。

#### 運営（要 operator ロール）

| メソッド | パス                                  | 説明                         |
| -------- | ------------------------------------- | ---------------------------- |
| POST     | `/api/v1/admin/artworks`              | 作品登録                     |
| PATCH    | `/api/v1/admin/artworks/{id}`         | 作品更新                     |
| POST     | `/api/v1/admin/artworks/{id}/publish` | 公開                         |
| POST     | `/api/v1/admin/listings`              | 出品作成                     |
| PATCH    | `/api/v1/admin/listings/{id}`         | 出品更新（価格・状態）       |
| GET      | `/api/v1/admin/orders`                | 注文一覧（絞り込み）         |
| GET      | `/api/v1/admin/entitlements`          | 受取権一覧（受取・発行状況） |
| POST     | `/api/v1/admin/mint-jobs/{id}/retry`  | 発行ジョブの手動再試行       |

✅ **事実:** 管理APIは**認可ミドルウェアで一括保護**する。ルートごとに個別チェックを書かない。

#### Webhook（外部→本システム）

| メソッド | パス                                   | 認証         | 説明                 |
| -------- | -------------------------------------- | ------------ | -------------------- |
| POST     | `/api/v1/webhooks/payments/{provider}` | **署名検証** | 決済事業者からの通知 |

✅ **事実:** 署名検証に失敗したら 400 を返し、処理しない。
✅ **事実:** 検証成功後、`webhook_events` へ INSERT し、一意制約違反なら即 200 で終了（冪等）。

> ⚠️ **実装上の注意（事故多発地帯）**
>
> - Webhook ルートには **raw body** が必要。JSON パーサより**前に**適用する
>   （NestJS では `rawBody: true` でアプリを生成し、当該ルートのみ raw を使う）。
> - 処理に時間がかかっても**まず 200 を返す**。重い処理は Outbox / worker へ逃がす。
>   再送を招くと二重処理の検証負荷が上がる。
> - 5xx を返すと送信元が再送するため、**業務エラーで 5xx を返さない**。
>   処理不能なイベントは `status='ignored'` として記録し 200 を返す。

---

## 5. 認証の受け渡し

🟡 **仮決定:**

- ブラウザ ⇄ `apps/web`: セッションは **httpOnly / Secure / SameSite=Lax Cookie**。
  ✅ アクセストークンを localStorage に保存しない。
- `apps/web` ⇄ `apps/api`: サーバー間で `Authorization: Bearer <access token>`。
- 外部システム ⇄ `apps/api`: Webhook 署名、または発行済みサービストークン。
  詳細は [EXTERNAL_INTEGRATION_POLICY.md](./EXTERNAL_INTEGRATION_POLICY.md)。

---

## 6. レート制限

🟡 **仮決定:** 次の経路に制限を掛ける。

| 経路                         | 制限（仮）                  | 目的                         |
| ---------------------------- | --------------------------- | ---------------------------- |
| `GET /api/v1/claims/{token}` | IPあたり 20 req/min         | Claim トークンの総当たり防止 |
| `POST /api/v1/orders`        | アカウントあたり 10 req/min | 在庫の枯渇攻撃防止           |
| 認証系                       | IPあたり 10 req/min         | 資格情報総当たり防止         |

❓ **未決定 `UD-601`:** レート制限の実装場所（アプリ内 / リバースプロキシ / WAF）と
具体的な閾値。デプロイ先（`UD-302`）に依存する。

---

## 7. OpenAPI

🟡 **仮決定:** `packages/contracts` の zod スキーマを単一の正とし、
そこから OpenAPI ドキュメントと TypeScript 型の両方を導出する。
理由: 手書きの OpenAPI は実装と乖離する。スキーマを実行時検証にも使うことで乖離を防ぐ。

✅ **事実:** Phase 1 では OpenAPI 生成まで実装しない（契約パッケージの器のみ用意する）。

---

## 8. 本文書の未決定事項

| ID     | 概要                       |
| ------ | -------------------------- |
| UD-601 | レート制限の実装場所と閾値 |
