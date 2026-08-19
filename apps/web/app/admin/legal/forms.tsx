'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { publishLegalAction, saveLegalDraftAction } from './actions';
import type { AdminActionState } from '../actions';
import { LEGAL_COPY, TOKUSHOHO_LABEL } from '../../../src/legal-copy';
import type { LegalDocumentKind, LegalVersionView } from '../../../src/legal-types';

const INITIAL: AdminActionState = {};

const TOKUSHOHO_KEYS = [
  'sellerName',
  'representativeName',
  'address',
  'phoneNumber',
  'contactEmail',
  'priceDescription',
  'additionalFees',
  'paymentMethods',
  'paymentTiming',
  'deliveryTiming',
  'returnPolicy',
  'operatingEnvironment',
] as const;

/**
 * 下書きの編集。
 *
 * ⚠️ **保存と公開を別のボタンにする。** ひとつにすると、書きかけを
 * 保存したつもりの操作が公開になる。公開は取り消せない。
 */
export function DraftForm({
  kind,
  draft,
}: {
  readonly kind: LegalDocumentKind;
  readonly draft: LegalVersionView | null;
}) {
  const [state, action, pending] = useActionState(saveLegalDraftAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      <input type="hidden" name="kind" value={kind} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="legal-title">
          {LEGAL_COPY.fieldTitle}
        </label>
        <input
          className="sengoku-form__input"
          id="legal-title"
          name="title"
          type="text"
          defaultValue={draft?.title ?? ''}
          maxLength={200}
          required
        />
      </div>

      {kind === 'tokushoho' ? (
        <>
          {TOKUSHOHO_KEYS.map((key) => (
            <div className="sengoku-form__field" key={key}>
              <label className="sengoku-form__label" htmlFor={`legal-${key}`}>
                {TOKUSHOHO_LABEL[key] ?? key}
              </label>
              <input
                className="sengoku-form__input"
                id={`legal-${key}`}
                name={key}
                type="text"
                defaultValue={draft?.tokushoho?.[key] ?? ''}
                maxLength={1000}
              />
            </div>
          ))}
        </>
      ) : (
        <div className="sengoku-form__field">
          <label className="sengoku-form__label" htmlFor="legal-body">
            {LEGAL_COPY.fieldBody}
          </label>
          <p className="sengoku-form__hint">{LEGAL_COPY.fieldBodyHint}</p>
          <textarea
            className="sengoku-form__input"
            id="legal-body"
            name="bodyText"
            rows={20}
            defaultValue={draft?.bodyText ?? ''}
          />
        </div>
      )}

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '保存しています…' : LEGAL_COPY.draftSaveButton}
      </button>
    </form>
  );
}

/**
 * 公開。
 *
 * ⚠️ **確認を挟む。** 取り消せない操作なので、押した直後ではなく
 * 押す前に伝える。確認は親切であって保護ではない（断るのは API）。
 */
export function PublishForm({ kind }: { readonly kind: LegalDocumentKind }) {
  const [state, action, pending] = useActionState(publishLegalAction, INITIAL);

  return (
    <form
      className="sengoku-form"
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(LEGAL_COPY.publishConfirm)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="kind" value={kind} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : <Notice tone="info" title={state.notice} />}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="legal-effective-from">
          {LEGAL_COPY.publishEffectiveFrom}
        </label>
        <p className="sengoku-form__hint">{LEGAL_COPY.publishEffectiveFromHint}</p>
        <input
          className="sengoku-form__input"
          id="legal-effective-from"
          name="effectiveFrom"
          type="datetime-local"
          required
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '公開しています…' : LEGAL_COPY.publishButton}
      </button>
    </form>
  );
}
