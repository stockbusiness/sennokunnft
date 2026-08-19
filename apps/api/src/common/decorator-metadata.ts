import { Injectable } from '@nestjs/common';

/**
 * この実行環境が「型の情報」を残しているかを確かめる。
 *
 * ⚠️ **これが無いと、api は起動に成功したまま全滅する。**
 *
 * Nest は依存を**構文ではなく型**から解決する。`constructor(private x: Foo)`
 * の `Foo` は、TypeScript が `emitDecoratorMetadata` で `design:paramtypes`
 * として実行時に残したものを読んでいる。
 *
 * ところが esbuild 系の変換器（`tsx` など）は、`tsconfig.json` に
 * `emitDecoratorMetadata: true` が書いてあっても**この情報を出さない**。
 * 出さないと Nest は「依存が 0 個のクラス」と解釈し、引数なしで
 * 生成する。結果として:
 *
 * - 起動は**成功する**（`Nest application successfully started` が出る）
 * - 起動ログにエラーは**1 件も出ない**
 * - しかし全 provider が `undefined` になり、`/healthz` を含む
 *   **すべてのエンドポイントが 500** を返す
 * - しかもその 500 のログ本文は `{}`（空）で、手掛かりが残らない
 *
 * 実際にこの状態が `pnpm dev:api` で起きていた。動いているように見えるので、
 * 「自分の書いたコードが悪い」と何時間も探すことになる。
 *
 * ⚠️ **黙って起動させないのが、この関数の唯一の役目。**
 * 走らせ方を替えた人が、その場で気付けるようにする。
 */

/** 型の情報が残っているかを見るためだけの印。他所から使わない。 */
class MetadataProbeDependency {}

/**
 * 検査用のクラス。
 *
 * ⚠️ **既存のコントローラで代用しない。** そのクラスが消えたり、
 * 引数の形が変わったりしたときに、検査の意味が静かに失われる。
 * 検査のためだけの、動かないものをここに置く。
 */
@Injectable()
class MetadataProbe {
  constructor(readonly dependency: MetadataProbeDependency) {}
}

export class DecoratorMetadataMissingError extends Error {
  public override readonly name = 'DecoratorMetadataMissingError';
}

const GUIDANCE = [
  'この実行環境は型の情報（design:paramtypes）を残していません。',
  'Nest は依存を型から解決するため、このまま起動すると',
  'すべてのエンドポイントが 500 を返します（起動自体は成功して見えます）。',
  '',
  'よくある原因: esbuild 系の変換器（tsx など）で直接 src を走らせている。',
  'tsconfig.json に emitDecoratorMetadata: true と書いてあっても出力されません。',
  '',
  '対処: TypeScript のコンパイラ（tsc）でビルドしてから走らせてください。',
  '  pnpm --filter @sengoku/api run dev    （tsc の監視 + node の監視）',
  '  pnpm --filter @sengoku/api run build && node dist/main.js',
].join('\n');

/**
 * 型の情報が残っていなければ例外を投げる。
 *
 * ⚠️ **`NestFactory.create` より前に呼ぶ。** あとに置くと、
 * 壊れた状態で組み立てが進んでしまう。
 */
export function assertDecoratorMetadata(): void {
  const paramTypes: unknown = Reflect.getMetadata('design:paramtypes', MetadataProbe);

  if (!Array.isArray(paramTypes) || paramTypes.length !== 1) {
    throw new DecoratorMetadataMissingError(GUIDANCE);
  }
  // ⚠️ 個数だけでは足りない。`Object` で埋められている変換器があると、
  //    Nest は「Object 型の依存」を解決できず、結局同じ壊れ方をする。
  if (paramTypes[0] !== MetadataProbeDependency) {
    throw new DecoratorMetadataMissingError(GUIDANCE);
  }
}
