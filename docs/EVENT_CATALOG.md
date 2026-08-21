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

## 4-2. 外部イベントへの変換（OVEW Wallet）

⚠️ **内部イベントをそのまま外部へ送らない。**
内部のイベント名は本システムのドメインの言葉であり、
連携先の都合で変えると、外部の要求が内部設計に染み出す。
変換はアダプタの責務とする。

| 内部イベント          | →   | OVEW Wallet 向け      |
| --------------------- | --- | --------------------- |
| `entitlement.claimed` | →   | `entitlement.granted` |
| `entitlement.revoked` | →   | `entitlement.revoked` |

### 封筒（千ノ国共通契約）

```json
{
  "event_id": "evt_xxxxx",
  "event_type": "entitlement.granted",
  "event_version": "1.0",
  "source_system_key": "sennokuni-nft-market",
  "target_site_key": "ovew-wallet",
  "correlation_id": "corr_xxxxx",
  "occurred_at": "2026-08-13T16:00:00+09:00",
  "common_user_id": "cu_xxxxx",
  "data": {
    "entitlement_id": "ent_xxxxx",
    "order_id": "ord_xxxxx",
    "artwork_id": "art_xxxxx"
  },
  "metadata": {
    "entitlement_type": "DIGITAL_COLLECTIBLE",
    "asset_code": "art_xxxxx",
    "name": "作品名",
    "description": "作品説明",
    "image_url": "https://...",
    "thumbnail_url": "https://...",
    "image_hash": "sha256:...",
    "rarity": null,
    "serial_number": "0007",
    "blockchain_status": "NOT_MINTED"
  }
}
```

> ✅ **`blockchain_status` は当面つねに `NOT_MINTED`**（2026-08-14 の方針変更）。
> MVP では Mint しない。値を可変にしておくが、`MINTED` を入れる経路は作らない。

> ✅ **ギャップ2件のうち 1 件を解消した**（PR-NW04）。
>
> | 項目         | 状態                                                                                          |
> | ------------ | --------------------------------------------------------------------------------------------- |
> | `image_hash` | ✅ `artworks.image_hash` を追加。画像保存時に中身から計算する（形式は CHECK 制約で固定）      |
> | `image_url`  | 🟡 `UD-508` は Cloudflare R2 + Custom Domain に確定。**設定はまだ**。整うまで配送は既定で無効 |
>
> ⚠️ **配送を有効にしただけでは動かない。**
> `WALLET_DELIVERY_ENABLED=true` にすると、受取確定と同時に配送本文を組み立てる。
> 長期URLの画像が無い作品では**受取そのものが失敗する**。R2 の設定が先。

### `product_code` と `asset_code`

✅ **MVP で商品コードを採番しない**（PR-NW04 §6）。

`data.product_code` は常に `null` を送る。カードの識別には
`metadata.asset_code`（`artwork_id` 由来の安定識別子）を使う。

⚠️ **MVP で新しい商品コード体系を作らない。**
採番規則を決めずに値を入れ始めると、あとから規則を与えたときに
既に送った分と食い違う。

### `serial_number` の表記

✅ **`String(serialNo).padStart(4, '0')`**（PR-NW04 §5）。

DB は整数のまま持ち、**送信時だけ**文字列にする。
固定4桁ではなく「最低4桁」であり、`10000` は切り詰めずに `10000` と送る。

| DB      | 送信値    |
| ------- | --------- |
| `1`     | `"0001"`  |
| `7`     | `"0007"`  |
| `9999`  | `"9999"`  |
| `10000` | `"10000"` |

⚠️ **あとから規則を変えない。**
既に Wallet へ送った Holding の表示と食い違い、
同じ 1 枚が別の番号で 2 通りに見える。

### 送信ヘッダ

✅ 千ノ国共通 HMAC v1.1 FINAL（PR-NW04 §15）。

| ヘッダ                  | 内容                                                   |
| ----------------------- | ------------------------------------------------------ |
| `X-SenNoKuni-Key-Id`    | 鍵ID                                                   |
| `X-SenNoKuni-Timestamp` | UNIX 秒                                                |
| `X-SenNoKuni-Nonce`     | 使い捨て値（CSPRNG）                                   |
| `X-SenNoKuni-Signature` | `sha256=<hex>`                                         |
| `Idempotency-Key`       | **`event_id` と同じ値**。再試行でも作り直さない（§16） |
| `X-Correlation-Id`      | Claim から配送まで引き継ぐ（§17）                      |
| `X-Event-Version`       | **本文の `event_version` と必ず一致**（§14）           |

⚠️ **`X-Event-Version` を定数から埋めない。**
本文から取り出して載せる。2 か所から埋めると、片方だけ上げたときに
食い違い、相手はヘッダで分岐して本文を読み違える。

⚠️ **再試行で `event_id` を作り直さない。**
相手の冪等キーがこの値なので、作り直すと再試行のたびに
別のイベントとして扱われ、Holding が重複しうる。

### 再試行と打ち切り

✅ バックオフ **1 / 5 / 15 / 60 / 240 分**、最大 **5 回**（PR-NW04 §18）。

| 分類                          | 扱い                           |
| ----------------------------- | ------------------------------ |
| timeout / network / 5xx / 429 | 再試行する                     |
| 400 / 401 / 403 / 409 / 422   | `FAILED`（自動再試行を止める） |
| 上限超過                      | `DEAD`（人手に回す）           |

⚠️ **`FAILED` と `DEAD` を同じ状態に丸めない。**
前者は「送る内容が悪い」で直して再送、後者は「相手が復旧しない」で
状況確認。運用でやることが違うので、どちらなのかを毎回調べ直さずに済むよう分ける。

⚠️ **`DEAD` になっても `wallet_delivery_status` を `delivered` にしない**（§19）。
Holding が作られていないのに配送済みと名乗ると、再送の対象からも外れる。

⚠️ **2xx を成功とみなしてよいのは、それが Holding の永続化
（または同一イベントの冪等成功）を意味する場合だけ**（§21）。
相手が「共通顧客IDが合わないので何もしなかった」ときに 2xx を返す仕様なら、
こちらの `delivered` は嘘になる。**接続前に相手の契約を確認する。**

### 順序の保証について

⚠️ **送る順序を保証しない。** `entitlement.revoked` が `entitlement.granted` より
先に届くことがありうる（返金が受取直後に起きた場合など）。

そのため、**受信側が順序を判断できる情報を必ず載せる**。
`occurred_at` がその役割を持つ。受信側は「自分が持っている状態より
古いイベント」を捨ててよい。

⚠️ **順序を前提にした処理を書かない。**
「granted が来ているはずだから」と仮定すると、revoke 先行のときに
存在しない Holding を取り消そうとして失敗する。
**revoke 先行でも壊れないこと**を要件とする。

### 取消イベント（M3a・版 `1.1`）

全額返金が成立したとき、**相手が知っている受取権にだけ** `entitlement.revoked` を送る。

```json
{
  "event_id": "evt_rvk_3f2b1c8e-0d44-4a91-9d1e-7c5a2b6f0e13",
  "event_type": "entitlement.revoked",
  "event_version": "1.1",
  "occurred_at": "2026-08-21T04:12:33.000Z",
  "source_system_key": "sennokuni-nft-market",
  "target_site_key": "ovew-wallet",
  "correlation_id": "ord-8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "common_user_id": "cu_9a1f0c3b7d8e2f4a5b6c7d8e9f0a1b2c",
  "reason_code": "full_refund",
  "data": {
    "entitlement_id": "3f2b1c8e-0d44-4a91-9d1e-7c5a2b6f0e13",
    "order_id": "8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    "order_item_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "artwork_id": "7e8f9a0b-1c2d-3e4f-5a6b-7c8d9e0f1a2b",
    "product_code": null
  }
}
```

⚠️ **版は種別ごとに分けてある。** `entitlement.granted` は `1.0` のまま。
1 本の定数にまとめると、取消の版を上げた瞬間に付与の版まで黙って上がる。

⚠️ **`metadata` を載せない。** 取消に要るのは「どの受取権が無効になったか」だけ。
表示情報を再送すると、相手がそれで Holding を書き換える余地が生まれる。

⚠️ **金額を載せない。** 返金額も報酬額も相手の表示には要らない。

| 項目             | 決め方                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `event_id`       | **`evt_rvk_` + 受取権ID（決定的）。** 乱数にすると、重複した Webhook や並行実行で同じ取消が 2 通送られる |
| `correlation_id` | 付与イベントの値を引き継ぐ。取れなければ `ord-{order_id}`。**乱数は使わない**                            |
| `common_user_id` | **付与イベントの本文にあった値**を正とする（相手へ実際に伝えた値）。取れないときだけ受取権の列           |
| `occurred_at`    | **返金の `settled_at`。** 現在時刻を入れると、再実行のたびに本文が変わる                                 |
| `reason_code`    | 固定コードのみ。いまは `full_refund` だけ                                                                |

**送る条件は「相手が知っているか」ひとつ。** 付与イベントの行があれば、
その状態（`PENDING` / `PROCESSING` / `FAILED` / `DEAD` / `DELIVERED`）を問わず送る。
行が無い＝相手は知らないので、送らない。

⚠️ **まだ送っていない付与は `SUPERSEDED` にする。** そうしないと、
取り消したはずの作品があとから相手側に現れる。ただし `PROCESSING` は触らない
（届いたかどうかが分からないため、相手の Tombstone 処理に委ねる）。

### 送信時の約束

| 項目                | 約束                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `serial_number`     | **文字列**で送る。`"0007"` であって `7` ではない                   |
| `blockchain_status` | MVP では常に `NOT_MINTED`                                          |
| `metadata`          | **購入・Claim 時点のスナップショット**                             |
| `image_url`         | Wallet 側から取得できる HTTPS URL。`image_key` をそのまま送らない  |
| 配送保証            | at-least-once・順序保証なし。Wallet 側が `event_id` で冪等処理する |
| 送信の位置          | **コミット後**。トランザクション内で HTTP 送信しない               |

⚠️ **後から作品マスタが変わっても、過去の Holding の表示情報を書き換えない。**
購入時に見えていたものが後から変わるのは、購入者への約束の一方的な変更になる。

✅ **`image_hash` は `artworks.image_hash` に持つ**（PR-NW04 §23）。
画像の保存時に**中身から** SHA-256 を計算する。ファイル名や保存キーから
導出しない。導出すると、同じキーに別の画像を上書きしたときに
ハッシュが変わらず、差し替えを検出できない。

> **Wallet への配送完了は、ブロックチェーンへの発行完了ではない。**
> `Entitlement=CLAIMED` / `Wallet=DELIVERED` / `Blockchain=NOT_MINTED` は同時に成立する。
> 状態を混同すると、利用者に「発行済み」と誤って伝わる。

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

| ID          | 概要                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UD-701      | チェーン系識別子（`chainRef` 等）の値形式                                                                                                                       |
| UD-702      | 決済事業者の確定とイベント種別名                                                                                                                                |
| UD-703      | Mint 完了通知の方式（コールバック / ポーリング）                                                                                                                |
| UD-508      | `image_url` の長期参照方式。方式は Cloudflare R2 + Custom Domain に確定。**設定が未了**                                                                         |
| ~~UD-1010~~ | ~~`entitlement.revoked` の本文~~ **決着（2026-08-20）。** 版 `1.1` で `reason_code` を加え、表示情報（`metadata`）は載せない。下の「取消イベント（M3a）」を参照 |

---

## 購入者への知らせ（P0-4）

⚠️ **外部システムへのイベントではない。** 宛先は買った方ご本人で、
運ぶのはメール。`wallet_delivery_outbox` とは別の表（`notification_deliveries`）
に積む——あちらは「相手のシステムへ届ける仕事」、こちらは「人へ伝える仕事」で、
再試行の意味も打ち切りの意味も違う。

### 種別（9 つ）

| 種別                            | 対象   | いつ                                            | 積む場所              |
| ------------------------------- | ------ | ----------------------------------------------- | --------------------- |
| `order.placed`                  | 注文   | ご注文を承ったとき（お支払い前）                | `OrderService.create` |
| `payment.succeeded`             | 注文   | お支払いが確定したとき                          | Stripe Webhook        |
| `payment.failed`                | 注文   | お支払いが成立しなかったとき                    | Stripe Webhook        |
| `payment.expired`               | 注文   | お支払いの期限が過ぎたとき                      | Stripe Webhook        |
| `wallet.registration_requested` | 注文   | 発行はできたが、その場で 1 枚も届かなかったとき | Stripe Webhook        |
| `entitlement.delivered`         | 受取権 | Wallet へ届いたとき                             | 状態から数え上げ      |
| `wallet.delivery_stalled`       | 受取権 | 配送を打ち切ったまま（`DEAD`）のとき            | 状態から数え上げ      |
| `refund.requested`              | 返金   | ご返金の記録を作ったとき                        | `RefundService`       |
| `refund.completed`              | 返金   | ご返金が反映されたとき                          | `RefundService`       |

⚠️ **`entitlement.delivered` と `wallet.delivery_stalled` はキューから積まない。**
どちらも配送ワーカーの側で起きる出来事だが、そこへ積む口を生やすと、
ワーカーが落ちていた時間ぶんが永久に抜ける。**いまの状態から導ける**ことは
状態から導く（受取権の発行（P0-1）と同じ考え方）。

### 重複させない鍵

```
UNIQUE (event_type, subject_type, subject_id)
```

同じ Webhook が 10 回届いても、同じ知らせは 1 通しか積まれない。

⚠️ **積む側は `ON CONFLICT DO NOTHING` で受ける。** 素の `INSERT` にすると、
2 通目の UNIQUE 違反が**業務側のトランザクションごと巻き戻す**。
決済が通っているのに注文が立たない、という最悪の形になる。

### 文面

`notification_templates` に版で持つ。⚠️ **コードへ書かない。**
公開した版は書き換えず、直すときは新しい版を作る。送信履歴は使った版を
指しているので、書き換えると「そのとき何と書いて送ったか」が復元できなくなる。

差し込める語は種別ごとに閉じてあり（`NOTIFICATION_VARIABLES`）、
**語彙に無い語を書いた文面は公開の時点で弾く**。

⚠️ **氏名・メールアドレス・住所は語彙に無い**（`UD-503`）。書きようがない。

### 宛先（`UD-503` 決定 2026-08-20）

本システムは購入者のメールアドレスを**平文で持たない**。

|          |                                                               |
| -------- | ------------------------------------------------------------- |
| 取り出し | 送信の瞬間に認証基盤（Supabase Auth）から。送り終えたら捨てる |
| 保存     | 伏せた表記（`t*****@e******.jp`）と鍵付きハッシュだけ         |
| 再送     | 履歴の表記からは戻せない。**そのつど取り直す**                |

⚠️ DB の CHECK（`notification_deliveries_recipient_is_masked`）が、
伏せ字を含まない値の保存を弾く。
