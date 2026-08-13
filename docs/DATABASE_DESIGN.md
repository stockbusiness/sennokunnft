# DATABASE_DESIGN.md — データベース設計

記法は [README.md](./README.md) に従う。

✅ **事実:** PostgreSQL + Prisma を使用する。
✅ **事実:** Phase 1 では **schema 定義と Prisma Client 生成のみ**行い、
本番DBへのマイグレーション適用は行わない。

---

## 1. 設計原則

🟡 **仮決定:**

| 原則             | 内容                                                         | 根拠                                                                           |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 主キー           | アプリ生成の **UUID v7**（`id UUID PRIMARY KEY`）            | 時系列で概ね単調増加しインデックス断片化が小さい。連番と違い件数を推測されない |
| スナップショット | 注文時点の名称・価格を注文側に複写し、マスタ参照で表示しない | マスタ変更が過去の取引記録を書き換えないため                                   |
| 金額             | `INTEGER`（最小通貨単位）＋ `currency CHAR(3)`               | ✅ 浮動小数点禁止                                                              |
| 日時             | `TIMESTAMPTZ`。保存はUTC、表示時にJST変換                    | タイムゾーン起因の不整合を排除                                                 |
| 論理削除         | 原則使わない。状態列（`status`）で表現する                   | 「削除済みだが参照される」曖昧さを避ける                                       |
| 秘密値           | 平文で保存しない。ハッシュ（`*_hash`）のみ保存               | ✅ セキュリティ要件                                                            |
| 外部ID           | `provider` + `provider_ref` の組で保持し、主キーにしない     | 決済事業者・チェーンの差し替え余地を残す                                       |
| 一意制約         | 冪等性は**アプリのif文ではなくDBのUNIQUE制約**で担保する     | 競合状態でも破れないため                                                       |

---

## 2. ER 概要

```
  accounts ──┐
             │
  artworks ──┼──▶ listings ──▶ orders ──▶ order_lines
             │                    │  │
             │                    │  └──▶ payments ──▶ payment_events
             │                    │
             │                    └──▶ entitlements ──▶ mint_jobs ──▶ nft_tokens
             │                              ▲
             └──────────────────────────────┘ (artwork_id スナップショット)

  webhook_events   （外部Webhookの受信記録・冪等性）
  outbox_events    （ドメインイベントの発行キュー）
  audit_logs       （管理操作の監査証跡）
```

---

## 3. テーブル定義

### 3.1 `accounts` — アカウント

| 列                          | 型          | 制約                        | 説明                                                              |
| --------------------------- | ----------- | --------------------------- | ----------------------------------------------------------------- |
| `id`                        | UUID        | PK                          | 内部ID                                                            |
| `auth_provider`             | TEXT        | NOT NULL                    | 認証プロバイダ識別子（例: `supabase`）                            |
| `auth_subject`              | TEXT        | NOT NULL                    | プロバイダ側のユーザーID（Supabase の `sub`）                     |
| `email_hash`                | TEXT        | NULL                        | 照合用のメールハッシュ。**平文メールは保持しない**（🟡 `UD-503`） |
| `display_name`              | TEXT        | NULL                        | 表示名                                                            |
| `role`                      | TEXT        | NOT NULL DEFAULT `'buyer'`  | `buyer` / `operator` / `auditor`                                  |
| `status`                    | TEXT        | NOT NULL DEFAULT `'active'` | `active` / `suspended`                                            |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                    |                                                                   |

- `UNIQUE (auth_provider, auth_subject)`

🟡 **仮決定:** 認証情報の正は Supabase Auth 側に置き、本テーブルは**参照と業務属性のみ**を持つ。
パスワードハッシュ等の資格情報は一切保持しない。

❓ **未決定 `UD-503`:** メールアドレスを本システム側で保持する必要があるか
（＝メール送信を本システムが行うか、Supabase / 外部に委ねるか）。→ `UD-201`

#### 共通顧客ID の紐付け（`accounts` への追加）

✅ **事実:** `common_user_id` の発行元は**代理店システムのみ**。本システムは受け取るだけ。

| 列                            | 型          | 制約                  | 説明                          |
| ----------------------------- | ----------- | --------------------- | ----------------------------- |
| `common_user_id`              | TEXT        | NULL, CHECK（形式）   | `cu_` ＋ 32 桁 hex            |
| `common_user_status`          | TEXT        | NOT NULL, CHECK       | 下記 5 値                     |
| `common_user_linked_at`       | TIMESTAMPTZ | NULL                  | 解決した時刻                  |
| `common_user_last_error`      | TEXT        | NULL                  | ⚠️ 応答本文をそのまま入れない |
| `common_user_attempt_count`   | INTEGER     | NOT NULL, CHECK(>= 0) | 再試行の回数                  |
| `common_user_next_attempt_at` | TIMESTAMPTZ | NULL                  | 次に試してよい時刻            |

状態: `UNRESOLVED` / `PENDING` / `RESOLVED` / `CONFLICT` / `ERROR`

- CHECK `accounts_common_user_status_known` … 状態は 5 値のみ
- CHECK `accounts_common_user_id_format` … `^cu_[0-9a-f]{32}$`
- CHECK `accounts_common_user_resolved_has_id` … `RESOLVED` なら値と時刻が揃う
- CHECK `accounts_common_user_unresolved_is_clean` … 未着手の行に失敗の痕跡を残さない
- INDEX `(common_user_status, common_user_next_attempt_at)` … 再試行の取り出し用

⚠️ **主キーにしない。** 外部が発行した値を主キーにすると、相手の都合で自分のデータが壊れる。
人物識別は `accounts.id` のまま変えない。

⚠️ **UNIQUE にしない。** 同一人物が別の認証手段で 2 アカウントを持つと、
どちらも同じ `common_user_id` へ解決されうる。
UNIQUE にすると**正しい解決結果が保存できずに落ちる。**

⚠️ **`CONFLICT` の行を自動で直さない。** 上書きすると受取先が黙って別人に変わる。
`CONFLICT` になる理由は 3 つあり、`common_user_last_error` で区別する。

| 理由                                   | `last_error` の例                                |
| -------------------------------------- | ------------------------------------------------ |
| 既存と異なる値が返った                 | `resolved id differs from the stored id`         |
| 本システムが検証していない属性で一致   | `unacceptable match: identity:email`             |
| 名寄せ候補が残っている（重複の可能性） | `identity_match_status=unverified_candidate_...` |

---

### 3.2 `artworks` — 作品

| 列                          | 型          | 制約                             | 説明                                      |
| --------------------------- | ----------- | -------------------------------- | ----------------------------------------- |
| `id`                        | UUID        | PK                               |                                           |
| `slug`                      | TEXT        | NOT NULL, UNIQUE                 | URL用識別子                               |
| `title`                     | TEXT        | NOT NULL                         |                                           |
| `description`               | TEXT        | NOT NULL DEFAULT `''`            |                                           |
| `image_key`                 | TEXT        | NULL                             | ストレージ上のキー。公開URLは実行時に解決 |
| `max_supply`                | INTEGER     | NOT NULL, CHECK `> 0`            | 発行上限                                  |
| `reserved_count`            | INTEGER     | NOT NULL DEFAULT 0, CHECK `>= 0` | 仮引当数                                  |
| `issued_count`              | INTEGER     | NOT NULL DEFAULT 0, CHECK `>= 0` | 受取権発行済み数                          |
| `status`                    | TEXT        | NOT NULL DEFAULT `'draft'`       | `draft` / `published` / `archived`        |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                         |                                           |

- **CHECK `reserved_count + issued_count <= max_supply`**（オーバーセル防止の最終防壁）
- INDEX `(status)`

> ⚠️ この CHECK 制約は **アプリのバグがあってもオーバーセルを物理的に起こさせない**ための防壁。
> アプリ側の行ロック検証と二重に持つ。

### 3.3 `listings` — 出品

| 列                          | 型          | 制約                             | 説明                                     |
| --------------------------- | ----------- | -------------------------------- | ---------------------------------------- |
| `id`                        | UUID        | PK                               |                                          |
| `artwork_id`                | UUID        | NOT NULL, FK → `artworks.id`     |                                          |
| `price_amount`              | INTEGER     | NOT NULL, CHECK `>= 0`           | 最小通貨単位                             |
| `price_currency`            | CHAR(3)     | NOT NULL                         | ISO 4217                                 |
| `max_quantity_per_order`    | INTEGER     | NOT NULL DEFAULT 1, CHECK `>= 1` |                                          |
| `status`                    | TEXT        | NOT NULL DEFAULT `'draft'`       | `draft` / `active` / `paused` / `closed` |
| `starts_at` / `ends_at`     | TIMESTAMPTZ | NULL                             | 販売期間                                 |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                         |                                          |

- INDEX `(artwork_id)`, `(status, starts_at, ends_at)`, `(display_order)`
- **`UNIQUE (artwork_id) WHERE status IN ('active','scheduled')`** — 同一作品に有効な出品は 1 件
- **トリガ `listings_require_published_artwork`** — 公開済みの作品にしか有効な出品を作らせない
  （作品と出品は別テーブルなので CHECK では表現できない）
- CHECK `price_amount > 0` — 0 円の出品は作れない。無償配布は販売とは別の導線として扱う
- CHECK `status <> 'scheduled' OR starts_at IS NOT NULL`

> ⚠️ 作品を後から `archived` にしても、既存の出品はそのまま残る。
> 公開APIが作品の状態で絞り込むため露出はしないが、
> 出品を止めたい場合は出品側も `ended` にする運用とする。

🟡 **仮決定:** `max_quantity_per_order` の既定値は 1。
理由: 1枚単位の受取権が主概念であり、まとめ買いは MVP の必須要件ではないため保守的に始める。

### 3.4 `orders` — 注文

| 列                          | 型          | 制約                         | 説明                                                   |
| --------------------------- | ----------- | ---------------------------- | ------------------------------------------------------ |
| `id`                        | UUID        | PK                           |                                                        |
| `account_id`                | UUID        | NOT NULL, FK → `accounts.id` | 購入者                                                 |
| `status`                    | TEXT        | NOT NULL                     | `pending` / `paid` / `failed` / `expired` / `refunded` |
| `total_amount`              | INTEGER     | NOT NULL, CHECK `>= 0`       | 明細合計のスナップショット                             |
| `total_currency`            | CHAR(3)     | NOT NULL                     |                                                        |
| `idempotency_key`           | TEXT        | NOT NULL                     | 注文作成の冪等キー                                     |
| `reserved_until`            | TIMESTAMPTZ | NULL                         | 仮引当の期限                                           |
| `paid_at`                   | TIMESTAMPTZ | NULL                         |                                                        |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                     |                                                        |

- `UNIQUE (account_id, idempotency_key)` — 同一利用者の二重注文を防ぐ
- INDEX `(status, reserved_until)` — 期限切れ回収ワーカー用
- INDEX `(account_id, created_at DESC)`

✅ **事実:** 購入者は**ログイン必須**（Claim時の本人照合に必要なため `account_id` は NOT NULL）。

❓ **未決定 `UD-504`:** ゲスト購入（未ログイン購入）を許すか。
許す場合、Claim 時の本人照合をメール到達性で代替する設計が必要になり、
セキュリティ前提が変わる。現設計は**ログイン必須**を前提にしている。

### 3.5 `order_lines` — 注文明細

| 列                       | 型          | 制約                         | 説明                 |
| ------------------------ | ----------- | ---------------------------- | -------------------- |
| `id`                     | UUID        | PK                           |                      |
| `order_id`               | UUID        | NOT NULL, FK → `orders.id`   |                      |
| `listing_id`             | UUID        | NOT NULL, FK → `listings.id` | 参照用               |
| `artwork_id`             | UUID        | NOT NULL, FK → `artworks.id` | 参照用               |
| `artwork_title_snapshot` | TEXT        | NOT NULL                     | **注文時点の作品名** |
| `unit_price_amount`      | INTEGER     | NOT NULL                     | **注文時点の単価**   |
| `unit_price_currency`    | CHAR(3)     | NOT NULL                     |                      |
| `quantity`               | INTEGER     | NOT NULL, CHECK `>= 1`       |                      |
| `created_at`             | TIMESTAMPTZ | NOT NULL                     |                      |

- INDEX `(order_id)`

### 3.6 `payments` — 決済

| 列                          | 型          | 制約                             | 説明                                                                   |
| --------------------------- | ----------- | -------------------------------- | ---------------------------------------------------------------------- |
| `id`                        | UUID        | PK                               |                                                                        |
| `order_id`                  | UUID        | NOT NULL, FK → `orders.id`       |                                                                        |
| `provider`                  | TEXT        | NOT NULL                         | 決済事業者識別子                                                       |
| `provider_session_ref`      | TEXT        | NULL                             | 決済セッション参照                                                     |
| `provider_payment_ref`      | TEXT        | NULL                             | 支払参照                                                               |
| `status`                    | TEXT        | NOT NULL                         | `pending` / `succeeded` / `failed` / `refunded` / `partially_refunded` |
| `amount`                    | INTEGER     | NOT NULL                         |                                                                        |
| `currency`                  | CHAR(3)     | NOT NULL                         |                                                                        |
| `amount_refunded`           | INTEGER     | NOT NULL DEFAULT 0, CHECK `>= 0` |                                                                        |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                         |                                                                        |

- `UNIQUE (provider, provider_payment_ref)` （NULL は複数可）
- INDEX `(order_id)`

### 3.7 `webhook_events` — 外部Webhook受信記録（冪等性の要）

| 列               | 型          | 制約     | 説明                                            |
| ---------------- | ----------- | -------- | ----------------------------------------------- |
| `id`             | UUID        | PK       |                                                 |
| `provider`       | TEXT        | NOT NULL | 送信元システム                                  |
| `event_id`       | TEXT        | NOT NULL | 送信元が採番したイベントID                      |
| `event_type`     | TEXT        | NOT NULL |                                                 |
| `received_at`    | TIMESTAMPTZ | NOT NULL |                                                 |
| `processed_at`   | TIMESTAMPTZ | NULL     | 処理完了時刻                                    |
| `status`         | TEXT        | NOT NULL | `received` / `processed` / `ignored` / `failed` |
| `payload_digest` | TEXT        | NOT NULL | 本文のSHA-256。**本文自体は保存しない**（🟡）   |
| `error_summary`  | TEXT        | NULL     | 失敗理由の要約（秘匿値を含めない）              |

- **`UNIQUE (provider, event_id)`** ← ✅ 二重処理防止の中核

🟡 **仮決定:** Webhook 本文（payload）はDBに保存せず、ダイジェストのみ保持する。
理由: 本文には個人情報・カード関連情報が含まれうるため（✅ ログ/DBに個人情報を残さない方針）。
調査は決済事業者側のダッシュボードで行う。

> **処理順序（必ずこの順）:**
>
> 1. 署名検証（失敗 → 400、記録しない）
> 2. `webhook_events` へ INSERT。**一意制約違反 = 既受信 → 即 200 を返して終了**
> 3. 業務処理
> 4. `processed_at` を更新

### 3.8 `entitlements` — 受取権（中核）

| 列                          | 型          | 制約                            | 説明                                         |
| --------------------------- | ----------- | ------------------------------- | -------------------------------------------- |
| `id`                        | UUID        | PK                              |                                              |
| `order_id`                  | UUID        | NOT NULL, FK → `orders.id`      |                                              |
| `order_line_id`             | UUID        | NOT NULL, FK → `order_lines.id` |                                              |
| `artwork_id`                | UUID        | NOT NULL, FK → `artworks.id`    |                                              |
| `account_id`                | UUID        | NOT NULL, FK → `accounts.id`    | **購入者**（Claim照合の基準）                |
| `serial_no`                 | INTEGER     | NOT NULL, CHECK `>= 1`          | 作品内の連番                                 |
| `claim_token_hash`          | TEXT        | NOT NULL                        | Claimトークンのハッシュ                      |
| `status`                    | TEXT        | NOT NULL DEFAULT `'issued'`     | `issued` / `claimed` / `expired` / `revoked` |
| `expires_at`                | TIMESTAMPTZ | NULL                            | Claim 期限                                   |
| `claimed_by_account_id`     | UUID        | NULL, FK → `accounts.id`        | 実際にClaimしたアカウント                    |
| `claimed_at`                | TIMESTAMPTZ | NULL                            |                                              |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                        |                                              |

- **`UNIQUE (artwork_id, serial_no)`** — 同一作品内でシリアル重複なし
- **`UNIQUE (claim_token_hash)`** — トークン衝突を検出
- INDEX `(account_id, status)`, `(order_id)`, `(status, expires_at)`

✅ **事実:** 数量Nの注文に対し、本テーブルに**N行**作成する。

**INV-E1 の実装:** Claim は次の1文で行う。

```sql
UPDATE entitlements
   SET status = 'claimed', claimed_by_account_id = $1, claimed_at = now(), updated_at = now()
 WHERE id = $2 AND status = 'issued'
   AND (expires_at IS NULL OR expires_at > now());
-- 更新行数が 1 のときのみ成功。0 なら既Claim/期限切れ/取消。
```

❓ **未決定 `UD-505`:** Claim の有効期限（無期限か、購入から N日か）。
無期限にすると在庫の観点では問題ないが、未Claim資産が無限に残る。
`expires_at` は NULL 許容とし、**MVPでは NULL（無期限）を入れる**が、これは仮の運用。

### 3.9 `mint_jobs` — 発行ジョブ

| 列                          | 型          | 制約                                         | 説明                                                           |
| --------------------------- | ----------- | -------------------------------------------- | -------------------------------------------------------------- |
| `id`                        | UUID        | PK                                           |                                                                |
| `entitlement_id`            | UUID        | NOT NULL, **UNIQUE**, FK → `entitlements.id` | ✅ 1受取権1ジョブ                                              |
| `status`                    | TEXT        | NOT NULL DEFAULT `'queued'`                  | `queued` / `processing` / `succeeded` / `failed` / `cancelled` |
| `attempt_count`             | INTEGER     | NOT NULL DEFAULT 0, CHECK `>= 0`             |                                                                |
| `max_attempts`              | INTEGER     | NOT NULL DEFAULT 5                           |                                                                |
| `next_attempt_at`           | TIMESTAMPTZ | NOT NULL                                     | バックオフ後の実行予定時刻                                     |
| `locked_at`                 | TIMESTAMPTZ | NULL                                         | `processing` 開始時刻（スタック検出用）                        |
| `idempotency_key`           | TEXT        | NOT NULL, UNIQUE                             | 外部Mint APIへ渡す冪等キー                                     |
| `last_error_code`           | TEXT        | NULL                                         | 秘匿値を含めない                                               |
| `note`                      | TEXT        | NULL                                         | 運用注記（INV-M4）                                             |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                                     |                                                                |

- INDEX `(status, next_attempt_at)` — ワーカーの取得クエリ用

**INV-M1 の実装（排他取得）:**

```sql
UPDATE mint_jobs
   SET status = 'processing', locked_at = now(),
       attempt_count = attempt_count + 1, updated_at = now()
 WHERE id IN (
   SELECT id FROM mint_jobs
    WHERE status = 'queued' AND next_attempt_at <= now()
    ORDER BY next_attempt_at
    FOR UPDATE SKIP LOCKED
    LIMIT $1
 )
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` により、複数ワーカーが同時に走っても同じ行を掴まない。

### 3.10 `nft_tokens` — 発行済みトークン

| 列               | 型          | 制約                                         | 説明                                            |
| ---------------- | ----------- | -------------------------------------------- | ----------------------------------------------- |
| `id`             | UUID        | PK                                           |                                                 |
| `entitlement_id` | UUID        | NOT NULL, **UNIQUE**, FK → `entitlements.id` | ✅ INV-E3                                       |
| `mint_job_id`    | UUID        | NOT NULL, FK → `mint_jobs.id`                |                                                 |
| `chain_ref`      | TEXT        | NOT NULL                                     | チェーン識別子（**値は未確定** `UD-501`）       |
| `contract_ref`   | TEXT        | NOT NULL                                     | コントラクト識別子（**値は未確定**）            |
| `token_ref`      | TEXT        | NOT NULL                                     | トークン識別子                                  |
| `tx_ref`         | TEXT        | NULL                                         | トランザクション参照                            |
| `owner_ref`      | TEXT        | NOT NULL                                     | 所有者参照（**カストディ方式未確定** `UD-502`） |
| `metadata_uri`   | TEXT        | NULL                                         |                                                 |
| `minted_at`      | TIMESTAMPTZ | NOT NULL                                     |                                                 |
| `created_at`     | TIMESTAMPTZ | NOT NULL                                     |                                                 |

- `UNIQUE (chain_ref, contract_ref, token_ref)`
- INDEX `(owner_ref)`

> ⚠️ `chain_ref` / `contract_ref` / `owner_ref` は **TEXT の不透明参照**にしてある。
> チェーン仕様が未決定（[BLOCKCHAIN_DECISION_RECORD.md](./BLOCKCHAIN_DECISION_RECORD.md)）のため、
> EVM 前提の型（`address` の 20バイト等）に固定しない。決定後に制約を追加する。

### 3.11 `outbox_events` — ドメインイベント発行キュー

| 列               | 型          | 制約                         | 説明                               |
| ---------------- | ----------- | ---------------------------- | ---------------------------------- |
| `id`             | UUID        | PK                           |                                    |
| `event_name`     | TEXT        | NOT NULL                     | 例: `order.paid`                   |
| `event_version`  | INTEGER     | NOT NULL DEFAULT 1           |                                    |
| `aggregate_type` | TEXT        | NOT NULL                     |                                    |
| `aggregate_id`   | UUID        | NOT NULL                     |                                    |
| `payload`        | JSONB       | NOT NULL                     | **個人情報を含めない**             |
| `occurred_at`    | TIMESTAMPTZ | NOT NULL                     |                                    |
| `published_at`   | TIMESTAMPTZ | NULL                         |                                    |
| `status`         | TEXT        | NOT NULL DEFAULT `'pending'` | `pending` / `published` / `failed` |
| `attempt_count`  | INTEGER     | NOT NULL DEFAULT 0           |                                    |

- INDEX `(status, occurred_at)`

🟡 **仮決定:** Transactional Outbox を採用する。
業務データの更新と同一トランザクションでイベント行を書き、
別プロセス（worker）が配信する。「支払は確定したが通知が飛ばなかった」を構造的に防ぐ。

### 3.12 `audit_logs` — 監査証跡

| 列                 | 型          | 制約                     | 説明                                       |
| ------------------ | ----------- | ------------------------ | ------------------------------------------ |
| `id`               | UUID        | PK                       |                                            |
| `actor_account_id` | UUID        | NULL, FK → `accounts.id` | NULL はシステム操作                        |
| `action`           | TEXT        | NOT NULL                 | 例: `artwork.publish`                      |
| `target_type`      | TEXT        | NOT NULL                 |                                            |
| `target_id`        | UUID        | NULL                     |                                            |
| `summary`          | JSONB       | NOT NULL                 | 変更前後の**業務値のみ**。秘匿値を含めない |
| `occurred_at`      | TIMESTAMPTZ | NOT NULL                 |                                            |

- INDEX `(target_type, target_id, occurred_at DESC)`, `(actor_account_id, occurred_at DESC)`

---

## 4. 冪等性を担保する制約の一覧

| #   | 制約                                                    | 防ぐ事故                                 |
| --- | ------------------------------------------------------- | ---------------------------------------- |
| 1   | `webhook_events UNIQUE(provider, event_id)`             | 同一Webhookの二重処理                    |
| 2   | `orders UNIQUE(account_id, idempotency_key)`            | 二重注文                                 |
| 3   | `entitlements UNIQUE(artwork_id, serial_no)`            | シリアル重複発行                         |
| 4   | `mint_jobs UNIQUE(entitlement_id)`                      | 1受取権に対する複数ジョブ                |
| 5   | `mint_jobs UNIQUE(idempotency_key)`                     | 外部への重複依頼                         |
| 6   | `nft_tokens UNIQUE(entitlement_id)`                     | **1受取権からの複数Mint**（✅ 必須要件） |
| 7   | `nft_tokens UNIQUE(chain_ref, contract_ref, token_ref)` | 同一トークンの二重登録                   |
| 8   | `artworks CHECK(reserved + issued <= max_supply)`       | オーバーセル                             |

✅ **事実:** 「1つの受取権から複数Mintできない設計」は **#4 と #6 の UNIQUE 制約**で
物理的に担保される。アプリのロジックだけに依存しない。

---

## 5. マイグレーション方針

🟡 **仮決定:**

- 破壊的変更（列削除・型変更）は **expand → migrate → contract** の3段階で行う。
- 本番へのマイグレーション適用は CI からは行わず、**明示的な手動ステップ**とする。
  理由: NFT の発行記録は再現不能な資産であり、自動適用の事故コストが高すぎる。
- Prisma migration ファイルは `packages/database/prisma/migrations/` にコミットする。

✅ **事実:** Phase 1 ではマイグレーションを生成・適用しない（`prisma generate` のみ）。

---

## 6. 本文書の未決定事項

| ID     | 概要                                   |
| ------ | -------------------------------------- |
| UD-503 | メールアドレスを本システムで保持するか |
| UD-504 | ゲスト購入（未ログイン購入）の可否     |
| UD-505 | Claim の有効期限                       |

（`UD-501` `UD-502` は [BLOCKCHAIN_DECISION_RECORD.md](./BLOCKCHAIN_DECISION_RECORD.md) 由来）
