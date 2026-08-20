'use client';

import { useActionState } from 'react';
import { EmptyState, Notice } from '@sengoku/ui';
import { lookupOrdersByEmailAction, type EmailLookupState } from './actions';
import { AdminOrderCard } from './order-card';
import { ORDER_COPY } from '../../../src/order-copy';

const INITIAL: EmailLookupState = {};

/**
 * メールアドレスからの照合（`UD-121`）。
 *
 * ⚠️ **一覧の検索とは別の口にしてある。** 一覧の絞り込みは URL に載せてよいが、
 * メールアドレスは載せてはいけない。同じフォームにまとめると、いつか
 * `method="get"` にされてアクセスログへ流れる。
 *
 * ⚠️ **入力欄を残さない。** 送信後に値を保持すると、画面を開いたままの端末に
 * 他人のアドレスが表示され続ける。`autoComplete="off"` でブラウザにも
 * 覚えさせない。
 */
export function EmailLookupForm() {
  const [state, action, pending] = useActionState(lookupOrdersByEmailAction, INITIAL);

  return (
    <section className="sengoku-panel">
      <h2 className="sengoku-panel__title">{ORDER_COPY.emailLookupHeading}</h2>
      <p className="sengoku-form__hint">{ORDER_COPY.emailLookupHint}</p>

      <form className="sengoku-form" action={action}>
        {state.error === undefined ? null : (
          <Notice
            tone="alert"
            title={state.error}
            hint={
              state.error === ORDER_COPY.emailLookupUnavailable
                ? ORDER_COPY.emailLookupUnavailableHint
                : ''
            }
          />
        )}

        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="order-lookup-email">
            {ORDER_COPY.emailLookupLabel}
          </label>
          <input
            className="sengoku-form__input"
            id="order-lookup-email"
            name="email"
            type="email"
            /* ⚠️ ブラウザに覚えさせない。次に使う人の画面へ出てしまう。 */
            autoComplete="off"
            required
          />
        </div>

        <button className="sengoku-button" type="submit" disabled={pending}>
          {ORDER_COPY.emailLookupSubmit}
        </button>
      </form>

      {state.items === undefined ? null : state.items.length === 0 ? (
        <EmptyState title={ORDER_COPY.searchNoHits} hint={ORDER_COPY.searchNoHitsHint} />
      ) : (
        <ul className="sengoku-order-list">
          {state.items.map((order) => (
            <AdminOrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </section>
  );
}
