'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { ORDER_NOTE_MAX_LENGTH } from '@sengoku/contracts';
import { addOrderNoteAction } from './actions';
import type { AdminActionState } from '../../actions';
import { ORDER_COPY } from '../../../../src/order-copy';

const INITIAL: AdminActionState = {};

/**
 * 対応メモの記入欄（`UD-121`）。
 *
 * ⚠️ **消せないことを先に伝える。** 書いてから知ると、「消せないなら
 * 書かない」になり、記録そのものが残らなくなる。
 *
 * ⚠️ **メールアドレスを書かないよう、欄の手前に置く。** 断られてから
 * 知るのでは、書き直しの手間が毎回かかる（`UD-503`）。
 */
export function OrderNoteForm({ orderId }: { readonly orderId: string }) {
  const [state, action, pending] = useActionState(addOrderNoteAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}

      <input type="hidden" name="orderId" value={orderId} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="order-note-body">
          {ORDER_COPY.notesLabel}
        </label>
        <p className="sengoku-form__hint">{ORDER_COPY.notesHint}</p>
        <p className="sengoku-form__hint">{ORDER_COPY.notesEmailWarning}</p>
        <textarea
          className="sengoku-form__textarea"
          id="order-note-body"
          name="body"
          rows={4}
          maxLength={ORDER_NOTE_MAX_LENGTH}
          required
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? ORDER_COPY.notesSubmitting : ORDER_COPY.notesSubmit}
      </button>
    </form>
  );
}
