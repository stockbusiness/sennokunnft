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
`AUTH_PROVIDER=dev` を拒否する。

### `APP_ENV` の現在の値

✅ **`production`（2026-08-18 に `staging` から変更）。**

段階1〜2 のあいだは `staging` で立てていた。当時は `AUTH_PROVIDER` の候補が
`dev` しか無く、`production` にすると起動できなかったため（`UD-801`）。
`UD-801` が解決して `AUTH_PROVIDER=supabase` になり、その制約は外れた。

⚠️ **この値は「どの環境か」の唯一の根拠。**
管理画面が staging と production を出し分けるときも、ここを見る。
本番なのに `staging` と名乗っていると、危険な操作の前に出す確認が
「これは staging だから大丈夫」という誤解を生む。

⚠️ **`production` にすると起動条件が厳しくなる。**
次のどれかを崩すと**起動せずに終了する**。

| 条件                                    | 現在                        |
| --------------------------------------- | --------------------------- |
| `LOG_LEVEL` が `trace` / `debug` でない | `info`（`fly.api.toml`）    |
| `DATABASE_URL` がローカルを指していない | Supabase の Pooler          |
| `AUTH_PROVIDER` が `dev` でない         | `supabase`（`fly secrets`） |

⚠️ **`AUTH_PROVIDER` を `fly secrets unset` しない。**
既定値は `dev` なので、消すと本番として起動できなくなる。

### staging Fixture は使えなくなった

`assertStagingFixtureAllowed` は `APP_ENV=production` を拒否する。
worker が繋ぐのは**本番の DB** なので、そこへ偽の受取権を作れる状態を
残しておくほうが危険だった。

⚠️ **`APP_ENV` を `staging` へ戻して Fixture を通さないこと。**
OVEW Wallet の staging 接続を試すときは、本当に分離された staging 環境を
用意する（`UD-1101`、未決定）。

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

作業の順序としては、③ の API トークン作成 → ④ の鍵登録 → マージ、で行った。
**先に設定ファイルをマージしてから鍵を入れると、そのあいだ api が落ちる。**

✅ **実画像 1 枚で疎通を確認済み（2026-08-15）。**

⚠️ **デプロイが通ったことは疎通の証拠にならない。** それで分かるのは
「設定が揃っていて起動できた」ことまでで、鍵の正しさは別の話。
下は実際に 1 枚上げて確かめた結果。

| 確認項目          | 結果                                                        |
| ----------------- | ----------------------------------------------------------- |
| R2 への PUT       | ✅ `200`                                                    |
| 公開URL生成       | ✅ `https://media.commitrev.com/artworks/2026/08/0d61….png` |
| HTTPS 取得        | ✅ `status=200 type=image/png size=70`                      |
| `image_key` 保存  | ✅                                                          |
| `image_hash` 保存 | ✅ `sha256:c414cd0e…`                                       |
| api 再起動後      | ✅ 同じ URL で取得できる                                    |

✅ **`image_hash` は保存先に依存しない。**
同じ PNG をローカル（`local` 保存）へ上げたときと**同一の値**になった。
Wallet 側と画像の同一性を突き合わせる前提が、実測で確かめられている。

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

⚠️ **Windows から叩かない。`fly ssh console` の中でやる。**
実際に、Windows の PowerShell 7 からは**本文を 1 バイトも送れなかった**
（`curl.exe` でも `Invoke-RestMethod` でも同じ）。
症状は `VALIDATION_ERROR` / `(root)` / `invalid_type` で、
**「本文が空」のときと同じ応答**になる。JSON の書き方を直しても変わらない。

サーバーの中なら Windows の引数解釈も経路上の中継も挟まらない。
`node` は実行イメージに入っているので、追加で入れるものは無い。

```bash
fly ssh console -a sennokunnft-api
```

以降は**サーバーの中**で実行する。トークンも中で作れば、
`AUTH_DEV_SECRET` を画面に出さずに済む（そもそも Fly からは読み出せない）。

```sh
export T=$(node -e 'const{createHmac}=require("crypto");const e=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const h=e({alg:"HS256",typ:"JWT"});const p=e({sub:"ops-tanaka",iss:"sennokunnft-dev",aud:"sennokunnft",exp:Math.floor(Date.now()/1000)+86400});console.log(h+"."+p+"."+createHmac("sha256",process.env.AUTH_DEV_SECRET).update(h+"."+p).digest("base64url"))')

node -e 'fetch("http://127.0.0.1:8080/api/v1/admin/artworks",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.T},body:JSON.stringify({slug:"r2-check",title:"疎通確認",description:"R2 疎通確認用",maxSupply:1})}).then(r=>r.text()).then(console.log)'
```

⚠️ 画像は multipart ではなく**生のバイト列**を送る（境界の解析を増やさないため）。
確認用なら、その場で最小の PNG を作れる。ファイルを持ち込まなくてよい。

```sh
node -e 'const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");fetch("http://127.0.0.1:8080/api/v1/admin/artworks/<作品ID>/image",{method:"POST",headers:{"content-type":"image/png",authorization:"Bearer "+process.env.T},body:png}).then(r=>r.text()).then(console.log)'
```

⚠️ **`Content-Type` はファイルの実体に合わせる。**
種類は**中身の先頭バイト**で判定し、ヘッダは照合にしか使わない。
拡張子やヘッダを偽っても通らない。対応は `image/png` `image/jpeg`
`image/webp` の 3 つ、大きさは 64 バイト〜5 MB。

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

| 名前                    | 値                                | 備考                                      |
| ----------------------- | --------------------------------- | ----------------------------------------- |
| `WEB_API_BASE_URL`      | `https://sennokunnft-api.fly.dev` | 必須                                      |
| `SITE_GATE_PASSWORD`    | グループ内テストの合言葉          | ⚠️ **必須**。未設定だと全ページ 503       |
| `NEXT_PUBLIC_SITE_NAME` | 省略可                            | 未設定なら `site.ts` の暫定名（`UD-101`） |
| `ADMIN_DEV_TOKEN`       | 管理画面用                        | ⚠️ 門ができてから入れる（下記）           |

#### 3-2-1. 合言葉の門（正式名が決まるまでの暫定）

正式名・運営主体が未決定のあいだ、サイトを関係者だけに見せる。

⚠️ **これは認証ではない。** 誰が見たかは分からず、合言葉を教わった人が
転送するのも止められない。「URL を偶然知った人・検索から来た人を止める」
までが役割。利用者ごとの認可（`UD-801`）は別の話。

##### なぜ Vercel の機能を使わないのか

画面の設定で済ませたかったが、実際に見たところ費用が合わなかった。

| 手段                                       | 判定                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| Vercel Authentication（`Standard`）        | ❌ **本番ドメインを守らない**。対象は Preview 等     |
| Vercel Authentication（`All Deployments`） | △ 無料だが**見る人全員が有料メンバー**（1人 $20/月） |
| Password Protection                        | ❌ 有料アドオン **$150/月**                          |
| **middleware で自前**                      | ✅ 追加費用なし・参加者にアカウント不要              |

⚠️ **`Standard Protection` を「設定したから安心」と思わない。**
設定画面は緑になるが、`sennokunnft-web.vercel.app` は素通しのまま。

##### 合言葉を決めて Vercel に入れる

`Settings` → `Environment Variables` に `SITE_GATE_PASSWORD` を追加する。
8文字以上。⚠️ **他で使っている言葉を流用しない。** 口頭やメッセージで
配る前提なので、漏れることを織り込む。

⚠️ **未設定のまま公開環境へ出すと、全ページが 503 になる。**
素通しになるより、閉じて気づけるほうを選んである（`decideGate`）。

##### 確かめ方

⚠️ **必ずシークレットウィンドウで、2 か所とも確かめる。**
通常のウィンドウは既に通っていることがある。

```
https://<web のドメイン>/            → 合言葉を聞かれる
https://<web のドメイン>/admin/artworks → 合言葉を聞かれる
```

##### 仕組み（要点だけ）

| 決めごと                             | 理由                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| 判定は middleware の 1 か所          | 画面ごとに書くと、足した画面で書き忘れて**そこだけ素通し** |
| 入れ物には**署名だけ**入れる         | 入れ物はブラウザに残り、開発者ツールから読める             |
| 合言葉を変えると全部の入れ物が無効に | 鍵が変われば署名が変わる。呼び戻しの手順が要らない         |
| 戻り先は自サイト内に限る             | 外部URLへ飛ばす経路を作らない                              |
| 違いの内容を返さない                 | 「何文字目まで合っている」は総当たりの助けになる           |

##### ⚠️ 門の外にあるもの

- **api（`sennokunnft-api.fly.dev`）** — 直接叩けば作品名と価格は読める
- `/api/health` — 監視が合言葉を持てないため。中身は「動いているか」だけ

#### ⚠️ `ADMIN_DEV_TOKEN` は門ができてから入れる

管理画面に認可判定は無い。**web が運営の資格情報をサーバー側で持ち、
訪問者の代わりに API へ付けて送る**構造だからで、これは意図した設計
（認可は API 側で判定する）。ただしその前提は「**管理画面へ到達できるのは
運営だけ**」であり、門が無いまま公開URLに置くとその前提が消える。

門が無い状態で入れると、URL を知った人が `/admin/artworks` を開くだけで
**未公開作品の一覧が読める**。`SECURITY_DESIGN.md` の「非公開作品の存在を
公開APIから推測できないようにする」に正面から反する。

⚠️ **書き込みはできない**（管理画面に投稿フォームは無く、登録は API 直叩き
の案内のみ）。**読み取りだけの漏れだが、漏れることに変わりはない。**

順序を守る。

```
① SITE_GATE_PASSWORD を入れる
② シークレットウィンドウで 2 か所とも確かめる
③ ADMIN_DEV_TOKEN を入れる
```

⚠️ **③を先にやらない。** 確認が済むまでのあいだ、誰でも読める状態になる。

#### CORS

```bash
fly secrets set --app sennokunnft-api API_PUBLIC_ORIGIN="https://<web のドメイン>"
```

### 3-3. Supabase を Pro へ

⚠️ **一般公開の前に必ず上げる。**
Free は **1 週間アクセスが無いとプロジェクトが一時停止する**。
公開直後のアクセスが少ない時期に、まさにこれが起きる。

### 段階2 の完了条件

- [x] 画像が `https://media.commitrev.com/...` で表示される
- [ ] カタログ画面が web で見える
- [ ] Supabase が Pro になっている

疎通確認で作った作品（`slug = r2-check`）は **`draft` のまま残してある**。
公開ページには出ないうえ、段階3 の Fixture → Claim → Wallet 表示の
確認にそのまま使えるため。**消さないこと。**

⚠️ archive しても R2 の画像は消えない。画像を消すのは
「別の画像で置き換えたとき」だけ（`image.service.ts`）。

---

## 3-4. ログインを有効にする（`UD-801` 決定済 2026-08-18）

✅ **検証方式は JWKS / ES256。** Supabase プロジェクトの署名鍵が
ECC (P-256) へ交代済みのため、事実として決まっている。

⚠️ **設定を入れるまで、いまの「全員が同じ出品者」の状態が続く。**
`SUPABASE_URL` と `SUPABASE_ANON_KEY` の両方が入って初めて
ログイン機能が有効になる。片方だけでは有効にならない。

### 3-4-1. メールの文面を書き換える（**これを忘れると入れない**）

Supabase の **Authentication → Emails → Magic Link** を開き、
本文のリンクを次の形にする。

```
{{ .SiteURL }}/api/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink
```

⚠️ **既定の `{{ .ConfirmationURL }}` のままにしない。**
あちらは `#` の後ろにトークンを付けて戻す。`#` から後ろは**サーバーに届かない**ため、
こちらでは受け取れない。

✅ **`{{ .TokenHash }}` を使うと、どのブラウザで開いても通る。**
パソコンで申し込んでスマホのメールで開く、という普通の使い方で失敗しない。
`{{ .ConfirmationURL }}` + PKCE の組み合わせでは、これができない。

### 3-4-2. 戻り先を許可する

**Authentication → URL Configuration** で:

| 項目          | 値                                                    |
| ------------- | ----------------------------------------------------- |
| Site URL      | `https://sennokunnft-web.vercel.app`                  |
| Redirect URLs | `https://sennokunnft-web.vercel.app/api/auth/confirm` |

⚠️ **ここに無い戻り先は Supabase が弾く。** 弾かれた理由は
利用者側には出ないので、「メールは届くのに入れない」に見える。

### 3-4-3. Vercel に環境変数を入れる

| 変数                | 値                                        | 秘密か |
| ------------------- | ----------------------------------------- | ------ |
| `SUPABASE_URL`      | `https://<ref>.supabase.co`               | 公開   |
| `SUPABASE_ANON_KEY` | Settings → API Keys の anon / publishable | 公開   |
| `WEB_PUBLIC_ORIGIN` | `https://sennokunnft-web.vercel.app`      | 公開   |

⚠️ **`service_role` キーを入れない。** 行単位の権限をすべて飛び越える。
名前が似ているので取り違えると被害が大きい。ログインに必要なのは公開鍵だけ。

⚠️ **`WEB_PUBLIC_ORIGIN` を省かない。** 省くと要求の `Host` から
組み立てる逃げ道に落ちる。偽の `Host` を送られると、ログインのリンクを
攻撃者の場所へ向けさせられる。

### 3-4-4. Fly（api）に環境変数を入れる

⚠️ **この手順だけは、ログイン対応の api が本番へ出てからにする。**
それより前の api は `AUTH_PROVIDER` に `dev` しか受け付けない。先に入れると
**設定の検査で弾かれて起動しなくなる**（`Waiting for ... to become healthy: 0/1`
のまま止まる）。3-4-1〜3-4-3 は先に済ませてよい。

⚠️ **`<ref>` を置き換えるのを忘れない。実際にこれで api を落とした。**
そのまま貼ると、存在しないホストへ鍵を取りに行く設定になる。
`<ref>` はダッシュボードの住所に入っている文字列
（`supabase.com/dashboard/project/<ref>/...`）。

```bash
fly secrets set --app sennokunnft-api AUTH_PROVIDER=supabase SUPABASE_JWT_ISSUER=https://<ref>.supabase.co/auth/v1 SUPABASE_JWKS_URL=https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
```

**起動しなくなったら、消せば戻る。**

```bash
fly secrets unset --app sennokunnft-api AUTH_PROVIDER SUPABASE_JWT_ISSUER SUPABASE_JWKS_URL
```

戻ったかどうかは `curl https://sennokunnft-api.fly.dev/healthz` で確かめる。

⚠️ **設定が欠けたまま `AUTH_PROVIDER=supabase` にすると起動しない。**
これは意図した動作。起動させると**すべてのログインが 401 になり**、
利用者からは「自分の入力が悪い」ようにしか見えず、諦めるまで直らない。

✅ **JWKS の URL は公開情報。** 公開鍵しか含まない。`fly secrets` に
入れているのは扱いを揃えるためで、秘密だからではない。

### 3-4-5. 確かめる

1. 合言葉を通して `/creator` を開く → ログイン画面へ送られる
2. メールアドレスを入れる → メールが届く
3. **スマホで**リンクを開く → 出品一覧に入れる（別の端末でも通ることの確認）
4. 作品を登録する
5. **別のメールアドレスでログインし直す** → 1 の作品が**見えない**こと

⚠️ **5 を省かない。** ここが通らないなら、全員が同じ出品欄を共有した
ままになっている。見た目では気づけない。

### 3-5. 運営として作品を管理できるようにする

管理画面（`/admin/artworks`）から、登録された作品の**編集・公開停止・削除**が
できる。これを自分のアカウントで行うには、そのアカウントを `operator` へ
上げる必要がある。

⚠️ **ログインしただけでは運営にならない。** 初回アクセスで作られる役割は
**必ず `buyer`**（トークンの自己申告を信用しない設計のため）。

**1. 一度ログインする**

`/login` から、運営として使うメールアドレスでログインする。
このとき `accounts` に行ができる。

**2. その行を `operator` へ上げる**

Supabase の SQL Editor で実行する。

```sql
-- どの行が自分か分からないときは、まず新しい順に見る。
-- ⚠️ メールアドレスでは引けない。平文で持っていないため（UD-503）。
SELECT id, auth_provider, auth_subject, role, created_at
FROM accounts ORDER BY created_at DESC LIMIT 10;

UPDATE accounts SET role = 'operator' WHERE id = '<上で見つけた id>';
```

`auth_subject` は Supabase の Authentication → Users に出ている
**User UID** と同じ値なので、そちらから照合してもよい。

**3. 管理画面を開いて確かめる**

`/admin/artworks` に作品の一覧が出て、`管理する` から編集できれば通っている。

### 3-6. 最初のオーナーを決め、スタッフを招待できるようにする

スタッフの招待と権限の変更を行えるのは、**オーナーの印を持つ運営**だけ
（`UD-803`）。役割が `operator` でも、印が無ければ `/admin/staff` は開けない。

⚠️ **最初のオーナーだけは、アプリからは任命できない。**
アプリ内に「自分を昇格させる経路」を作らないための線引き。ここだけ DB で行う。

```sql
-- 3-5 で operator にしたアカウントに、人事の印を付ける。
UPDATE accounts SET is_owner = true, staff_email = 'ここに運営の方のメールアドレス'
WHERE id = 'ここに 3-5 で調べた id';
```

`staff_email` は、スタッフ一覧で「誰か」を見分けるために使う。
⚠️ **購入者のアドレスは今までどおり平文で持たない**（`UD-503`）。
ここに入れてよいのは、運営スタッフの業務用アドレスだけで、
一般会員の行に入れようとすると DB の CHECK が拒否する。

**2 人目からは画面で足せる**

1. オーナーが `/admin/staff` を開く
2. 「スタッフを招待する」に相手のメールアドレスを入れ、お任せすることを選ぶ
3. 相手にいつものログイン用メールが届く
4. 相手がそのメールから入ると、その場でスタッフになり、運営の画面へ入る

⚠️ **招待の有効期間は 7 日。** 過ぎたら送り直す。
無期限にすると、送ったことを忘れた招待が何か月も生き残り、
退職者や誤送信の宛先が、あとから権限を取れる状態が続く。

⚠️ **オーナーはいつも 1 名以上必要。** 0 人になると、以後どなたも
権限を配れなくなり、また DB を直接触るしか手が無くなる。
自分自身の権限は画面から変えられないので、交代するときは
**先に相手をオーナーにしてから**、相手に自分を降ろしてもらう。

⚠️ **オーナーを増やすのは、乗っ取られたときの被害も増やす。**
人事を配れる人が増えるということなので、必要な人数だけにする。
とはいえ 1 人だけだと、その人が使えなくなったときに詰まる。
**2 名**が現実的な落としどころ。

### ログインを有効にしたあとの `ADMIN_DEV_TOKEN`

✅ **2026-08-18 に、ログイン機能が有効な環境では使われなくなった。**

`SUPABASE_URL` と `SUPABASE_ANON_KEY` が入っていれば、`/creator` も `/admin` も
このトークンを**まったく使わない**。以前は「ログインが断られたときの逃げ道」
として `/admin` だけ残していたが、それだと `SUPABASE_*` を外したときに
**黙って「全員が同じ人」へ戻る**。静かに弱くなる経路は、いつか誰も
気づかないまま本番に残る。

⚠️ **消す前に、上の 3-5 と 3-6 を必ず済ませる。** オーナーのアカウントが
無い状態だと、スタッフ管理へ入れなくなる。

### 消す手順

1. Vercel の `Settings` → `Environment Variables` から `ADMIN_DEV_TOKEN` を削除
2. 再デプロイ（環境変数の変更は次のデプロイから効く）
3. `/admin/artworks` と `/admin/staff` が開けることを確認
4. `/admin/staff` の一覧から、共有トークンのアカウント（メールアドレスが
   「（未登録）」の行）を **「スタッフから外す」**

⚠️ **4 を忘れない。** 誰も使わないアカウントが運営として残る。

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

#### `DEPLOY_WORKER=true` にする前に要る環境変数

**フラグを OFF のまま立てるなら、要るのは `DATABASE_URL` の 1 本だけ。**
ほかは既定値で動く。フラグを ON にするときに、その段の分だけ足す。

⚠️ **先に全部入れない。** 使っていない接続先や鍵を置いておくと、
「設定してあるから繋がっているはず」という誤解が生まれる。
実際に繋がるのはフラグを ON にした時なので、**設定と実態がずれる**。

**A. いま（フラグ両方 OFF）**

| 変数                      | 置き場所          | 値                                        |
| ------------------------- | ----------------- | ----------------------------------------- |
| `DATABASE_URL`            | `fly secrets`     | Pooler（`?pgbouncer=true` 付き）          |
| `APP_ENV`                 | `fly.worker.toml` | `production`（⚠️ api と必ずそろえる）     |
| `NODE_ENV`                | `fly.worker.toml` | `production`                              |
| `WORKER_POLL_INTERVAL_MS` | `fly.worker.toml` | `5000`                                    |
| `ENABLE_STAGING_FIXTURES` | `fly.worker.toml` | `false`（⚠️ 本番で Fixture を許可しない） |

**B. `COMMON_USER_LINKING_ENABLED` を ON にするとき**

| 変数                          | 種別 | 備考                        |
| ----------------------------- | ---- | --------------------------- |
| `COMMON_USER_LINKING_ENABLED` | 設定 | `true`                      |
| `COMMON_USER_API_BASE_URL`    | 設定 | 代理店システムの接続先      |
| `COMMON_USER_API_KEY`         | 秘密 | ⚠️ `fly secrets` へ         |
| `COMMON_USER_SYSTEM_KEY`      | 設定 | 既定 `sennokuni-nft-market` |
| `COMMON_USER_LINK_BATCH_SIZE` | 設定 | 既定 25                     |

**C. `WALLET_DELIVERY_ENABLED` を ON にするとき（いちばん最後）**

| 変数                         | 種別 | 備考                               |
| ---------------------------- | ---- | ---------------------------------- |
| `WALLET_DELIVERY_ENABLED`    | 設定 | `true`                             |
| `WALLET_DELIVERY_ENDPOINT`   | 設定 | ⚠️ `https://` 必須（起動時に検査） |
| `WALLET_DELIVERY_KEY_ID`     | 設定 | Wallet が発行する鍵ID              |
| `WALLET_DELIVERY_SECRET`     | 秘密 | ⚠️ `fly secrets` へ。8文字以上     |
| `WALLET_DELIVERY_TIMEOUT_MS` | 設定 | 既定 10000                         |
| `WALLET_DELIVERY_BATCH_SIZE` | 設定 | 既定 20。1 巡で送る上限            |

✅ **足りない設定でフラグだけ ON にはできない。**
`assertWalletDeliveryConfig` / `assertCommonUserLinkingConfig` が起動時に
検査して落とす。**中途半端な状態で動き出すことはない。**

⚠️ **`WALLET_DELIVERY_*` は api にも同じ値を入れる。**

役割は違う。**送るのは worker だけ**で、api は送らない。
api がするのは、受取確定と同じトランザクションで**配送待ちの行を作る**ことだけ。

それでも api に同じ値が要るのは、api の起動時検査
（`assertWalletDeliveryConfig`）が worker と同じ条件を見るため。
`WALLET_DELIVERY_ENABLED=true` なのに接続先や鍵が無ければ、api は起動しない。

⚠️ **api と worker で ON / OFF を食い違わせない。** 落ちないので気づけない。

| 食い違い       | 何が起きるか                                                      |
| -------------- | ----------------------------------------------------------------- |
| api だけ ON    | 配送待ちの行は溜まる。**送る者がいないので永遠に届かない**        |
| worker だけ ON | 行が作られない。**worker は正常に空回りし、ログにも異常が出ない** |

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

| 症状                            | 原因                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| 起動せず「AUTH_PROVIDER」と出る | `AUTH_PROVIDER` が `dev` か未設定。`production` では使えない（§1） |
| `/readyz` が 503                | 接続文字列。Pooler と Direct を取り違えていないか                  |
| たまに DB エラーが出る          | `?pgbouncer=true` の付け忘れ                                       |
| デプロイが「たまに」失敗する    | マイグレーションが同時に流れている。`concurrency` を確認           |
| worker が動いていない気がする   | フラグが両方 OFF なら**正常**。何もしないのが正しい                |
| 画像が消えた                    | R2 未導入。`/tmp` は再起動で消える（§3-1）                         |
| Supabase に繋がらなくなった     | Free プランの一時停止。Pro へ上げる（§3-3）                        |

### 7-0. Stripe を繋ぐとき（決済 Phase P2）

設定する変数（値はリポジトリに書かない）:

```
PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=          # sk_test_… / sk_live_…
STRIPE_WEBHOOK_SECRET=      # whsec_…
STRIPE_API_VERSION=         # 既定 2026-07-29.dahlia
STRIPE_CHECKOUT_SUCCESS_URL=   # {ORDER_ID} を含める
STRIPE_CHECKOUT_CANCEL_URL=
PLATFORM_FEE_RATE_BPS=2000  # 20%
```

⚠️ **鍵の取り違えは起動時に止まる**（`assertStripeConfig`）。

| 環境            | 使う鍵     | 取り違えたとき                                         |
| --------------- | ---------- | ------------------------------------------------------ |
| production      | `sk_live_` | テスト鍵だと**起動しない**（決済は通るのに入金が無い） |
| staging / local | `sk_test_` | 本番鍵だと**起動しない**（本物のお金が動く）           |

⚠️ **`PLATFORM_FEE_RATE_BPS` を 0 のままにしない。** 0 は「手数料無料」では
なく「販売設定未完了」として扱い、支払い口を作らせない。購入者には
「購入準備中」と表示される。本番販売の開始前に 2000 を設定する。

⚠️ **Webhook の宛先を間違えない。** 試験用の送信先を本番の URL へ向けると、
試験の通知で本番の注文が確定しかける。`livemode` の食い違いは受信時に
弾いて記録するが、宛先自体を正しく設定すること。

**Webhook の登録先**: `https://<api のホスト>/api/v1/webhooks/stripe`
**購読するイベント**: `checkout.session.completed` /
`checkout.session.expired` / `checkout.session.async_payment_succeeded` /
`checkout.session.async_payment_failed` / `payment_intent.succeeded` /
`payment_intent.payment_failed`

✅ **鍵を持たない手元では `PAYMENT_PROVIDER=fake`。** 署名の作り方と検証の
手順は Stripe と同じなので、購入の流れを最後まで通せる。

### 7-1. 手元で api を走らせるとき

**`pnpm dev:api` は `tsc` でビルドしてから `node` で走らせます。**
`tsx` は使いません。

⚠️ **`tsx` へ戻さないこと。** esbuild 系の変換器は、`tsconfig.json` に
`emitDecoratorMetadata: true` と書いてあっても**その情報を出力しません**。
Nest は依存を「型」から解決するため、情報が無いと引数なしで生成し、
次の状態になります。

- 起動は**成功する**（`Nest application successfully started` が出る）
- 起動ログにエラーは**1 件も出ない**
- しかし `/healthz` を含む**すべてのエンドポイントが 500** を返す
- その 500 のログ本文は `{}`（空）で、手掛かりが残らない

動いているように見えるので、自分の書いたコードを疑って何時間も探すことになります。
実際にこの状態が長く残っていました。

いまは `assertDecoratorMetadata()`（`apps/api/src/common/decorator-metadata.ts`）が
**起動時に止めます。** 走らせ方を替えた人は、その場で理由と直し方を読めます。

✅ **worker は `tsx` のままで構いません。** Nest のデコレータを使っていないためです。

---

## 8. 本文書に関わる未決定事項

| ID      | 概要                 | 影響する段階                            |
| ------- | -------------------- | --------------------------------------- |
| UD-801  | JWT の検証方式       | **一般公開（`production` 化）の前提**   |
| UD-508  | 画像の長期参照方式   | 段階2。方式は R2 に決定済み、実装が未了 |
| UD-702  | 決済事業者           | 販売開始の前提                          |
| UD-1102 | 監視基盤・通知先     | 段階3 までに用意する                    |
| UD-1103 | バックアップ保持期間 | 決済を入れるときに決める                |
