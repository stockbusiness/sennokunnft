# DEPLOYMENT_RUNBOOK.md — 本番環境の構築手順（案A・最小構成から）

記法は [README.md](./README.md) に従う。
構成の背景と選定理由は [PRODUCTION_ARCHITECTURE.md](./PRODUCTION_ARCHITECTURE.md)。

利用者がまだいないので、**最小の状態から始めて段階的に足す**。
各段階は「これができたら次へ進む」形にしてある。

---

## 0. 全体像 — 3 段階に分ける

| 段階 | 立てるもの               | できること                 | 月額   |
| ---- | ------------------------ | -------------------------- | ------ |
| 1    | api ＋ DB                | 管理API で作品を登録できる | 約 $3  |
| 2    | ＋ R2 ＋ web             | カタログを公開できる       | 約 $25 |
| 3    | ＋ worker ＋ 各フラグ ON | OVEW Wallet と連携できる   | 約 $52 |

⚠️ **段階を飛ばさない。**
段階3 の worker は、フラグが両方 OFF のあいだ**何もしない**。
先に立てても、動いているかどうかを確かめる手段が無い。

### いま立てないもの

| 立てないもの  | 理由                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| worker        | `WALLET_DELIVERY_ENABLED` と `COMMON_USER_LINKING_ENABLED` が既定 OFF。ハンドラが 1 つも登録されない |
| web           | 段階1 で要るのは管理操作だけ。管理API を直接叩けば足りる                                             |
| api の 2 台目 | 利用者がいない。⚠️ **2 台にする前にレート制限の差し替えが要る**（§6）                                |
| Supabase Pro  | 手を動かしているあいだは Free で足りる。⚠️ 上げる条件は §5                                           |

---

## 1. 先に決める — サーバーの前に

⚠️ **これはインフラ作業ではなく実装作業。** サーバーを借りても解決しない。

`APP_ENV=production` で起動すると、`assertProductionSafety` が
`AUTH_PROVIDER=dev` を拒否する。候補は現状 `dev` しか無いので、
**本番として起動できない**（`UD-801`）。

### 段階1〜2 のあいだの扱い

段階1〜2 は**実質 staging** である。本物の利用者がおらず、決済も無い。
そこで `APP_ENV=staging` で立てる。これは迂回ではなく、実態に合わせた宣言。

```
APP_ENV=staging   ← 段階1〜2
APP_ENV=production ← カタログを一般公開する時点。UD-801 の解決が前提
```

⚠️ **`APP_ENV=staging` のまま一般公開しない。**
公開した瞬間からそれは本番であり、開発用の認証は許されない。
`production` へ切り替えると起動しなくなるので、**順序は仕組みで守られている。**
守られていないのは「切り替えないまま公開する」経路だけ。ここは人が守る。

⚠️ **`AUTH_DEV_SECRET` は本物の秘密として扱う。**
32 バイト以上の乱数を使う。`openssl rand -base64 32` で作る。

---

## 2. 段階1 — api と DB を立てる

### 2-1. アカウントを作る

| サービス   | 用意するもの                         |
| ---------- | ------------------------------------ |
| Fly.io     | アカウントとクレジットカード         |
| Supabase   | アカウント                           |
| Cloudflare | アカウント（段階2 で使う。今は不要） |

```bash
# Fly の CLI を入れてログインする
curl -L https://fly.io/install.sh | sh
fly auth login
```

### 2-2. Supabase プロジェクトを作る

コンソールで新規プロジェクトを作る。**リージョンは Tokyo (ap-northeast-1)**。

作成後、`Connect` から接続文字列を **2 本**控える。

| 用途                   | 見分け方      | 使う場所              |
| ---------------------- | ------------- | --------------------- |
| **Transaction pooler** | ポート `6543` | アプリ（api・worker） |
| **Direct connection**  | ポート `5432` | マイグレーションのみ  |

⚠️ **アプリ用には `?pgbouncer=true&connection_limit=5` を付ける。**

```
postgresql://...:6543/postgres?pgbouncer=true&connection_limit=5
```

付け忘れると、**動いたり動かなかったりする**。Prisma の prepared statement を
pooler が使い回すためで、負荷が上がってから初めて出る。テストでは気づけない。

⚠️ **2 本を取り違えない。**
Direct をアプリに使うと接続数を食い潰す。Pooler でマイグレーションは通らない。

### 2-3. マイグレーションを流す

✅ **手元で流す必要は無い。** `main` へマージすると、
`.github/workflows/deploy.yml` の「マイグレーション適用」ジョブが
`DIRECT_DATABASE_URL` を使って 1 回だけ流す。

⚠️ **手元から流す運用にしない。**
「誰かの手元で流し忘れた」「別の接続先へ流した」を防げない。
本番へ触る経路を 1 本に絞ることが、この構成の要点。

どうしても手元から流す場合（切り分けのときなど）は Direct 接続を使う。

```bash
DATABASE_URL="<Direct の接続文字列>" \
  pnpm --filter @sengoku/database exec prisma migrate deploy
```

**確認**: Supabase のコンソールで `artworks` `entitlements`
`wallet_delivery_outbox` の 3 つが見えること。

### 2-4. Fly.io に api を作る

```bash
# ⚠️ アプリを作るだけ。この時点ではデプロイしない。
fly apps create sennokunnft-api
```

⚠️ **`fly launch` を使わない。**
対話的に `fly.toml` を作り直してしまい、こちらで用意した設定
（`auto_stop_machines = "off"` など）が上書きされる。

### 2-5. 秘密情報を入れる

```bash
fly secrets set --app sennokunnft-api \
  DATABASE_URL="<Pooler の接続文字列（?pgbouncer=true 付き）>" \
  AUTH_DEV_SECRET="$(openssl rand -base64 32)"
```

⚠️ **`.env` を作らない。リポジトリにも入れない。**
`pnpm check:secrets` が混入を検査している。

段階1 で要る秘密情報はこの 2 つだけ。ほかは既定値で動く。

### 2-6. デプロイする

```bash
fly deploy --config fly.api.toml --remote-only
```

⚠️ 初回は 5〜10 分かかる。依存の取得とビルドが走るため。
2 回目以降はキャッシュが効いて短くなる。

### 2-7. 動いているか確かめる

```bash
fly status --app sennokunnft-api
curl https://sennokunnft-api.fly.dev/healthz
curl https://sennokunnft-api.fly.dev/readyz
```

| 応答           | 意味                                |
| -------------- | ----------------------------------- |
| `/healthz` 200 | プロセスが動いている                |
| `/readyz` 200  | **DB へ届いている**                 |
| `/readyz` 503  | DB へ届いていない。接続文字列を疑う |

⚠️ **`/readyz` が 503 のまま先へ進まない。**
段階2 以降のすべてが DB に依存する。ここで直す。

```bash
# 原因を見る。⚠️ ログに秘密情報は出ない設計だが、画面共有には注意する。
fly logs --app sennokunnft-api
```

### 2-8. 自動デプロイをつなぐ

GitHub の Settings → Secrets and variables → Actions に 2 つ登録する。

| 名前                  | 値                                                      |
| --------------------- | ------------------------------------------------------- |
| `FLY_API_TOKEN`       | `fly tokens create deploy --app sennokunnft-api` の出力 |
| `DIRECT_DATABASE_URL` | **Direct** の接続文字列（ポート 5432）                  |

これで `main` に入った変更が、CI 通過後に自動で反映される。

⚠️ **公開後はこの自動デプロイを外す。**
`main` を触るたびに本番が変わる状態は、構築中だけ許される。
`.github/workflows/deploy.yml` の `workflow_run` を外し、
`workflow_dispatch`（手動実行）だけにする。

### 段階1 の完了条件

- [x] `/readyz` が 200 を返す（`database: pass`）
- [x] `main` への push で自動デプロイされる
- [ ] 管理API から作品を 1 件登録できる

✅ **2026-08-15 に段階1 を構築した。**
`https://sennokunnft-api.fly.dev/readyz` が
`{"status":"ok","checks":[{"name":"database","status":"pass"}]}` を返している。

### 2-9. 初回で実際に詰まった 2 点（記録）

`Dockerfile` は実ビルドで検証せずに書いたため、初回デプロイが失敗した。
原因は 2 つで、いずれも**「ビルドには答える人がいない」**ことに起因する。

| 症状                       | 原因                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `sh: 1: prisma: not found` | corepack が pnpm のバージョンを決められず、別のバージョンで動いていた。`packageManager` を読ませる前に pnpm を呼んでいたため |
| （その手前で停止）         | `pnpm install --prod` が「node_modules を消して入れ直しますか？ (Y/n)」と尋ねる                                              |

対処:

```dockerfile
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
ENV CI=true                                   # pnpm は CI では尋ねない
```

⚠️ **`packageManager` に頼ったバージョン解決は、ロックファイルだけを置く段では効かない。**
キャッシュ効率のために `pnpm-lock.yaml` を先にコピーする構成では、
その時点に `package.json` が無い。**バージョンは明示的に固定する。**

✅ 現在の `Dockerfile` は**本番で通ったもの**であり、推定ではない。

---

## 3. 段階2 — 画像とカタログを公開する

### 3-1. R2 アダプタを実装する（実装作業）

⚠️ **これも実装作業。** 現状の `StoragePort` の実装は
`LocalFileStorage` と `InMemoryStorage` の 2 つだけで、**R2 用が無い**。

段階1 の api は `MEDIA_STORAGE_DIR=/tmp/media` に書く。
⚠️ **再起動で消える。** 段階1 で登録した画像は入れ直すことになる。

必要なもの:

| やること                 | 内容                                                |
| ------------------------ | --------------------------------------------------- |
| R2 バケット作成          | Cloudflare コンソール                               |
| Custom Domain を割り当て | 例 `media.example.jp`。⚠️ **署名付きURLを使わない** |
| `R2Storage` の実装       | `StoragePort` を満たす。`publicUrl` が長期URLを返す |
| 環境変数の追加           | バケット名・アクセスキー・公開URLの前置き           |

⚠️ **期限付きURLを `publicUrl` から返さない。**
Wallet は受け取ったURLを保存して表示に使う。期限が切れた時点で
**過去に渡した分の画像がまとめて壊れる**。しかも壊れるのは数日後なので、
原因に誰も気づけない。ドメイン側の `isLongLivedImageUrl` が
署名付きURLを弾くようになっているので、実装を誤れば配送の組み立てで落ちる。

### 3-2. web を Vercel へ

GitHub 連携でプロジェクトを作る。ルートディレクトリは `apps/web`。

⚠️ **Hobby プランは商用利用が禁止されている。** Pro（$20/人）にする。
⚠️ **サーバー処理のリージョンを東京（`hnd1`）にする。** 既定だと api との往復が海外を経由する。

環境変数:

| 名前               | 値                                         |
| ------------------ | ------------------------------------------ |
| `WEB_API_BASE_URL` | `https://sennokunnft-api.fly.dev`          |
| `ADMIN_DEV_TOKEN`  | 管理画面用。⚠️ `UD-801` 解決後は不要になる |

そのうえで api 側の CORS を web のドメインに向ける。

```bash
fly secrets set --app sennokunnft-api API_PUBLIC_ORIGIN="https://<web のドメイン>"
```

### 3-3. Supabase を Pro へ

⚠️ **一般公開の前に必ず上げる。**
Free は **1 週間アクセスが無いとプロジェクトが一時停止する**。
公開直後のアクセスが少ない時期に、まさにこれが起きる。

### 段階2 の完了条件

- [ ] 画像が `https://media.example.jp/...` で表示される
- [ ] カタログ画面が web で見える
- [ ] Supabase が Pro になっている

---

## 4. 段階3 — OVEW Wallet と連携する

### 4-1. worker を立てる

```bash
fly apps create sennokunnft-worker
fly secrets set --app sennokunnft-worker \
  DATABASE_URL="<Pooler の接続文字列>"
fly deploy --config fly.worker.toml --remote-only
```

GitHub のリポジトリ変数 `DEPLOY_WORKER` を `true` にして、自動デプロイへ載せる。

⚠️ **worker を 2 台にしない。**
共通顧客IDの解決ジョブは行をロックせずに拾うため、
2 台にすると代理店システムを二重に呼ぶ（`create_if_missing` 付きだと
相手側で `common_user_id` が二重発行されうる）。

### 4-2. フラグを 1 つずつ ON にする

**1 つ ON にしたら、次に進む前に動作を確かめる。**

| 順  | フラグ                        | 入れる場所  | 前提                                       |
| --- | ----------------------------- | ----------- | ------------------------------------------ |
| 1   | `COMMON_USER_LINKING_ENABLED` | worker      | 代理店システムの本番鍵                     |
| 2   | `CLAIM_API_ENABLED`           | api         | Wallet と固定テストベクトルが一致          |
| 3   | `WALLET_DELIVERY_ENABLED`     | api・worker | **相手の 2xx が Holding 永続化を意味する** |

⚠️ **3 の前提を口頭で済ませない。**
相手が「共通顧客IDが合わないので何もしなかった」ときに 2xx を返す仕様だと、
こちらの `delivered` は嘘になる。契約として確認してから ON にする。

⚠️ **3 を ON にすると、受取確定と同時に配送本文を組み立てる。**
長期URLの画像が無い作品では**受取そのものが失敗する**。段階2 が先。

⚠️ **3 を ON にした時点で、それ以前に受け取られた分は行列に載っていない。**
`wallet_delivery_status = 'pending'` なのに配送行が無い受取権が残る。
ON にする直前に、載せ直す手順を用意しておくこと。検出クエリは
[PRODUCTION_ARCHITECTURE.md §7](./PRODUCTION_ARCHITECTURE.md)。

---

## 5. 費用が変わるタイミング

| いつ                 | 何が増えるか                | 月額の変化 |
| -------------------- | --------------------------- | ---------- |
| 段階1                | Fly api 1 台                | 約 $3      |
| web を立てる         | Vercel Pro                  | ＋$20      |
| **一般公開の前**     | Supabase Free → Pro         | ＋$25      |
| worker を立てる      | Fly worker 1 台             | ＋$3       |
| **決済を入れるとき** | Supabase PITR ＋ api 2 台目 | ＋約 $103  |

> 🟡 2026 年 5 月時点の公開価格に基づく概算。契約前に再確認すること。

---

## 6. 台数を増やす前にやること

⚠️ **api を 2 台にする前に、レート制限を PostgreSQL 実装へ差し替える。**

いまはプロセス内メモリで数えているため、台数を増やすと
実効上限が台数倍になる。**落ちないしログにも出ない。**
上限を 300 に設定したつもりが 600 通る状態が、誰にも気づかれずに続く。

順序は必ずこうする。

```
1 台で運用  →  PostgreSQL 版レート制限を実装  →  2 台へ
```

⚠️ **逆順にしない。** 2 台にしてから直すと、そのあいだ上限が 2 倍になる。

---

## 7. 詰まりやすいところ

| 症状                            | 原因                                                     |
| ------------------------------- | -------------------------------------------------------- |
| 起動せず「AUTH_PROVIDER」と出る | `APP_ENV=production` にした。`UD-801` の解決が要る（§1） |
| `/readyz` が 503                | 接続文字列。Pooler と Direct を取り違えていないか        |
| たまに DB エラーが出る          | `?pgbouncer=true` の付け忘れ                             |
| デプロイが「たまに」失敗する    | マイグレーションが同時に流れている。`concurrency` を確認 |
| worker が動いていない気がする   | フラグが両方 OFF なら**正常**。何もしないのが正しい      |
| 画像が消えた                    | R2 未導入。`/tmp` は再起動で消える（§3-1）               |
| Supabase に繋がらなくなった     | Free プランの一時停止。Pro へ上げる（§3-3）              |

---

## 8. 本文書に関わる未決定事項

| ID      | 概要                 | 影響する段階                            |
| ------- | -------------------- | --------------------------------------- |
| UD-801  | JWT の検証方式       | **一般公開（`production` 化）の前提**   |
| UD-508  | 画像の長期参照方式   | 段階2。方式は R2 に決定済み、実装が未了 |
| UD-702  | 決済事業者           | 販売開始の前提                          |
| UD-1102 | 監視基盤・通知先     | 段階3 までに用意する                    |
| UD-1103 | バックアップ保持期間 | 決済を入れるときに決める                |
