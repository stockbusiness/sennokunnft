'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { IDENTITY_VERIFICATION_METHODS } from '@sengoku/contracts';
import {
  addNoteAction,
  openEmailChangeAction,
  settleEmailChangeAction,
  verifyIdentityAction,
} from './actions';
import { verificationMethodLabel } from '../../../src/customer-copy';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

function Result({ state }: { readonly state: AdminActionState }) {
  return (
    <>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}
    </>
  );
}

/** 申し送りを書く。⚠️ 消せないことを、書く前に伝える。 */
export function AddNoteForm({ accountId }: { readonly accountId: string }) {
  const [state, action, pending] = useActionState(addNoteAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Result state={state} />
      <input type="hidden" name="accountId" value={accountId} />
      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="customer-note">
          申し送り
        </label>
        <p className="sengoku-form__hint">
          ⚠️ 書いたものは消せません。訂正は新しく書き足してください。
        </p>
        <textarea
          className="sengoku-form__input"
          id="customer-note"
          name="body"
          rows={3}
          maxLength={2000}
          required
        />
      </div>
      <div className="sengoku-actions">
        <button className="sengoku-button" type="submit" disabled={pending}>
          {pending ? '記録しています…' : '申し送りを残す'}
        </button>
      </div>
    </form>
  );
}

/**
 * ご連絡先の変更を申し出として受ける。
 *
 * ⚠️ **この画面ではアドレスは変わらない。** 変えるのは認証基盤側で人が行う。
 */
export function OpenEmailChangeForm({ accountId }: { readonly accountId: string }) {
  const [state, action, pending] = useActionState(openEmailChangeAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Result state={state} />
      <input type="hidden" name="accountId" value={accountId} />
      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="customer-new-email">
          新しいご連絡先
        </label>
        <p className="sengoku-form__hint">
          伏せた表記だけを記録します。入力そのものは保存されません。
        </p>
        <input
          className="sengoku-form__input"
          id="customer-new-email"
          name="newEmail"
          type="email"
          autoComplete="off"
          required
        />
      </div>
      <div className="sengoku-actions">
        <button className="sengoku-button" type="submit" disabled={pending}>
          {pending ? '記録しています…' : 'お申し出を記録する'}
        </button>
      </div>
    </form>
  );
}

/**
 * 本人確認を記録する。
 *
 * ⚠️ **「誰が」が残る。** 押した人の名前が記録に残ることを、画面にも書く。
 */
export function VerifyIdentityForm({
  accountId,
  requestId,
}: {
  readonly accountId: string;
  readonly requestId: string;
}) {
  const [state, action, pending] = useActionState(verifyIdentityAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Result state={state} />
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`verify-method-${requestId}`}>
          どのように確かめましたか
        </label>
        <p className="sengoku-form__hint">
          ⚠️ お名前が記録に残ります。確かめていないものを選ばないでください。
        </p>
        <select
          className="sengoku-form__input"
          id={`verify-method-${requestId}`}
          name="method"
          required
        >
          {IDENTITY_VERIFICATION_METHODS.map((method) => (
            <option key={method} value={method}>
              {verificationMethodLabel(method)}
            </option>
          ))}
        </select>
      </div>
      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`verify-note-${requestId}`}>
          覚え書き（任意）
        </label>
        <textarea
          className="sengoku-form__input"
          id={`verify-note-${requestId}`}
          name="note"
          rows={2}
          maxLength={1000}
        />
      </div>
      <div className="sengoku-actions">
        <button className="sengoku-button" type="submit" disabled={pending}>
          {pending ? '記録しています…' : '本人確認を記録する'}
        </button>
      </div>
    </form>
  );
}

/**
 * 決着させる。
 *
 * ⚠️ **「変更済み」は、認証基盤側で変えたあとに押す。** 順序を逆にすると、
 * 変え忘れが記録の中に埋もれる。
 */
export function SettleEmailChangeForm({
  accountId,
  requestId,
  canComplete,
}: {
  readonly accountId: string;
  readonly requestId: string;
  /** ⚠️ 最終判定は API 側。ここは事故を減らすための足切りにすぎない。 */
  readonly canComplete: boolean;
}) {
  const [state, action, pending] = useActionState(settleEmailChangeAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Result state={state} />
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`settle-status-${requestId}`}>
          결果
        </label>
        <select
          className="sengoku-form__input"
          id={`settle-status-${requestId}`}
          name="status"
          defaultValue={canComplete ? 'completed' : 'rejected'}
        >
          {/*
            ⚠️ 本人確認が済むまで「変更済み」を出さない。押しても API が
               断るが、押せるボタンを並べると「押したのに動かない」が増える。
          */}
          {canComplete ? <option value="completed">認証基盤側で変更した</option> : null}
          <option value="rejected">見送る</option>
        </select>
      </div>
      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`settle-note-${requestId}`}>
          覚え書き（見送るときは必須）
        </label>
        <textarea
          className="sengoku-form__input"
          id={`settle-note-${requestId}`}
          name="note"
          rows={2}
          maxLength={1000}
        />
      </div>
      <div className="sengoku-actions">
        <button className="sengoku-button" type="submit" disabled={pending}>
          {pending ? '記録しています…' : '決着として記録する'}
        </button>
      </div>
    </form>
  );
}
