# EVENT_CATALOG.md — イベントカタログ

記法は [README.md](./README.md) に従う。

✅ **事実:** Phase 1 ではイベントの**スキーマ定義のみ**を実装し、配信は行わない。

---

## 1. 方針

🟡 **仮決定:**

| 項目       | 決定                                                | 根拠                                           |
| ---------- | --------------------------------------------------- | ---------------------------------------------- |
| 命名       | `<aggregate>.<past-tense-verb>`（例: `order.paid`） | 過去形で「起きた事実」であることを明示         |
| バージョン | イベント名に含めず `eventVersion` フィールドで持つ  | 互換変更でトピック名を変えずに済む             |
| 発行方式   | Transactional Outbox（DBに書き、worker が配信）     | 業務更新と発行の原子性を確保                   |
| 配信保証   | **At-least-once**                                   | 購読側は冪等に実装する前提                     |
| 順序保証   | **保証しない**                                      | 購読側は `occurredAt` と集約状態で判断する     |
| 個人情報   | **payload に含めない**                              | ✅ セキュリティ要件。必要なら購読側がAPIで取得 |

> ⚠️ **at-least-once であることを購読者に必ず明示する。**
> 「1回しか来ない」前提で作られた購読側は、再送時に二重処理を起こす。

---

## 2. イベント封筒（共通形式）

```json
{
  "eventId": "01J8Z7Q4XXXXXXXXXXXXXXXXXX",
  "eventName": "order.paid",
  "eventVersion": 1,
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "aggregate": { "type": "order", "id": "01J8..." },
  "data": {}
}
```

| フィールド     | 説明                                             |
| -------------- | ------------------------------------------------ |
| `eventId`      | イベントの一意ID。**購読側はこれで重複排除する** |
| `eventName`    | イベント種別                                     |
| `eventVersion` | データ構造のバージョン                           |
| `occurredAt`   | 事実が発生した時刻（配信時刻ではない）           |
| `aggregate`    | 発生元の集約                                     |
| `data`         | イベント固有のペイロード                         |

---

## 3. 発行イベント（本システム → 外部・内部）

### 3.1 カタログ

| イベント名             | 発生契機                       | 主な購読者（想定）           |
| ---------------------- | ------------------------------ | ---------------------------- |
| `artwork.published`    | 作品が公開された               | 検索インデックス、通知       |
| `artwork.archived`     | 作品が非公開化された           | 検索インデックス             |
| `listing.activated`    | 出品が販売開始                 | 通知                         |
| `listing.closed`       | 出品が終了                     | 通知                         |
| `order.created`        | 注文が作成された（未決済）     | 分析                         |
| `order.paid`           | **決済が確定した**             | 受取権発行、代理店連携、通知 |
| `order.payment_failed` | 決済が失敗した                 | 在庫解放、分析               |
| `order.expired`        | 仮引当が期限切れ               | 在庫解放                     |
| `order.refunded`       | 全額返金された                 | 受取権失効、代理店連携       |
| `entitlement.issued`   | 受取権が発行された             | 通知（Claim案内）            |
| `entitlement.claimed`  | 受取権が行使された             | 発行ジョブ投入、通知         |
| `entitlement.revoked`  | 受取権が取り消された           | 通知                         |
| `mint.succeeded`       | トークン発行が完了した         | 通知、コレクション表示更新   |
| `mint.failed`          | トークン発行が最終的に失敗した | **運用アラート（要人手）**   |

### 3.2 主要イベントの `data` 定義

#### `order.paid` (v1)

```json
{
  "orderId": "01J8...",
  "accountId": "01J8...",
  "total": { "amount": 12000, "currency": "JPY" },
  "paidAt": "2026-01-01T00:00:00.000Z",
  "lines": [
    { "artworkId": "01J8...", "quantity": 1, "unitPrice": { "amount": 12000, "currency": "JPY" } }
  ]
}
```

> ⚠️ 購入者の氏名・メール・住所・カード情報を**含めない**。
> 必要な購読者は `accountId` を使って権限付きAPIで取得する。

#### `entitlement.issued` (v1)

```json
{
  "entitlementId": "01J8...",
  "orderId": "01J8...",
  "accountId": "01J8...",
  "artworkId": "01J8...",
  "serialNo": 7,
  "expiresAt": null
}
```

> ⚠️ **Claim トークンをイベントに含めない。**
> Claim URL の生成は、通知チャネル側が権限付きAPIで都度取得する。
> イベントは複数の購読者・ログ・キューを経由するため、秘密を載せてはならない。

#### `entitlement.claimed` (v1)

```json
{
  "entitlementId": "01J8...",
  "accountId": "01J8...",
  "claimedByAccountId": "01J8...",
  "artworkId": "01J8...",
  "serialNo": 7,
  "claimedAt": "2026-01-01T00:00:00.000Z"
}
```

#### `mint.succeeded` (v1)

```json
{
  "entitlementId": "01J8...",
  "mintJobId": "01J8...",
  "chainRef": "<未確定>",
  "contractRef": "<未確定>",
  "tokenRef": "<未確定>",
  "txRef": "<未確定>",
  "mintedAt": "2026-01-01T00:00:00.000Z"
}
```

❓ **未決定 `UD-701`:** `chainRef` / `contractRef` / `tokenRef` の**値の形式**は
チェーン選定（`UD-501`）が決まるまで確定できない。スキーマ上は不透明な文字列とし、
購読側にも「形式に依存した処理を書かないこと」を明示する。

#### `mint.failed` (v1)

```json
{
  "entitlementId": "01J8...",
  "mintJobId": "01J8...",
  "attemptCount": 5,
  "lastErrorCode": "PROVIDER_UNAVAILABLE",
  "failedAt": "2026-01-01T00:00:00.000Z"
}
```

> `lastErrorCode` は**分類コードのみ**。外部APIの生のエラー本文は含めない
> （秘匿値やエンドポイント情報が混入しうるため）。

---

## 4. 受信イベント（外部 → 本システム）

### 4.1 決済 Webhook

✅ **事実:** 署名検証を必須とする。

| 想定イベント種別   | 本システムの処理                                         |
| ------------------ | -------------------------------------------------------- |
| 決済セッション完了 | 注文を `paid` にし、受取権を発行する                     |
| 決済失敗           | 注文を `failed` にし、在庫を解放する                     |
| 決済期限切れ       | 注文を `expired` にし、在庫を解放する                    |
| 全額返金           | 注文を `refunded` にし、未Claim受取権を `revoked` にする |
| 一部返金           | **自動処理しない。** 記録のみ残す                        |

❓ **未決定 `UD-702`:** 決済事業者（Stripe が想定されるが確定指示なし）と、
そのイベント種別の正確な名称。✅「Stripe本番接続」は禁止されており、
Phase 1 では `PaymentGatewayPort` の interface と Fake 実装のみ用意する。

**注文の特定順序（🟡 仮決定）:**

1. Webhook の metadata に載せた `orderId`
2. `payments.provider_payment_ref` からの逆引き
3. `payments.provider_session_ref` からの逆引き
4. いずれも特定できない → **ログに記録して 200 を返す**（再送させない）

根拠: 5xx を返すと送信元が再送し続け、原因不明のまま負荷とアラートが増える。
特定不能は本システム側の調査対象であり、送信元の再送では解決しない。

### 4.2 Mint プロバイダからのコールバック

❓ **未決定 `UD-703`:** Mint の完了通知をコールバック（Webhook）で受けるか、
ワーカーからのポーリングで確認するか。採用する Mint 手段（`UD-501`）に依存する。
`MintingPort` は**両方式に対応できるよう**、`submit()` と `getStatus()` の
2メソッドを持つ設計にする。

---

## 5. 購読側への要求事項

🟡 **仮決定:** 本システムのイベントを購読する外部システムには、次を要求する。

1. **冪等に処理すること。** `eventId` を記録し、既処理なら破棄する。
2. **順序に依存しないこと。** 後続イベントが先に届きうる。
3. **未知のフィールドを許容すること。** 互換的な追加でエラーにしない。
4. **未知の `eventName` を無視すること。** 新イベント追加で壊れないこと。
5. **署名を検証すること。** 検証手順は [EXTERNAL_INTEGRATION_POLICY.md](./EXTERNAL_INTEGRATION_POLICY.md)。

---

## 6. 本文書の未決定事項

| ID     | 概要                                             |
| ------ | ------------------------------------------------ |
| UD-701 | チェーン系識別子（`chainRef` 等）の値形式        |
| UD-702 | 決済事業者の確定とイベント種別名                 |
| UD-703 | Mint 完了通知の方式（コールバック / ポーリング） |
