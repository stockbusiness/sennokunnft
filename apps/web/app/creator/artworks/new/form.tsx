'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { createArtworkAction, type ActionState } from '../../actions';
import { CREATOR_COPY } from '../../../../src/creator-copy';

const INITIAL: ActionState = {};

/**
 * 作品を登録するフォーム。
 *
 * ⚠️ **`required` 以上の検証を画面に書かない。** 文字数や形式の規則を
 * ここへ写すと、API 側と 2 か所になり、片方だけ直したときにずれる。
 * 画面が持つのは**案内**で、可否の判定はサーバーが行う。
 */
export function NewArtworkForm() {
  const [state, action, pending] = useActionState(createArtworkAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="title">
          {CREATOR_COPY.fieldTitle}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldTitleHint}</p>
        <input className="sengoku-form__input" id="title" name="title" type="text" required />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="slug">
          {CREATOR_COPY.fieldSlug}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldSlugHint}</p>
        <input
          className="sengoku-form__input"
          id="slug"
          name="slug"
          type="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="description">
          {CREATOR_COPY.fieldDescription}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldDescriptionHint}</p>
        <textarea className="sengoku-form__textarea" id="description" name="description" rows={5} />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="maxSupply">
          {CREATOR_COPY.fieldMaxSupply}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldMaxSupplyHint}</p>
        <input
          className="sengoku-form__input"
          id="maxSupply"
          name="maxSupply"
          type="number"
          inputMode="numeric"
          min={1}
          defaultValue={10}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="image">
          {CREATOR_COPY.fieldImage}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldImageHint}</p>
        <input
          className="sengoku-form__file"
          id="image"
          name="image"
          type="file"
          accept="image/png,image/jpeg,image/webp"
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '登録しています…' : CREATOR_COPY.submitNew}
      </button>
    </form>
  );
}
