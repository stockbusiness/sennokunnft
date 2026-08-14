# syntax=docker/dockerfile:1

# 千ノ国NFTマーケット — api / worker 共通のイメージ。
#
# ⚠️ **api と worker で同じイメージを使う。**
# 中身は同じで、起動するコマンドだけが違う（各 fly.toml の `[processes]`）。
# 別々のイメージにすると、片方だけ古いコードで動く状態が作れてしまう。
# その状態は、両方のログを並べて見るまで気づけない。

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:$PATH"
# Prisma のクエリエンジンが openssl を必要とする。
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS build
# ⚠️ ロックファイルだけを先に入れる。
#    ソースを変えただけで依存の取得からやり直さないため。
COPY pnpm-lock.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile

# ⚠️ Prisma Client は生成物で、リポジトリに入っていない。ここで作る。
#    出力先は packages/database/generated（node_modules の外）。
RUN pnpm --filter @sengoku/database run generate

RUN pnpm turbo run build --filter=@sengoku/api --filter=@sengoku/worker

# ⚠️ ビルドが終わってから開発用の依存を落とす。
#    **同じディレクトリで入れ直す**ので、ワークスペースのリンクが壊れない。
#    生成済みの Prisma Client は node_modules の外にあるため残る。
RUN pnpm install --prod --offline --frozen-lockfile --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
# ⚠️ /app は root 所有なので、アプリが書ける場所を明示する。
#    R2 アダプタが入るまでの暫定であり、**再起動で画像が消える**。
#    段階1 で登録した画像は、R2 導入後に入れ直すことになる。
ENV MEDIA_STORAGE_DIR=/tmp/media

COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 8080

# 既定は api。worker は fly.worker.toml の `[processes]` で上書きする。
CMD ["node", "apps/api/dist/main.js"]
