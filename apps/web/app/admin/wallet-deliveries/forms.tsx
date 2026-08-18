'use client';

import { useActionState, type ReactNode } from 'react';
import { Notice } from '@sengoku/ui';
import { resendDeliveriesAction } from './actions';
import type { AdminActionState } from '../actions';
import { DELIVERY_COPY } from '../../../src/delivery-copy';

const INITIAL: AdminActionState = {};

/**
 * 1 件だけ送り直す（詳細画面）。
 *
 * ⚠️ **一覧の中に置かない。** 一覧はまとめ送りの `<form>` で包んである。
 * その中にこの `<form>` を置くと入れ子になり、HTML として無効になる。
 * どちらのボタンが押されたのかブラウザごとに解釈が変わる。
 *
 * ⚠️ **押せるが何も起きないボタンを置かない。** お届け中のものと
 * すでに届いたものには、そもそもボタンを出さない（`canResend`）。
 * どちらも API 側が断るが、断られる前に手を止めさせるほうが親切。
 */
export function ResendButton({ deliveryId }: { readonly deliveryId: string }) {
  const [state, action, pending] = useActionState(resendDeliveriesAction, INITIAL);
  return (
    <form className="sengoku-inline-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined || state.notice === '' ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '送っています…' : DELIVERY_COPY.submitResend}
      </button>
    </form>
  );
}

/**
 * まとめて送り直す（一覧画面）。
 *
 * ⚠️ **選べるのは送り直せるものだけ。** 一覧側で `canResend` の行にしか
 * チェック欄を出さない。全部にチェックを出して API に断らせると、
 * 「押したのに何も起きなかった」が並ぶ。
 *
 * ⚠️ **この `<form>` の中に別の `<form>` を置かない。** 表そのものを
 * 包んでいるので、行ごとのボタンは詳細画面へ寄せてある。
 */
export function BulkResendForm({ children }: { readonly children: ReactNode }) {
  const [state, action, pending] = useActionState(resendDeliveriesAction, INITIAL);
  return (
    <form action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined || state.notice === '' ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
      {children}
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '送っています…' : DELIVERY_COPY.submitResendSelected}
      </button>
    </form>
  );
}
