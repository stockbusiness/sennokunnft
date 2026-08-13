# 千ノ国NFTマーケット

千ノ国プロジェクト向けの NFT 一次販売マーケット。

**現在の状態: Phase 0（設計）・Phase 1（開発基盤）・Phase 2（カタログ）が完了。**
決済・Claim・ブロックチェーン Mint は**まだ実装されていない**。

---

## 1. これは何か / まだ何ではないか

| 実装済み                                                      | 未実装                           |
| ------------------------------------------------------------- | -------------------------------- |
| モノレポ基盤（pnpm + Turborepo）                              | 決済連携                         |
| ドメイン層（状態遷移・不変条件・ポート定義）                  | 注文・受取権の発行               |
| **作品の登録・公開、出品の作成・販売開始（管理API）**         | Claim フロー                     |
| **公開カタログ API と画面（一覧・詳細）**                     | ブロックチェーン Mint            |
| **マイグレーション（CHECK 21 個・トリガ・部分ユニーク索引）** | 画面からの登録フォーム ※ Phase 4 |
| **認可ガード（既定 deny）と権限マトリクス**                   | —                                |
| **画像アップロード（中身で形式判定・SVG 拒否）**              | —                                |
| **管理画面（作品・販売の一覧と詳細）**                        | —                                |
| 環境変数の型検証、構造化ログ                                  | —                                |
| API ヘルスチェック、Worker の器                               | —                                |
| テスト基盤（Vitest / Playwright）、CI                         | —                                |

> 管理画面は一覧・詳細の閲覧までを実装している。
> 登録・編集の**フォーム**は Phase 4（認証連携）へ送る。
> 押せるが何も起きないボタンを置かないため、現時点では API の手順を画面に案内している。

> ⚠️ **ブロックチェーン仕様は何も決まっていない。**
> チェーン・カストディ・トークン規格・鍵管理はいずれも未決定であり、
> 本コードは**それらを推測で確定していない**。
> 詳細は [docs/BLOCKCHAIN_DECISION_RECORD.md](./docs/BLOCKCHAIN_DECISION_RECORD.md)。

> ⚠️ **外部サービスへ接続しない。**
> 決済・発行プロバイダは `fake` 実装のみで、`fake` 以外を設定すると**起動を拒否する**。

---

## 2. 開発環境の構築

### 2.1 前提

| ツール     | バージョン | 備考                                                       |
| ---------- | ---------- | ---------------------------------------------------------- |
| Node.js    | 22.12 以上 | `.nvmrc` で固定。`nvm use` で切り替えられる                |
| pnpm       | 9.15.4     | `corepack enable pnpm` で有効化できる                      |
| PostgreSQL | 16 系      | 結合テストとローカル実行に必要（無くても単体テストは動く） |

```bash
# Node のバージョンを合わせる
nvm use

# pnpm を有効化する（同梱の Corepack を使う場合）
corepack enable pnpm
```

### 2.2 セットアップ

```bash
# 1. 依存を導入する
pnpm install

# 2. 環境変数のテンプレートをコピーする
cp .env.example .env

# 3. .env を編集する
#    Phase 1 で必須なのは DATABASE_URL のみ（接続はしないが、値の存在を検証する）
#    例: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sengoku_nft

# 4. Prisma Client を生成する（DB への接続は不要）
pnpm db:generate

# 5. スキーマを DB に適用する（PostgreSQL がある場合）
pnpm db:migrate:deploy

# 6. すべての検査を実行する
pnpm verify
```

開発用のデータを入れるには、次を実行する（本番では実行できない）。

```bash
pnpm db:seed
```

結合テストを動かすには `TEST_DATABASE_URL` を設定する。

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sennokunnft_test pnpm test
```

未設定なら結合テストはスキップされる。
ただし CI では `REQUIRE_INTEGRATION_TESTS=1` を立てており、
**設定漏れは「スキップ」ではなく「失敗」になる**。黙って飛ばすと
「制約は効いているはず」という誤った安心を生むため。

> `.env` はコミットされない。`.env.example` には**変数名と説明のみ**を書く。
> 値を書き込むと `pnpm check:secrets` が失敗する。

### 2.3 各プロセスの起動

3 つのプロセスは**それぞれ独立に**起動できる。

```bash
# 画面（http://localhost:3000）
pnpm dev:web

# API（http://localhost:3001）
pnpm dev:api

# 非同期ワーカー（常駐）
pnpm dev:worker
```

ワーカーは 1 回だけ実行して終了させることもできる。
デプロイ先が常駐プロセスを許すか未決定（UD-302）のため、
cron 起動の環境でも動くようにしてある。

```bash
pnpm --filter @sengoku/worker run build
pnpm --filter @sengoku/worker run start:once
```

### 2.4 動作確認

```bash
# API のヘルスチェック
curl http://localhost:3001/healthz
# => {"status":"ok","service":"api","version":"0.1.0","uptimeSec":0}

curl http://localhost:3001/readyz
# => {"status":"ok","service":"api","checks":[]}
```

---

## 3. よく使うコマンド

| コマンド                 | 内容                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `pnpm verify`            | **CI と同じ検査を全部**（秘密検査 → 依存検査 → lint → typecheck → test → build） |
| `pnpm lint`              | ESLint                                                                           |
| `pnpm typecheck`         | 型検査（`tsc --noEmit`）                                                         |
| `pnpm test`              | 単体テスト（Vitest）                                                             |
| `pnpm build`             | 全パッケージ・全アプリのビルド                                                   |
| `pnpm e2e`               | E2E スモーク（Playwright。事前に `pnpm build` が必要）                           |
| `pnpm check:deps`        | 依存の循環・層越えの検査                                                         |
| `pnpm check:docs`        | 未決定事項レジスタの整合性検査（件数・重複・未登録ID）                           |
| `pnpm check:secrets`     | 秘密情報の混入検査                                                               |
| `pnpm db:generate`       | Prisma Client の生成                                                             |
| `pnpm db:migrate:deploy` | 生成済みマイグレーションの適用（本番と同じ経路）                                 |
| `pnpm db:migrate:dev`    | スキーマ変更からマイグレーションを生成                                           |
| `pnpm format`            | Prettier で整形                                                                  |

> CI にしか無い検査は作っていない。CI が実行するのは `pnpm verify` と
> `pnpm format:check`、`pnpm db:generate`、E2E のみで、すべて手元で同じように動く。

### E2E をローカルで動かすとき

```bash
pnpm build
pnpm --filter @sengoku/web run e2e:install   # 初回のみブラウザを取得

# API を起動せず、画面だけを検証する（API 障害時の挙動を確認できる）
pnpm e2e

# 実 API・実 DB に対する通しシナリオも実行する
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sennokunnft_e2e pnpm db:migrate:deploy
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sennokunnft_e2e pnpm db:seed
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sennokunnft_e2e pnpm e2e
```

`DATABASE_URL` の有無で起動する構成が変わる。
API を立てない場合は「API が落ちているときの画面」を、立てる場合は
「登録 → 公開 → 出品 → 閲覧」の通しシナリオを検証する。

ブラウザが既に配置されている実行環境では、バージョン不一致で起動できないことがある。
その場合は実行ファイルを直接指定する。

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm e2e
```

---

## 4. パッケージ構成と責務

依存は**内向きのみ**。`domain` は他のどのパッケージにも依存しない。
この向きは `pnpm check:deps` が機械的に検査する（循環だけでなく層越えも検出する）。

```
config ──────┬──────────────────────────────┐
             │                              │
validation ──┼──▶ domain ──┬──▶ contracts ──┤
             │             │                │
observability┤             ├──▶ database ───┤
             │             ├──▶ auth ───────┤
             │             └──▶ integrations┤
             │                              │
ui ──────────┴──────────────────────────────┤
                                            ▼
                              apps/web, apps/api, apps/worker
```

### アプリケーション

| パッケージ    | 責務                                   | 責務ではないもの                  |
| ------------- | -------------------------------------- | --------------------------------- |
| `apps/web`    | 画面、ルーティング、BFF                | 業務判断（`domain` に依存しない） |
| `apps/api`    | HTTP 境界、認可の適用、DTO 変換        | 業務規則そのもの                  |
| `apps/worker` | 非同期ジョブ、再試行、スケジューリング | HTTP                              |

### 共有パッケージ

| パッケージ               | 責務                                                                        | 責務ではないもの                         |
| ------------------------ | --------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/config`        | 環境変数スキーマと型検証、共通 tsconfig / ESLint / Prettier、検査スクリプト | 業務ロジック                             |
| `packages/validation`    | zod ベースの共通検証部品                                                    | 業務規則（「在庫があるか」は判定しない） |
| `packages/domain`        | 集約・状態遷移・不変条件・**ポート定義**                                    | フレームワーク、DB、HTTP、外部SDK        |
| `packages/contracts`     | API DTO とイベントのスキーマ・バージョン                                    | 業務判断、通信の実行                     |
| `packages/database`      | Prisma スキーマ、Client 生成、リポジトリ実装                                | 業務判断、HTTP                           |
| `packages/auth`          | トークン検証ポート、ロール、**認可判定の純粋関数**                          | 資格情報の管理（Supabase Auth の責務）   |
| `packages/integrations`  | 外部サービスのアダプタ（**Phase 1 は Fake のみ**）                          | 業務判断、HTTP ルーティング              |
| `packages/observability` | 構造化ログ、相関ID、秘匿値の自動マスキング                                  | 業務知識                                 |
| `packages/ui`            | 状態を持たない React 部品                                                   | API 呼び出し、業務判断、認可             |

> ⚠️ **`packages/contracts` は「スマートコントラクト」ではない。**
> システム間の契約（API DTO・イベントスキーマ）を置く場所である。

---

## 5. 設計の中心にあるもの

この設計で最も重視しているのは、**取り返しのつかない事故を構造で防ぐ**こと。

### 5.1 「1つの受取権から複数 Mint できない」を 4 層で担保する

数量 N の注文は、N 個の**受取権（Entitlement）**を生む。
受取権 1 個から発行されるトークンは高々 1 つ。これを次の 4 層で守る。

| 層  | 手段                                                                           |
| --- | ------------------------------------------------------------------------------ |
| 1   | `mint_jobs` の `UNIQUE(entitlement_id)` — ジョブが 1 つしか作られない          |
| 2   | `FOR UPDATE SKIP LOCKED` + 条件付き UPDATE — 同じジョブを 2 ワーカーが掴まない |
| 3   | `nft_tokens` の `UNIQUE(entitlement_id)` — 万一 2 回実行されても記録は 1 件    |
| 4   | 受取権IDから導出する決定論的な冪等キー — 外部 API 側でも重複を弾ける           |

**アプリの `if` 文には依存していない。** 競合状態では読み取り後の判定は破れるが、
DB の制約は破れないため。

### 5.2 画像は「中身」で判定する

拡張子とクライアントが申告した `Content-Type` は**判定に使わない**。
先頭バイト（マジックナンバー）で形式を決める。
拡張子で判定すると、`.png` という名前の HTML や実行ファイルを保存してしまう。

**SVG は受け付けない。** SVG は XML でスクリプトを含められるため、
同一オリジンで配信すると保存型 XSS になる。

保存キーは CSPRNG で生成し、**利用者が送ったファイル名は使わない**。

### 5.3 説明文に HTML を保存しない

「保存してから表示時にエスケープする」方式は、どこか 1 箇所で
エスケープを忘れた瞬間に保存型 XSS になる。
そもそも入れさせなければ、表示側の実装に関係なく安全になる。

### 5.4 決済確定は Webhook のみ

成功画面への到達を決済完了とみなす経路は存在しない。
状態遷移表（`packages/domain/src/state/machines.ts`）に、
その遷移自体を書いていない。

### 5.5 秘匿値は仕組みでマスクする

ログは全行が `redact()` を通る。キー名のパターンで判定し、入れ子も配列も再帰的に伏せる。
「開発時だけ詳細ログ」という抜け道を作っていないのは、
環境差で設定ミスが本番に適用されるのを防ぐため。

### 5.6 未決定を推測で埋めない

チェーン関連の識別子は、DB でもイベント契約でも**不透明な文字列**にしてある。
EVM のアドレス形式などに型を固定すると、決定前に選択肢を狭めてしまう。

---

## 6. ドキュメント

設計文書は [`docs/`](./docs/) にある。索引は [docs/README.md](./docs/README.md)。

各文書は記述を **✅事実 / 🟡仮決定 / ❓未決定** の 3 分類で明示的に分けている。
**未決定事項（46 件）のマスタ一覧**は
[docs/IMPLEMENTATION_ROADMAP.md](./docs/IMPLEMENTATION_ROADMAP.md) の「未決定事項レジスタ」。

とくに先に読むとよいもの:

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 依存の向きとパッケージ責務
- [DOMAIN_MODEL.md](./docs/DOMAIN_MODEL.md) — 受取権を中核に据えたモデル
- [LAZY_MINT_FLOW.md](./docs/LAZY_MINT_FLOW.md) — 購入から発行までの詳細と失敗時の挙動
- [BLOCKCHAIN_DECISION_RECORD.md](./docs/BLOCKCHAIN_DECISION_RECORD.md) — **未決定の記録**

---

## 7. リポジトリについて

本リポジトリ `stockbusiness/sennokunnft` が本プロジェクトの正式な置き場である。

既存の Sengoku Market・OVEW Wallet・代理店システムとは**リポジトリを分けている**。
コードの流用はせず、将来の連携は API と Webhook で行う。
方針は [docs/EXTERNAL_INTEGRATION_POLICY.md](./docs/EXTERNAL_INTEGRATION_POLICY.md) を参照。

> 補足: 初期の実装は、リポジトリが未用意だったため既存リポジトリ内の
> サブディレクトリで進められた。その履歴は `git subtree split` で保持したまま
> 本リポジトリへ移送している（コミット履歴に残っている）。
