'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { resendNotificationAction } from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

/**
 * 1 件だけ送り直す。
 *
 * ⚠️ **表の中に `<form>` を入れ子にしない。** 一覧をまとめて包む
 * `<form>` は置いていない。ここは行ごとに独立している。
 */
export function ResendNotificationForm({ deliveryId }: { readonly deliveryId: string }) {
  const [state, action, pending] = useActionState(resendNotificationAction, INITIAL);
  return (
    <form className="sengoku-inline-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '戻しています…' : '送り直す'}
      </button>
    </form>
  );
}
