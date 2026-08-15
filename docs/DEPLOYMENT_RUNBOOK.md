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

### 3-1. R2 を設定する

✅ **アダプタは実装済み**（`R2Storage`）。残りは Cloudflare 側の設定と環境変数だけ。

#### ① バケットを作る

Cloudflare のダッシュボード → `R2` → `Create bucket`

| 項目     | 値                          |
| -------- | --------------------------- |
| 名前     | `sennokunnft-media`（任意） |
| Location | `Asia-Pacific (APAC)`       |

#### ② Custom Domain を割り当てる

バケット → `Settings` → `Public access` → `Connect Domain`

例: `media-stg.example.jp`

⚠️ **`r2.dev` の開発用URLを本番で使わない。**
帯域が制限され、Cloudflare も本番利用を想定していない。

⚠️ **`Public access` を有効にする。** 有効にしないと画像が表示できない。
公開してよいのは**作品画像だけ**なので、このバケットに他のものを入れない。

#### ③ API トークンを作る

R2 → `Manage API tokens` → `Create API token`

権限は **`Object Read & Write`**、対象は作成したバケットのみに絞る。

`Access Key ID` と `Secret Access Key` が表示される。
⚠️ **Secret は一度しか表示されない。** その場で保管する。

#### ④ 設定を入れる — 秘密かどうかで置き場所を分ける

⚠️ **全部を `fly secrets` に入れない。**
ダッシュボードで直接入れた値は、**誰がいつ何に変えたかが残らない**。
秘密でないものは設定ファイルに書けば、変更がレビューを通り履歴も残る。

**`fly.api.toml` の `[env]` に書く**（秘密でない。コミットする）

| 変数                     | 値                                |
| ------------------------ | --------------------------------- |
| `MEDIA_STORAGE_PROVIDER` | `r2`                              |
| `MEDIA_PUBLIC_BASE_URL`  | ② で割り当てた Custom Domain      |
| `R2_BUCKET`              | ① のバケット名                    |
| `R2_ACCOUNT_ID`          | S3 エンドポイントに含まれる公開値 |

**`fly secrets` に入れる**（`https://fly.io/apps/sennokunnft-api/secrets`）

| Name                   | Value                  |
| ---------------------- | ---------------------- |
| `R2_ACCESS_KEY_ID`     | ③ の Access Key ID     |
| `R2_SECRET_ACCESS_KEY` | ③ の Secret Access Key |

⚠️ **順番を守る。鍵の登録が先、マージが後。**
設定ファイルに `MEDIA_STORAGE_PROVIDER = "r2"` が入った状態でマージすると、
api は R2 として起動しようとする。鍵が無ければ起動を拒否するので、
**先にマージすると動いている api が落ちる**。

⚠️ **設定が欠けていると起動時に拒否される。これは意図した仕様。**
黙って `local` に落ちるほうが危険で、その場合は画像のアップロードだけが
失敗してカタログの登録は途中まで進むため「**画像の無い作品**」ができあがる。
それが表面化するのは Wallet へ配送する段になってから。

#### 実装側で守っていること

| 守っていること                      | 理由                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `publicUrl` が署名付きURLを返さない | 期限切れで**過去の Holding がまとめて壊れる**。壊れるのは数日後で気づけない |
| 起動時に公開URLの形を検査           | 判定はドメイン側の `isLongLivedImageUrl` と**同じ関数**。二重に書くとずれる |
| 存在しないキーの削除を失敗にしない  | 置換や再試行で同じキーを 2 度消しうる                                       |
| `../` を含むキーを拒否              | `LocalFileStorage` と同じ規律。片方だけ守ると差し替えで検証が消える         |
| 例外に応答本文を載せない            | バケット名や鍵IDが混ざりうる                                                |

#### ⑤ 段階1 で登録した画像は入れ直す

⚠️ 段階1 の api は `/tmp/media` に書いており、**再起動で消えている**。
`r2` へ切り替えたら、作品画像を登録し直す。

#### 実施の記録（2026-08-15）

| 項目            | 値                                      |
| --------------- | --------------------------------------- |
| バケット        | `sennokunnft-media`（APAC）             |
| Custom Domain   | `media.commitrev.com`                   |
| 公開用の開発URL | 無効のまま（`r2.dev` は使わない）       |
| API トークン    | `Object Read & Write`・当該バケットのみ |
| 切り替え        | PR #14 のマージで `local` → `r2`        |

⚠️ **鍵が正しいかどうかは、まだ確定していない。**
デプロイが通ったことで分かるのは「**設定が揃っていて起動できた**」ことまで。
R2 への読み書きが実際に成功するかは、**画像を 1 枚アップロードするまで
分からない**。手順は次の ⑥。

作業の順序としては、③ の API トークン作成 → ④ の鍵登録 → マージ、で行った。
**先に設定ファイルをマージしてから鍵を入れると、そのあいだ api が落ちる。**

#### ⑥ 実際に 1 枚上げて確かめる

⚠️ **web のデプロイを待つ必要はない。** 管理画面に投稿フォームは無く、
登録はもともと API を直接叩いて行う（画面は一覧と詳細を見るだけ）。

**1. 運営の口座を作る**

`AUTH_PROVIDER=dev` のトークンは HS256 の JWT で、`AUTH_DEV_SECRET` で署名する。
初回アクセス時に口座が自動で作られるが、**役割は必ず `buyer`** になる
（トークンの自己申告を信用しない設計のため）。運営へ上げるのは DB 側で行う。

```sql
-- Supabase の SQL Editor で。<subject> は JWT の sub と同じ値。
UPDATE accounts SET role = 'operator'
WHERE auth_provider = 'dev' AND auth_subject = '<subject>';
```

⚠️ **`pnpm db:seed` を本番で流さない。** 運営の口座と一緒に**サンプル作品と
出品まで作る**。消し忘れたまま公開すると、実在しない作品が並ぶ。

**2. 作品を作って画像を上げる**

```bash
API=https://sennokunnft-api.fly.dev
TOKEN=<運営のトークン>

curl -X POST "$API/api/v1/admin/artworks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"r2-check","title":"疎通確認","description":"確認用","maxSupply":1}'

# ⚠️ 画像は multipart ではなく生のバイト列を送る（境界の解析を増やさないため）。
curl -X POST "$API/api/v1/admin/artworks/<作品ID>/image" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: image/png' \
  --data-binary @sample.png
```

応答の URL が `https://media.commitrev.com/...` で始まり、そのまま開ければ
**R2 の鍵・権限・Custom Domain のすべてが通っている**。

⚠️ 確認用の作品は archive しておくこと。公開したまま忘れると一覧に出る。

### 3-2. web を Vercel へ

GitHub 連携でプロジェクトを作る。**Root Directory は `apps/web`**。

⚠️ **Hobby プランは商用利用が禁止されている。** Pro（$20/人）にする。

#### ビルド設定は `apps/web/vercel.json` に置いてある

画面で設定を変えない。**ダッシュボードで直接入れると、誰がいつ何に変えたかが残らない。**

| 設定             | 値                                                       |
| ---------------- | -------------------------------------------------------- |
| `installCommand` | `cd ../.. && pnpm install --frozen-lockfile`             |
| `buildCommand`   | `cd ../.. && pnpm turbo run build --filter=@sengoku/web` |
| `regions`        | `["hnd1"]`（東京）                                       |

⚠️ **既定の設定では通らない。** 共有パッケージ（`@sengoku/config` など）は
`dist` へビルドしてから使う。`apps/web` の中だけで install / build すると
`dist` が無く、「モジュールが見つからない」で落ちる。
Root Directory を `apps/web` にすると各コマンドは `apps/web` で走るので、
**リポジトリの根まで戻してから**実行する。

⚠️ **`next build` を直接呼ばない。** 共有パッケージが古いまま混ざる。
混ざったことはビルドでは分からず、画面が出てから型の合わない値で壊れる。
依存のビルド順は `turbo` の `--filter` に任せる。

⚠️ **リージョンを東京に固定する。** 既定のままだと米国で動き、
api（Fly の `nrt`）と DB（Supabase の Tokyo）との往復が毎回太平洋を渡る。
**画面は出るので、遅いことにしか気づけない。**
`regions` の指定が効くのは Pro プラン以上。

✅ この構成は、キャッシュを消した状態から実際にビルドが通ることを確認済み
（約 34 秒）。推定ではない。

#### 環境変数

| 名前                    | 値                                  | 備考                          |
| ----------------------- | ----------------------------------- | ----------------------------- |
| `WEB_API_BASE_URL`      | `https://sennokunnft-api.fly.dev`   | 必須                          |
| `NEXT_PUBLIC_SITE_NAME` | 省略可（既定: 千ノ国NFTマーケット） |                               |
| `ADMIN_DEV_TOKEN`       | 管理画面用                          | ⚠️ 下の注意を読んでから入れる |

#### ⚠️ `ADMIN_DEV_TOKEN` を入れると、管理画面が誰にでも開く

管理画面に認可判定は無い。**web が運営の資格情報をサーバー側で持ち、
訪問者の代わりに API へ付けて送る**構造だからで、これは意図した設計
（認可は API 側で判定する）。ただしその前提は「**管理画面へ到達できるのは
運営だけ**」であり、公開URLに置いた瞬間にその前提が消える。

`ADMIN_DEV_TOKEN` を Vercel に入れると、URL を知った人が
`/admin/artworks` を開くだけで **未公開作品の一覧が読める**。
`SECURITY_DESIGN.md` の「非公開作品の存在を公開APIから推測できないように
する」に正面から反する。

⚠️ **書き込みはできない**（管理画面に投稿フォームは無く、登録は API 直叩き
の案内のみ）。**読み取りだけの漏れだが、漏れることに変わりはない。**

対処は次のいずれか。**入れる前に決める。**

| 案                                       | 効果                                       | 代償                               |
| ---------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `ADMIN_DEV_TOKEN` を Vercel に入れない   | 構造的に安全（資格情報が存在しない）       | 管理画面は手元の `pnpm dev` で使う |
| Vercel の Deployment Protection を掛ける | 管理画面も公開ページも Vercel ログイン必須 | 一般公開には使えない               |
| `UD-801` を解決して本物の認証を入れる    | 恒久的な解決                               | 決めごとが要る                     |

#### CORS

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
