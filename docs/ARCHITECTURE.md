# ARCHITECTURE.md — アーキテクチャ設計

記法は [README.md](./README.md) に従う。

---

## 1. アーキテクチャ方針

🟡 **仮決定:** **ポート＆アダプタ（ヘキサゴナル）** を採用する。

理由:

1. ブロックチェーン仕様が未決定（`UD-501`〜）であり、外部依存を差し替え可能にする必要が強い。
2. ✅ 指示「ビジネスロジックがフレームワーク層へ混在している場合はマージしない」を
   構造で担保できる。
3. ✅ 指示「既存システムと将来 API・Webhook で接続できる疎結合な構成」に合致する。

原則:

- **依存は内向きのみ。** `domain` は他のどのパッケージにも依存しない。
- **外部I/Oはすべてポート（interface）越し。** 実装（アダプタ）は `integrations` / `database` に置く。
- **フレームワーク（NestJS / Next.js）は最外殻。** ドメイン規則を書かない。

---

## 2. システム構成図

```
                    ┌──────────────────────────────┐
   ブラウザ ───────▶│  apps/web  (Next.js)          │
                    │  画面・BFF的なRoute Handler    │
                    └───────────┬──────────────────┘
                                │ HTTP (REST/JSON)
                                ▼
  決済Webhook ─────▶┌──────────────────────────────┐
  外部システム       │  apps/api  (NestJS)           │
                    │  HTTP境界・認可・DTO変換       │
                    └───────────┬──────────────────┘
                                │ ポート呼び出し
                    ┌───────────▼──────────────────┐
                    │  packages/domain              │
                    │  集約・状態遷移・不変条件      │
                    │  （フレームワーク非依存）       │
                    └───────────┬──────────────────┘
                                │ ポート（interface）
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
   packages/database   packages/integrations  packages/auth
   （Prisma/Postgres）   （決済・チェーン・        （Supabase Auth
                          ストレージのアダプタ）      トークン検証）
              ▲
              │ 同じポートを利用
              │
   ┌──────────┴───────────────┐
   │  apps/worker              │
   │  非同期ジョブ（Mint等）    │
   └───────────────────────────┘
```

🟡 **仮決定:** `apps/web` はブラウザから `apps/api` を直接叩かず、
Next.js の Route Handler を経由する（BFF）。理由: アクセストークンを
httpOnly Cookie に閉じ込め、ブラウザ JavaScript から到達不能にするため。
詳細は [SECURITY_DESIGN.md](./SECURITY_DESIGN.md)。

---

## 3. パッケージ責務

### 3.1 一覧

| パッケージ | 責務 | 依存してよい先 | 依存してはいけない先 |
| --- | --- | --- | --- |
| `packages/config` | 環境変数スキーマと型検証、共有 tsconfig / ESLint / Prettier プリセット | （なし） | すべて |
| `packages/validation` | zod ベースの共通バリデーション部品（ID・金額・日時等） | （なし） | すべて |
| `packages/domain` | 集約・値オブジェクト・状態遷移・ドメインエラー・ポート定義 | `validation` | フレームワーク、DB、HTTP、外部SDK |
| `packages/contracts` | **アプリケーション間契約**（API DTO、ドメインイベントのスキーマとバージョン） | `validation`, `domain`（型のみ） | フレームワーク、DB |
| `packages/database` | Prisma スキーマ・生成 Client・リポジトリ実装 | `config`, `domain` | HTTP、UI |
| `packages/auth` | Supabase Auth のトークン検証、ロール解決、認可判定関数 | `config`, `domain` | DB直接アクセス、UI |
| `packages/integrations` | 外部サービスのアダプタ（決済 / チェーン / ストレージ）と Fake 実装 | `config`, `domain`, `observability` | UI、HTTP framework |
| `packages/observability` | 構造化ロガー、相関ID、秘匿値マスキング | `config` | domain 以外の業務知識 |
| `packages/ui` | React プレゼンテーション部品（状態を持たない） | （なし。React のみ） | API呼び出し、domain |
| `apps/web` | 画面、ルーティング、BFF | `ui`, `contracts`, `validation`, `config`, `observability` | `database`, `domain`（直接） |
| `apps/api` | HTTP エンドポイント、認可適用、DTO⇄ドメイン変換、ユースケース組み立て | すべての packages | 他の apps |
| `apps/worker` | 非同期ジョブ実行、再試行、スケジューリング | `domain`, `database`, `integrations`, `config`, `observability` | 他の apps、`ui` |
| `infrastructure/` | IaC・ローカル開発用 compose 等 | — | — |

> ⚠️ **`packages/contracts` は「スマートコントラクト」ではない。**
> システム間の**契約（API DTO・イベントスキーマ）**を置く場所である。
> スマートコントラクトのソースは MVP スコープ外（✅ 本番配備禁止）であり、
> 将来必要になった場合は `packages/onchain`（新設）に分離する。→ `UD-301`

### 3.2 `apps/web` が `domain` に依存しない理由

🟡 **仮決定:** 画面はドメイン規則を再実装せず、`contracts` の型と API 応答のみを扱う。
理由: ブラウザバンドルにドメイン規則が載ることを避け、
「サーバー側で検証する」（✅ 指示）を構造上の既定にするため。
表示に必要な列挙値やラベルは `contracts` に置く。

---

## 4. 依存グラフ（循環なし）

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

✅ **事実:** 循環依存がないことを CI で機械検査する。
検査は `pnpm run check:deps`（`packages/config/scripts/check-deps.mjs`）で行い、
`package.json` の `dependencies` を走査して有向グラフを構築し、閉路を検出する。

🟡 **仮決定:** 加えて **許可された依存の向きのみ**を許すホワイトリストを持つ。
「循環はしていないが層を飛び越えている」依存（例: `ui` → `database`）も検出できるようにする。

---

## 5. 実行環境とプロセス構成

| プロセス | 役割 | 起動コマンド（開発） |
| --- | --- | --- |
| web | 画面配信・BFF | `pnpm --filter @sengoku/web dev` |
| api | HTTP API・Webhook 受信 | `pnpm --filter @sengoku/api dev` |
| worker | 非同期ジョブ | `pnpm --filter @sengoku/worker dev` |

🟡 **仮決定:** worker は **DBをジョブキューとして使う**（専用のキュー基盤を導入しない）。

理由:

- MVP のジョブ量は小さく、Redis 等の追加運用コストが見合わない。
- ジョブと業務データを**同一トランザクションで**更新でき、
  「支払確定したがジョブが失われた」という不整合を構造的に排除できる（Transactional Outbox）。
- PostgreSQL の `FOR UPDATE SKIP LOCKED` で競合のない取得ができる。

トレードオフ: スループット上限は低い。将来必要になれば `JobQueuePort` の
アダプタ差し替えで外部キューへ移行できるようにする。

❓ **未決定 `UD-302`:** デプロイ先（Vercel / Cloud Run / ECS 等）。
worker が**常駐可能かどうか**で設計が変わる。常駐不可の場合は cron 起動＋
1回実行モードが必要になる。worker は「1回実行（`--once`）」と「常駐ループ」の
**両モード**を持たせ、どちらの環境でも動くようにしておく。

---

## 6. 横断的関心事

| 関心事 | 実現方法 | 配置 |
| --- | --- | --- |
| 構造化ログ | pino ベースの JSON ロガー。秘匿キーは自動マスク | `packages/observability` |
| 相関ID | リクエストヘッダ `x-request-id` を受理／生成し AsyncLocalStorage で伝播 | `packages/observability` |
| 環境変数検証 | zod スキーマ。**起動時に一括検証し、不足なら即座に異常終了** | `packages/config` |
| エラー表現 | ドメインエラー（型付き）→ HTTP マッピングは api 層のフィルタで一元化 | `domain` + `apps/api` |
| 冪等性 | ドメイン側の状態遷移＋DB一意制約。詳細は [LAZY_MINT_FLOW.md](./LAZY_MINT_FLOW.md) | `domain` + `database` |
| 認可 | ポリシー関数を `auth` に置き、api 層の Guard から適用 | `packages/auth` + `apps/api` |

🟡 **仮決定:** ロガーは **pino** を採用（理由: JSON 出力が既定、redaction 機能が組み込み、
オーバーヘッドが小さい）。

---

## 7. 技術選定の記録

| 項目 | 選定 | 分類 | 根拠 |
| --- | --- | --- | --- |
| パッケージマネージャ | pnpm 9 | ✅ 指定 | — |
| モノレポツール | Turborepo | ✅ 指定 | — |
| 言語 | TypeScript 5.x（`strict` 有効） | ✅ 指定 | — |
| フロント | Next.js 15 App Router | ✅ 指定 | 🟡 App Router 採用は仮決定 |
| API | NestJS 11 | ✅ 指定 | — |
| DB | PostgreSQL 16 | ✅ 指定（版は🟡） | — |
| ORM | Prisma 6 | ✅ 指定 | — |
| 認証 | Supabase Auth | ✅ 指定 | — |
| テスト | Vitest | 🟡 | 指定は「VitestまたはJest」。ESM対応と設定コストで Vitest |
| E2E | Playwright | ✅ 指定 | — |
| CI | GitHub Actions | ✅ 指定 | — |
| Node | 22 LTS | 🟡 | 開発環境の既定。`.nvmrc` と CI で固定 |
| ロガー | pino | 🟡 | 上記 |
| バリデーション | zod | 🟡 | 型推論と Prisma/DTO 双方への流用しやすさ |

❓ **未決定 `UD-303`:** PostgreSQL のホスティング（Supabase の Postgres を使うか、
別サービスにするか）。Supabase Auth を使うことは決まっているが、
DB も Supabase かは指示されていない。`DATABASE_URL` 1本で抽象化しておく。

---

## 8. 本文書の未決定事項

| ID | 概要 |
| --- | --- |
| UD-301 | スマートコントラクトのソース配置（`packages/onchain` 新設の要否） |
| UD-302 | デプロイ先と worker の常駐可否 |
| UD-303 | PostgreSQL のホスティング先 |
