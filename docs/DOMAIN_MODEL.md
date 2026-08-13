# DOMAIN_MODEL.md — ドメインモデル

記法は [README.md](./README.md) に従う。

---

## 1. ユビキタス言語

🟡 **仮決定:** コード上の識別子は英語、UI表示は日本語とし、対応を次で固定する。

| コード上の名前 | 日本語（内部） | UI表記 | 定義 |
| --- | --- | --- | --- |
| `Artwork` | 作品 | デジタル作品 | 販売対象となる著作物。1件の作品が複数枚発行されうる |
| `Listing` | 出品 | 販売 | 作品を特定価格・特定期間で販売可能にした単位 |
| `Order` | 注文 | ご注文 | 購入者が出品に対して行った購入意思と、その決済状態 |
| `Payment` | 決済 | お支払い | 外部決済事業者における1回の支払い |
| `Entitlement` | 受取権 | 受取り権利 | **1枚のトークンを受け取る権利**。注文の数量ぶん個別に存在する |
| `Claim` | 受取 | 受取り | 受取権を行使して自分のものにする行為 |
| `MintJob` | 発行ジョブ | （非表示） | Claim 済み受取権に対しトークンを発行する非同期処理 |
| `NftToken` | トークン | デジタル所有証明 | Mint 済みのオンチェーン資産への参照 |
| `Account` | アカウント | アカウント | 認証済み利用者。Supabase Auth のユーザーに1:1で対応 |

> **`Entitlement` が本ドメインの中核概念。**
> 「注文が数量Nを持つ」のではなく「注文がN個の受取権を生む」とモデル化する。
> ✅ 指示「NFT受取権を1枚単位で発行する」「1つの受取権から複数Mintできない設計」を、
> 集約の粒度そのもので担保するため。

---

## 2. 集約とその境界

🟡 **仮決定:** 集約（トランザクション整合性の単位）を次のとおり定める。

| 集約ルート | 含むエンティティ | 整合性の責務 |
| --- | --- | --- |
| `Artwork` | `Artwork` | 発行上限（`maxSupply`）を超える引当を許さない |
| `Listing` | `Listing` | 価格・公開状態。在庫カウンタの更新 |
| `Order` | `Order`, `OrderLine`, `Payment` | 金額整合、決済状態遷移の一意性 |
| `Entitlement` | `Entitlement` | 受取権の状態遷移が1回だけ起きること |
| `MintJob` | `MintJob` | 実行の排他取得と再試行回数 |
| `NftToken` | `NftToken` | 受取権に対して高々1つ存在すること |
| `Account` | `Account` | 外部認証IDとの対応 |

集約をまたぐ更新は**ドメインイベント経由**で行う（[EVENT_CATALOG.md](./EVENT_CATALOG.md)）。
ただし「同一DBトランザクション内で書く」ことは許す（Outbox パターン）。

---

## 3. 値オブジェクト

| 名前 | 定義 | 不変条件 |
| --- | --- | --- |
| `Money` | `{ amountMinor: number, currency: CurrencyCode }` | `amountMinor` は**整数**かつ `>= 0`。演算は同一通貨間のみ |
| `Quantity` | 正の整数 | `1 <= q <= MAX_QUANTITY_PER_ORDER` |
| `SerialNumber` | 作品内の連番 | `1 <= n <= artwork.maxSupply`、作品内で一意 |
| `ClaimToken` | Claim URL に埋め込む秘密 | 十分な乱数長。**DBには平文を保存しない**（ハッシュのみ） |
| `IdempotencyKey` | 冪等キー | クライアント指定またはサーバー生成。スコープ内で一意 |
| `ExternalRef` | 外部システムの識別子 | `{ system, id }`。生の外部IDをドメインの主キーにしない |

✅ **事実:** 金額は整数で保持し、浮動小数点演算を行わない。

🟡 **仮決定:** `Money` は「最小通貨単位（minor unit）」で保持する。
JPY は minor unit = 1円（小数0桁）なので、日本円運用では `amountMinor` = 円。
通貨ごとの小数桁は `contracts` の通貨表で持ち、**表示時のみ**適用する。

❓ **未決定 `UD-401`:** 取扱通貨（JPY 単一か複数か）、および税の扱い
（内税／外税、税率、インボイス記載要件）。→ `UD-106`（法務）と連動。
設計は「表示価格 = 支払総額（内税）」を仮置きするが、**税額の内訳計算は実装しない**。

---

## 4. 状態遷移

### 4.1 Order（注文）

```
                  ┌──────────────┐
   作成 ─────────▶│ PENDING      │
                  └──┬────┬────┬─┘
   決済確定Webhook   │    │    │  期限切れ
        ┌────────────┘    │    └────────────┐
        ▼                 ▼                 ▼
   ┌────────┐        ┌─────────┐      ┌─────────┐
   │  PAID  │        │ FAILED  │      │ EXPIRED │
   └───┬────┘        └─────────┘      └─────────┘
       │ 全額返金
       ▼
   ┌──────────┐
   │ REFUNDED │
   └──────────┘
```

| 遷移 | 契機 | 不変条件 |
| --- | --- | --- |
| `→ PENDING` | 注文作成API | 在庫の仮引当に成功していること |
| `PENDING → PAID` | 決済Webhook（署名検証済み） | **同一イベントの再受信で二重遷移しない** |
| `PENDING → FAILED` | 決済失敗Webhook | 仮引当を解放する |
| `PENDING → EXPIRED` | 有効期限超過（ワーカー） | 仮引当を解放する |
| `PAID → REFUNDED` | 全額返金Webhook | 未Claimの受取権を `REVOKED` にする |

✅ **事実:** 決済確定は **Webhook のみ**で判定する。
成功画面への到達を決済完了とみなす処理を書かない。

🟡 **仮決定:** 部分返金は自動処理しない（状態を変えず記録のみ）。→ `UD-104`

### 4.2 Entitlement（受取権）

```
   注文がPAIDになった時に生成
            │
            ▼
      ┌──────────┐   Claim成功   ┌──────────┐
      │  ISSUED  │──────────────▶│ CLAIMED  │
      └──┬────┬──┘                └──────────┘
         │    │
  期限切れ│    │返金・取消
         ▼    ▼
   ┌─────────┐ ┌──────────┐
   │ EXPIRED │ │ REVOKED  │
   └─────────┘ └──────────┘
```

**不変条件（最重要）:**

- **INV-E1:** `ISSUED → CLAIMED` の遷移は、DBの**条件付きUPDATE**
  （`WHERE id = ? AND status = 'ISSUED'`）で行い、更新行数1件のみを成功とする。
  これにより同時Claimでも1回しか成功しない。
- **INV-E2:** `CLAIMED` になった受取権は他の状態へ戻らない（終端）。
- **INV-E3:** 1つの受取権に対して `NftToken` は高々1件（DBの UNIQUE 制約で担保）。
- **INV-E4:** `EXPIRED` / `REVOKED` からの Claim は不可。

🟡 **仮決定:** Claim後の返金は受取権の状態を変えない（`CLAIMED` のまま）。
オンチェーン発行済み資産の回収可否が未確定のため。→ `UD-104`

### 4.3 MintJob（発行ジョブ）

```
   Claim成功時に作成
        │
        ▼
   ┌──────────┐  排他取得   ┌────────────┐  成功  ┌───────────┐
   │  QUEUED  │───────────▶│ PROCESSING │──────▶│ SUCCEEDED │
   └────┬─────┘             └─────┬──────┘        └───────────┘
        │                         │ 失敗
        │        再試行可          ▼
        │◀──────────────────┬───────────┐
        │                   │ 試行上限超 │
        │ 取消              ▼           │
        ▼            ┌──────────┐       │
   ┌───────────┐     │  FAILED  │◀──────┘
   │ CANCELLED │     └──────────┘
   └───────────┘
```

**不変条件:**

- **INV-M1:** 実行の取得は条件付きUPDATE（`WHERE status='QUEUED' AND next_attempt_at <= now()`）で
  アトミックに行い、更新できたワーカーだけが処理する。
- **INV-M2:** `MintJob` は `entitlement_id` に対して1件のみ（UNIQUE）。
- **INV-M3:** 再試行は指数バックオフ。試行回数が上限を超えたら `FAILED` にして自動再試行を止める。
- **INV-M4:** `PROCESSING` の行は、外部へ送信済みの可能性があるため、
  返金・取消でも `CANCELLED` にせず注記のみを残す。
- **INV-M5:** 外部Mint実行には**冪等キー**（受取権IDから導出）を必ず渡す。
  外部側が冪等をサポートしない場合は「送信前に送信記録を確定させる」二相の記録を行う。

🟡 **仮決定:** 再試行は最大5回、バックオフは 1分 → 5分 → 15分 → 60分 → 180分。
根拠: 一時障害はほぼ数分で回復し、それを超える障害は人手対応が要るため、
後半を粗くして無駄な試行を減らす。数値は運用開始後に調整する。

❓ **未決定 `UD-402`:** Mint 失敗が最終的に確定した場合の顧客対応
（返金するのか、再発行を待たせるのか）。運用ポリシー未定。

### 4.4 Payment（決済）

🟡 **仮決定:** `Payment` は状態を持つが、真の状態は常に外部決済事業者側にある。
本システムは**Webhookで受け取った事実の写像**として保持し、
本システム側から状態を推測して進めない。

---

## 5. 在庫（発行上限）の扱い

🟡 **仮決定:** **仮引当方式**を採る。

```
販売可能数 = artwork.max_supply - artwork.reserved_count - artwork.issued_count
```

| 契機 | 操作 |
| --- | --- |
| 注文作成 | 行ロックの上で販売可能数を検証し、`reserved_count += quantity` |
| 決済確定 | `reserved_count -= quantity`, `issued_count += quantity`、受取権を quantity 件作成 |
| 失敗・期限切れ | `reserved_count -= quantity` |

**不変条件 INV-S1:** `reserved_count >= 0` かつ `issued_count >= 0` かつ
`reserved_count + issued_count <= max_supply`。DBの CHECK 制約で担保する。

🟡 **仮決定:** 仮引当の有効期限は 30分。理由: 決済画面の一般的な滞在時間に対して十分で、
かつ在庫を長時間拘束しない。期限切れはワーカーが定期的に解放する。

---

## 6. ポート（domain が定義する外部境界）

`packages/domain` は次の interface のみを定義し、実装を持たない。

| ポート | 役割 | 実装場所 |
| --- | --- | --- |
| `ArtworkRepository` / `ListingRepository` / `OrderRepository` / `EntitlementRepository` / `MintJobRepository` | 永続化 | `packages/database` |
| `PaymentGatewayPort` | 決済セッション作成、Webhook 署名検証、返金参照 | `packages/integrations` |
| `MintingPort` | トークン発行の依頼と結果取得 | `packages/integrations` |
| `MetadataStoragePort` | メタデータ・画像の保存と公開URL取得 | `packages/integrations` |
| `ClaimTokenPort` | Claim トークンの生成と検証（ハッシュ化） | `packages/integrations` |
| `ClockPort` | 現在時刻（テスト可能性のため） | `packages/integrations` |
| `IdGeneratorPort` | 識別子生成 | `packages/integrations` |
| `EventPublisherPort` | ドメインイベントの発行（Outbox書き込み） | `packages/database` |

✅ **事実:** Phase 1 では上記ポートの **interface と Fake 実装のみ**を用意し、
実サービスには接続しない。

---

## 7. ドメインエラー

🟡 **仮決定:** ドメイン層は例外ではなく**型付き Result**（`Ok | Err`）を返す。
理由: 「在庫切れ」「Claim済み」は例外ではなく正常な業務結果であり、
呼び出し側に網羅的な分岐を型で強制できるため。

| エラーコード | 意味 |
| --- | --- |
| `ARTWORK_NOT_AVAILABLE` | 作品が非公開または存在しない |
| `LISTING_NOT_ACTIVE` | 出品が販売中でない |
| `INSUFFICIENT_SUPPLY` | 販売可能数が不足 |
| `INVALID_QUANTITY` | 数量が範囲外 |
| `ORDER_NOT_PENDING` | 注文が支払待ちでない |
| `ENTITLEMENT_NOT_CLAIMABLE` | 受取権が `ISSUED` でない |
| `ENTITLEMENT_OWNER_MISMATCH` | Claim実行者が購入者と一致しない |
| `CLAIM_TOKEN_INVALID` | Claim トークンが不正または期限切れ |
| `MINT_ALREADY_EXISTS` | 既にトークンが発行済み |
| `IDEMPOTENCY_CONFLICT` | 同一冪等キーで異なる内容の要求 |

HTTP へのマッピングは [API_DESIGN.md](./API_DESIGN.md) 参照。

---

## 8. 本文書の未決定事項

| ID | 概要 |
| --- | --- |
| UD-401 | 取扱通貨と税の扱い（内税/外税・税率・インボイス） |
| UD-402 | Mint 最終失敗時の顧客対応ポリシー |

（`UD-104` 返金ポリシーは [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) 由来）
