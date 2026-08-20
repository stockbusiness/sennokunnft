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

| 列                          | 型          | 制約                        | 説明                                                                                                                                                                                                                   |
| --------------------------- | ----------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | UUID        | PK                          | 内部ID                                                                                                                                                                                                                 |
| `auth_provider`             | TEXT        | NOT NULL                    | 認証プロバイダ識別子（例: `supabase`）                                                                                                                                                                                 |
| `auth_subject`              | TEXT        | NOT NULL                    | プロバイダ側のユーザーID（Supabase の `sub`）                                                                                                                                                                          |
| `email_hash`                | TEXT        | NULL                        | 照合用のメール値。**平文メールは保持しない**（🟡 `UD-503`）。⚠️ **素のハッシュではなく鍵付き HMAC**（`EMAIL_LOOKUP_PEPPER`）。素だと、よくあるアドレスを並べた表で元に戻せる。鍵の無い配備では NULL のまま（`UD-121`） |
| `display_name`              | TEXT        | NULL                        | **作品ページに出すお名前**（決定 2026-08-20）。屋号・ペンネーム可。本名は求めない。⚠️ **表示は打たれたまま**（正規化した形を出さない）                                                                                 |
| `display_name_key`          | TEXT        | NULL                        | 重複判定の鍵。`NFKC` 正規化 → 小文字化 → 空白除去。⚠️ **生成はアプリ側**（`domain` の `displayNameKey`）。DB の `lower()` は NFKC 正規化をしないので、DB 側で作り直すとアプリと結果がずれる                            |
| `role`                      | TEXT        | NOT NULL DEFAULT `'buyer'`  | `buyer` / `operator` / `auditor`                                                                                                                                                                                       |
| `status`                    | TEXT        | NOT NULL DEFAULT `'active'` | `active` / `suspended`                                                                                                                                                                                                 |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                    |                                                                                                                                                                                                                        |

- `UNIQUE (auth_provider, auth_subject)`
- 部分 UNIQUE `accounts_display_name_key_unique` … `display_name_key` が NULL でない行のみ
- CHECK `accounts_display_name_paired` … `display_name` と `display_name_key` は必ず対で入る

#### 表示名の重複（決定 2026-08-20「屋号・ペンネームを許す／重複を許さない」）

⚠️ **UNIQUE を張るのは生の `display_name` ではなく `display_name_key`。**
生の文字列で張ると、全角と半角（`Ａ工房` / `A工房`）、大文字と小文字
（`Taro` / `TARO`）、空白の有無（`戦国 太郎` / `戦国太郎`）を変えるだけで、
**同じに見える別の名前**を名乗れる。買う人には見分けが付かないので、
実質のなりすましになる。

⚠️ **そろえすぎない。** カタカナとひらがな、漢字の異体字はまとめない。
まとめると別人が「使われています」で弾かれ、**弾かれた側は自分では直せない**。

⚠️ **部分索引にする。** 買う人のほとんどは表示名を持たない。

⚠️ **運営に他人の表示名を書き換える口を作らない。** なりすましへの対応は、
名前の差し替えではなく**アカウントの停止**（`status`）で行う。書き換えの口を
作ると、そこが乗っ取りの的になる。

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

| 列                          | 型          | 制約                             | 説明                                                                          |
| --------------------------- | ----------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `id`                        | UUID        | PK                               |                                                                               |
| `order_number`              | TEXT        | NOT NULL, UNIQUE                 | 人が読み上げる番号。**参照の正は `id`**                                       |
| `account_id`                | UUID        | NOT NULL, FK → `accounts.id`     | 購入者                                                                        |
| `common_user_id`            | TEXT        | NULL                             | 共通顧客ID。解決できていない購入者があるため NULL 可                          |
| `creator_account_id`        | UUID        | NOT NULL, FK → `accounts.id`     | 出品者。**1 注文 1 クリエイター**                                             |
| `status`                    | TEXT        | NOT NULL                         | `pending` / `checkout_created` / `paid` / `expired` / `cancelled`             |
| `payment_status`            | TEXT        | NOT NULL                         | `not_started` / `pending` / `succeeded` / `failed` / `cancelled` / `refunded` |
| `fulfillment_status`        | TEXT        | NOT NULL                         | `not_started` / `processing` / `fulfilled` / `failed`                         |
| `refund_status`             | TEXT        | NOT NULL                         | `none` / `pending` / `partially_refunded` / `refunded` / `failed`             |
| `subtotal_amount`           | INTEGER     | NOT NULL, CHECK `>= 0`           | 単価 × 数量                                                                   |
| `discount_amount`           | INTEGER     | NOT NULL DEFAULT 0               | 今回は常に 0。列と計算だけ先に用意                                            |
| `total_amount`              | INTEGER     | NOT NULL, CHECK `>= 0`           | `subtotal - discount` と一致（CHECK）                                         |
| `total_currency`            | CHAR(3)     | NOT NULL                         |                                                                               |
| `platform_fee_rate_bps`     | INTEGER     | NOT NULL DEFAULT 0               | 注文時点の手数料率。**bps の整数**（0〜10000）                                |
| `platform_fee_amount`       | INTEGER     | NOT NULL DEFAULT 0               |                                                                               |
| `creator_amount`            | INTEGER     | NOT NULL                         | `total - platform_fee` と一致（CHECK）                                        |
| `idempotency_key`           | TEXT        | NOT NULL                         | 注文作成の冪等キー                                                            |
| `reserved_until`            | TIMESTAMPTZ | NULL                             | 仮引当の期限                                                                  |
| `paid_at`                   | TIMESTAMPTZ | NULL                             |                                                                               |
| `issuance_attempt_count`    | INTEGER     | NOT NULL DEFAULT 0, CHECK `>= 0` | 受取権の発行を試した回数（P0-1）                                              |
| `issuance_next_attempt_at`  | TIMESTAMPTZ | NULL                             | 次に試してよい時刻。`NULL` は「まだ一度も失敗していない」                     |
| `issuance_last_error`       | TEXT        | NULL                             | ⚠️ **応答本文を入れない。** こちらで決めた短い符号だけ                        |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                         |                                                                               |

- `UNIQUE (account_id, idempotency_key)` — 同一利用者の二重注文を防ぐ
- `UNIQUE (order_number)`
- CHECK `orders_total_matches_subtotal` / `orders_split_matches_total`
- CHECK `orders_fee_rate_range`（0〜10000）/ `orders_amounts_non_negative`
- CHECK `orders_paid_has_time` — 決済成功・`paid` なら `paid_at` が入る
- INDEX `(status, reserved_until)` — 期限切れ回収ワーカー用
- INDEX `(account_id, created_at DESC)` / `(creator_account_id, created_at DESC)`
- INDEX `(payment_status, created_at DESC)`
- 部分 INDEX `(issuance_next_attempt_at, paid_at) WHERE payment_status = 'succeeded' AND fulfillment_status <> 'fulfilled'` — 受取権の発行の掃き出し用

⚠️ **`issuance_*` は「何回試したか」だけで、「何をすべきか」ではない**（P0-1）。
作るべき受取権の枚数は、注文明細の数量と `entitlements` の実物から導く。
**これらの列が消えても、作るべき枚数は変わらない。** 待ち行列の表を別に作って
いないのは、行を足す方式だと「入れ忘れ」「行だけ残る」という実物と食い違う
壊れ方が増えるため。

⚠️ **状態を 4 本に分けてある（決済 Phase P0・指示書 §7）。**
1 本に詰めると「決済は成功したが付与に失敗した」を表せない。
表せない状態が起きたとき、その行は必ずどちらかの嘘になる。

⚠️ **`failed` / `refunded` は新しい注文では使わない。** 列挙型の値としては
過去の行のために残してあるが、決済の失敗は `payment_status`、返金は
`refund_status` が持つ。新しい注文がそこへ遷移しないことは、
ドメインの遷移表（`packages/domain/src/order/order-status.ts`）が守る。

⚠️ **手数料率を小数で持たない。** 率を金額に掛けた瞬間に誤差が入る。
10% は `1000`。配分額は `total - platform_fee` の**引き算**で出す。
それぞれ独立に計算すると、丸めの向き次第で合計が合わなくなる。

❓ **未決定 `UD-109` / `UD-114`:** 手数料率と、決済会社の手数料の負担者。
既定 0 は「まだ決めていない」であって決定ではない。

✅ **事実:** 購入者は**ログイン必須**（Claim時の本人照合に必要なため `account_id` は NOT NULL）。

❓ **未決定 `UD-504`:** ゲスト購入（未ログイン購入）を許すか。
許す場合、Claim 時の本人照合をメール到達性で代替する設計が必要になり、
セキュリティ前提が変わる。現設計は**ログイン必須**を前提にしている。

### 3.5 `order_lines` — 注文明細

| 列                       | 型          | 制約                         | 説明                   |
| ------------------------ | ----------- | ---------------------------- | ---------------------- |
| `id`                     | UUID        | PK                           |                        |
| `order_id`               | UUID        | NOT NULL, FK → `orders.id`   |                        |
| `listing_id`             | UUID        | NOT NULL, FK → `listings.id` | 参照用                 |
| `artwork_id`             | UUID        | NOT NULL, FK → `artworks.id` | 参照用                 |
| `artwork_title_snapshot` | TEXT        | NOT NULL                     | **注文時点の作品名**   |
| `creator_name_snapshot`  | TEXT        | NULL                         | **注文時点の出品者名** |
| `unit_price_amount`      | INTEGER     | NOT NULL                     | **注文時点の単価**     |
| `unit_price_currency`    | CHAR(3)     | NOT NULL                     |                        |
| `creator_account_id`     | UUID        | NOT NULL, FK → `accounts.id` | **注文時点の出品者**   |
| `quantity`               | INTEGER     | NOT NULL, CHECK `>= 1`       |                        |
| `total_amount`           | INTEGER     | NOT NULL                     | `単価 × 数量`（CHECK） |
| `created_at`             | TIMESTAMPTZ | NOT NULL                     |                        |

- `UNIQUE (order_id)` — `order_lines_single_item_per_order`

⚠️ **`creator_name_snapshot` は NULL を許す。** 列を足す前の注文と、
表示名を登録していない方から買った注文があるため。**推測で埋めない** ——
埋めると、当時の画面に出ていなかった名前を「出ていた」ことにしてしまう。
画面は NULL の行を、出品者名の行ごと出さないことで扱う。

⚠️ **マスタ（`accounts.display_name`）を引き直して表示しない。** 出品者が
改名しても、お買い上げの記録は当時の表示のまま残す（スナップショット原則）。

⚠️ **MVP は 1 注文 1 明細**（指示書 §5.2）。`order_id` だけの UNIQUE が
「明細は 1 本まで」を DB に守らせる。複数クリエイターのカートを作らせない
ための最後の砦で、将来グッズで複数明細を許すときは、この制約を外す
1 行の移行で済む。

### 3.5-2 `inventory_reservations` — 在庫の仮引当

| 列                          | 型          | 制約                         | 説明                                 |
| --------------------------- | ----------- | ---------------------------- | ------------------------------------ |
| `id`                        | UUID        | PK                           |                                      |
| `order_id`                  | UUID        | NOT NULL, FK → `orders.id`   |                                      |
| `listing_id`                | UUID        | NOT NULL, FK → `listings.id` |                                      |
| `artwork_id`                | UUID        | NOT NULL, FK → `artworks.id` |                                      |
| `quantity`                  | INTEGER     | NOT NULL, CHECK `> 0`        |                                      |
| `status`                    | TEXT        | NOT NULL                     | `reserved` / `consumed` / `released` |
| `expires_at`                | TIMESTAMPTZ | NOT NULL                     |                                      |
| `consumed_at`               | TIMESTAMPTZ | NULL                         |                                      |
| `released_at`               | TIMESTAMPTZ | NULL                         |                                      |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                     |                                      |

- 部分 UNIQUE `inventory_reservations_one_active_per_order`
  （`(order_id) WHERE status = 'reserved'`）
- INDEX `(status, expires_at)` — 期限切れの掃き出し用
- 外部キーはすべて `ON DELETE RESTRICT`（注文・決済データを物理削除させない）

⚠️ **押さえを注文の列（期限だけ）で表さず、行にしてある。** 列だと
「解放したか」を注文の状態から推測することになり、二重解放と解放漏れの
どちらも静かに起こる。行にして状態を持たせると、解放は
「`reserved` の行を `released` にする」という**1 回しか成立しない操作**になる。

⚠️ **部分 UNIQUE は Prisma のスキーマで表せない。** 手書きの
マイグレーション側にだけ存在する。消さないこと。

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
| `provider_charge_ref`       | TEXT        | NULL                             | 課金参照（Phase P2 で埋める）                                          |
| `provider_idempotency_key`  | TEXT        | NULL                             | 決済事業者へ渡す冪等キー。**業務の冪等キーとは別物**                   |
| `paid_at`                   | TIMESTAMPTZ | NULL                             |                                                                        |
| `failure_code`              | TEXT        | NULL                             |                                                                        |
| `failure_message_safe`      | TEXT        | NULL                             | ⚠️ 外部の応答本文をそのまま入れない。短い要約だけ                      |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                         |                                                                        |

- `UNIQUE (provider, provider_payment_ref)` （NULL は複数可）
- CHECK `payments_succeeded_has_time` — `succeeded` なら `paid_at` が入る
- INDEX `(order_id)`

✅ **決済 Phase P2 で書き込む経路ができた。** 支払い口を作るときに 1 行、
決済事業者からの通知で状態が進む。管理画面から成功状態にする API は
作っていない（指示書 §9.3）。決済の確定は Webhook だけが行う。

追加の制約（決済 Phase P2）:

- `payments_one_succeeded_per_order`（部分 UNIQUE、`WHERE status='succeeded'`）
  — **1 注文に成功は 1 件だけ**。2 件あると、二重に受け取ったのか
  記録の誤りなのか区別できない。
- `payments_provider_session_ref_key` / `payments_provider_charge_ref_key`
  （部分 UNIQUE）— 事業者の識別子は、値があるときだけ一意。
- `payments_provider_idempotency_key_key`（部分 UNIQUE）
  — 同じ冪等キーで 2 行作らない。

⚠️ **試行ごとに 1 行を作り、消さない**（決済 Phase P2 の決定 B）。
決済の失敗は「何回目で、何が起きたか」を後から説明できないと、
問い合わせに答えられない。上書きすると履歴が消える。

⚠️ **部分 UNIQUE は Prisma のスキーマで表せない。** 手書きの
マイグレーション側にだけ存在する。消さないこと。

### 3.7-2 在庫カウンタの意味（決済 Phase P2 の決定 A）

⚠️ **決済が成功しても、在庫のカウンタは動かさない。**

| 場面                 | `reserved_count` | `issued_count` | 予約の状態   |
| -------------------- | ---------------- | -------------- | ------------ |
| 注文の作成           | +1               | —              | `reserved`   |
| **決済の成功（P2）** | **そのまま**     | **そのまま**   | `consumed`   |
| 受取権の発行（P3）   | −1               | +1             | （変えない） |
| 期限切れ・取消       | −1               | —              | `released`   |

`issued_count` は「受取権を**実際に発行した**数」であって「売れた数」では
ない。`entitlements` の行数と一致させる。

**なぜ決済成功で `reserved_count` を減らさないか。** 減らすと、受取権を
作る前のわずかな間だけ販売枠が復活する。その隙に他の人が買うと、
売れた注文の発行が上限（`artworks_supply_within_max`）で弾かれる。
お金は受け取ったのに商品を渡せない、という最悪の形になる。

**なぜ決済成功で `issued_count` を増やさないか。** シリアル番号の採番
（`allocateSerialNumbers`）が `issued_count` を見るため、先に増やすと
番号がずれる。また `entitlements` の行数と食い違い、監査で追えなくなる。

⚠️ **`finalizeConsumedReservation()` を決済成功の経路から呼ばない。**
呼んでよいのは、受取権を作るのと同じトランザクションの中だけ。
名前を `commitReservation` から変えたのは、「決済の確定」と読めて
そこから呼ばれかけたため。

### 3.7 `webhook_events` — 外部Webhook受信記録（冪等性の要）

決済 Phase P2 で列を足した: `api_version` / `livemode` / `attempt_count` /
`order_id` / `payment_id` / `last_error_code`。

⚠️ **新しい表を作らず、既存を広げた。** `(provider, event_id)` の UNIQUE が
二重処理を止める仕掛けとして既にここに入っている。もう 1 つ表を作ると、
どちらが正か分からなくなる。

⚠️ **本文の全体を保存しない**（指示書 §10）。残すのは `payload_digest` だけ。
カード情報・個人情報・秘密が混ざる余地を作らない。

⚠️ **`livemode` を見ないと、試験の通知で本番の注文が確定する。**
Webhook の宛先は URL だけで決まるので、試験用の送信先を本番へ向けてしまう
事故が起こりうる。

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
| `unit_index`                | INTEGER     | NOT NULL, CHECK `>= 0`          | **注文明細の中での連番**（0 始まり）         |
| `claim_token_hash`          | TEXT        | NOT NULL                        | Claimトークンのハッシュ                      |
| `status`                    | TEXT        | NOT NULL DEFAULT `'issued'`     | `issued` / `claimed` / `expired` / `revoked` |
| `expires_at`                | TIMESTAMPTZ | NULL                            | Claim 期限                                   |
| `claimed_by_account_id`     | UUID        | NULL, FK → `accounts.id`        | 実際にClaimしたアカウント                    |
| `claimed_at`                | TIMESTAMPTZ | NULL                            |                                              |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL                        |                                              |

- **`UNIQUE (artwork_id, serial_no)`** — 同一作品内でシリアル重複なし
- **`UNIQUE (order_line_id, unit_index)`** — `entitlements_line_unit_unique`
- **`UNIQUE (claim_token_hash)`** — トークン衝突を検出
- INDEX `(account_id, status)`, `(order_id)`, `(status, expires_at)`

✅ **事実:** 数量Nの注文に対し、本テーブルに**N行**作成する。

#### 発行の冪等（P0-1・2026-08-20）

⚠️ **`UNIQUE (order_line_id, unit_index)` が二重発行の最終防壁。** 決済事業者は
同じ知らせを何度でも送る。アプリ側の「もう作ったか」の判定だけに頼ると、
**同時に 2 本走ったときに両方が「まだ」と読んで両方作る**——判定と作成のあいだに
隙間があるため。

⚠️ **`serial_no` では代われない。** あちらは作品の中の通し番号で、「この注文明細の
何枚目か」を表さない。**途中で落ちた発行を再開するとき、何枚目まで作れているかを
数えられるのは `unit_index` のほう**である。

⚠️ **発行の待ち行列を別の表にしていない。** 「決済が済んでいるのに受取権が足りない
注文」は、注文と受取権から必ず導ける。行を足す方式にすると「行の入れ忘れ」
「行だけ残る」という実物と食い違う壊れ方が新しく増える。試行回数だけを
`orders.issuance_*` に置いてある（下記）。

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

### 3.13 `idempotency_keys` — 冪等キーの占有

✅ **事実:** 保存先はプロセス内メモリではなく DB。
メモリだと台数を増やした瞬間に効かなくなり、しかもその事実が外からは見えない。

| 列                 | 型          | 制約                                   | 説明                                     |
| ------------------ | ----------- | -------------------------------------- | ---------------------------------------- |
| `id`               | UUID        | PK                                     |                                          |
| `actor_account_id` | UUID        | NOT NULL, FK → `accounts.id` (CASCADE) | **アクターごとに区切る**（下記）         |
| `key`              | TEXT        | NOT NULL                               | クライアント指定の `Idempotency-Key`     |
| `request_digest`   | TEXT        | NOT NULL                               | 内容のハッシュ。**値そのものは持たない** |
| `status`           | TEXT        | NOT NULL, CHECK                        | `in_progress` / `completed`              |
| `status_code`      | INTEGER     | NULL                                   | `completed` のときのみ                   |
| `response_body`    | JSONB       | NULL                                   | `completed` のときのみ                   |
| `created_at`       | TIMESTAMPTZ | NOT NULL                               | 呼び出し側の時計から入れる（下記）       |
| `completed_at`     | TIMESTAMPTZ | NULL                                   |                                          |
| `expires_at`       | TIMESTAMPTZ | NOT NULL                               | 既定 24 時間。過ぎたキーは未使用扱い     |

- UNIQUE `(actor_account_id, key)` … **占有はこの制約が決める**
- INDEX `(expires_at)`
- CHECK `idempotency_keys_status_known` … 状態は 2 値のみ
- CHECK `idempotency_keys_completed_has_response` … `completed` なら応答が揃っていること
- CHECK `idempotency_keys_expires_after_creation` … 期限は作成時より後

⚠️ **アクターごとに区切る理由:** 区切らないと、他人が使ったキーを当てることで
その応答（＝他人のデータ）を読み出せてしまう。

⚠️ **`created_at` を DB の `now()` 既定に任せない理由:** `expires_at` は
呼び出し側の時計から作られる。`created_at` を DB の時計にすると、
別々の時計で書かれた 2 つの時刻が同じ行に並び、
両者を比べる CHECK が意味のない比較になる。

---

## 4. 冪等性を担保する制約の一覧

| #   | 制約                                                     | 防ぐ事故                                 |
| --- | -------------------------------------------------------- | ---------------------------------------- |
| 1   | `webhook_events UNIQUE(provider, event_id)`              | 同一Webhookの二重処理                    |
| 2   | `orders UNIQUE(account_id, idempotency_key)`             | 二重注文                                 |
| 3   | `entitlements UNIQUE(artwork_id, serial_no)`             | シリアル重複発行                         |
| 4   | `mint_jobs UNIQUE(entitlement_id)`                       | 1受取権に対する複数ジョブ                |
| 5   | `mint_jobs UNIQUE(idempotency_key)`                      | 外部への重複依頼                         |
| 6   | `nft_tokens UNIQUE(entitlement_id)`                      | **1受取権からの複数Mint**（✅ 必須要件） |
| 7   | `nft_tokens UNIQUE(chain_ref, contract_ref, token_ref)`  | 同一トークンの二重登録                   |
| 8   | `artworks CHECK(reserved + issued <= max_supply)`        | オーバーセル                             |
| 9   | `idempotency_keys UNIQUE(actor_account_id, key)`         | 同一操作の二重実行（占有はこれが決める） |
| 10  | `listings 部分UNIQUE(artwork_id) WHERE 有効`             | 同一作品に有効な出品が複数               |
| 11  | トリガ `listings_require_published_artwork`              | 非公開作品への出品作成                   |
| 12  | トリガ `artworks_no_effective_listings_when_unpublished` | **非公開なのに販売中の出品が残る**       |

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
