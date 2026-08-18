'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { inviteStaffAction, revokeInvitationAction, updateStaffAction } from './actions';
import type { AdminActionState } from '../actions';
import { STAFF_COPY } from '../../../src/staff-copy';

const INITIAL: AdminActionState = {};

/**
 * ⚠️ **押せるが何も起きないボタンを置かない。**
 * 自分自身の行や、最後のオーナーに対する操作は、そもそも出さない。
 * どちらも API 側が断るが、断られる前に手を止めさせるほうが親切。
 */

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteStaffAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="staff-email">
          {STAFF_COPY.fieldEmail}
        </label>
        <p className="sengoku-form__hint">{STAFF_COPY.fieldEmailHint}</p>
        <input
          className="sengoku-form__input"
          id="staff-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="staff-role">
          {STAFF_COPY.fieldRole}
        </label>
        <p className="sengoku-form__hint">{STAFF_COPY.fieldRoleHint}</p>
        <select className="sengoku-form__input" id="staff-role" name="role" defaultValue="operator">
          <option value="operator">運営（作品と販売を扱えます）</option>
          <option value="auditor">閲覧のみ（見るだけです）</option>
        </select>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '送っています…' : STAFF_COPY.submitInvite}
      </button>
    </form>
  );
}

export function RevokeInvitationButton({ invitationId }: { readonly invitationId: string }) {
  const [state, action, pending] = useActionState(revokeInvitationAction, INITIAL);
  return (
    <form className="sengoku-inline-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="invitationId" value={invitationId} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '処理しています…' : STAFF_COPY.submitRevoke}
      </button>
    </form>
  );
}

export function StaffActionButton({
  accountId,
  change,
  label,
  tone = 'quiet',
}: {
  readonly accountId: string;
  readonly change: string;
  readonly label: string;
  readonly tone?: 'quiet' | 'danger';
}) {
  const [state, action, pending] = useActionState(updateStaffAction, INITIAL);
  return (
    <form className="sengoku-inline-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="change" value={change} />
      <button className={`sengoku-button sengoku-button--${tone}`} type="submit" disabled={pending}>
        {pending ? '処理しています…' : label}
      </button>
    </form>
  );
}
