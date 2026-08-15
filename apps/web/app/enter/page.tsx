import { Notice, PageHeader } from '@sengoku/ui';
import { GATE_COPY } from '../../src/gate-copy';

/**
 * 合言葉を入れる画面（`UD-101` が決まるまでの暫定）。
 *
 * ⚠️ **ここだけは門の外側にある**（`isExemptPath`）。
 * 内側に置くと、入る前に入れないという堂々巡りになる。
 *
 * ⚠️ **検索に出さない。** 合言葉を知らない人に見つけてもらう必要がない。
 */
export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

export default async function EnterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <>
      <PageHeader title={GATE_COPY.title} description={GATE_COPY.description} />

      {params.error === undefined ? null : (
        <Notice tone="alert" title={GATE_COPY.wrongTitle} hint={GATE_COPY.wrongHint} />
      )}

      <form className="sengoku-gate-form" method="post" action="/api/enter">
        {/* 戻り先。値の検査はサーバー側で行う（外部URLへ飛ばさないため）。 */}
        <input type="hidden" name="next" value={params.next ?? '/'} />

        <label className="sengoku-gate-form__label" htmlFor="gate-password">
          {GATE_COPY.label}
        </label>
        <input
          className="sengoku-gate-form__input"
          id="gate-password"
          name="password"
          type="password"
          // ⚠️ 合言葉を保存の候補に出さない。共用の端末で次の人に見えてしまう。
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          // 最初に触る場所なので、開いた時点で入力できるようにする。
          autoFocus
        />

        <button className="sengoku-gate-form__button" type="submit">
          {GATE_COPY.submit}
        </button>
      </form>

      <p className="sengoku-gate-note">{GATE_COPY.note}</p>
    </>
  );
}
