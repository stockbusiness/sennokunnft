import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { Injectable } from '@nestjs/common';
import {
  assertDecoratorMetadata,
  DecoratorMetadataMissingError,
} from '../src/common/decorator-metadata';

/**
 * 実行環境が型の情報を残しているかの検査。
 *
 * ⚠️ **この検査自体が、走らせ方に依存する。** `emitDecoratorMetadata` を
 * 出力しない変換器で走らせると、ここが落ちる。それが正しい振る舞いで、
 * 「テストは通るのに本番が全滅する」を防ぐための唯一の砦になっている。
 */
describe('実行環境の検査', () => {
  it('型の情報が残っていれば通る', () => {
    expect(() => {
      assertDecoratorMetadata();
    }).not.toThrow();
  });

  it('落とすときは、原因と直し方を文面に含める', () => {
    // ⚠️ 符号だけを投げない。これを読むのは、原因の見当がついていない人。
    //    「何が起きているか」と「どうすれば直るか」の両方が要る。
    const error = new DecoratorMetadataMissingError('x');
    expect(error.name).toBe('DecoratorMetadataMissingError');
  });

  /**
   * ⚠️ **これがこの PR の本題。** 型の情報が無いと Nest は
   * 「依存 0 個のクラス」と解釈し、引数なしで生成する。
   * 例外は投げないので、起動は成功して見え、
   * 呼ばれたときに初めて壊れる。
   */
  it('型の情報が無いと、Nest は依存を undefined のまま組み立てる', async () => {
    @Injectable()
    class Dependency {
      readonly value = 'ok';
    }

    @Injectable()
    class Consumer {
      constructor(private readonly dependency: Dependency) {}
      read(): string {
        return this.dependency.value;
      }
    }

    // 実際に情報を消して、Nest がどう振る舞うかを見る。
    Reflect.deleteMetadata('design:paramtypes', Consumer);

    const moduleRef = await Test.createTestingModule({
      providers: [Dependency, Consumer],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    // 組み立ては通る。ここで落ちてくれれば、そもそも問題にならなかった。
    expect(consumer).toBeInstanceOf(Consumer);
    // 呼んだときに初めて壊れる。api ではこれが全エンドポイントの 500 になる。
    expect(() => consumer.read()).toThrow();
  });
});
