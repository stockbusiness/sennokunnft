'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { redeliverAction, retryIssuanceAction } from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

/**
 * 発行し直す。
 *
 * ⚠️ **何度押しても増えない。** API 側が「足りないぶんだけ」を作る。
 * それでも押した人が不安にならないよう、結果に件数を出す。
 */
export function RetryIssuanceForm({ orderId }: { readonly orderId: string }) {
  const [state, action, pending] = useActionState(retryIssuanceAction, INITIAL);
  return (
    <form className="sengoku-inline-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
      <input type="hidden" name="orderId" value={orderId} />
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '発行しています…' : '受取権を発行し直す'}
      </button>
    </form>
  );
}

/**
 * その方ぶんをまとめて送り直す。
 *
 * ⚠️ **1 回で送る数に上限がある。** 上限は API 側が持つ。画面で
 * 数えて出し分けると、上限を変えたときに画面だけ古くなる。
 */
export function RedeliverForm({ accountId }: { readonly accountId: string }) {
  const [state, action, pending] = useActionState(redeliverAction, INITIAL);
  return (
    <form className="sengoku-inline-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
      <input type="hidden" name="accountId" value={accountId} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '送っています…' : 'この方ぶんを送り直す'}
      </button>
    </form>
  );
}
