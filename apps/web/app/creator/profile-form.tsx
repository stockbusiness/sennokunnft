'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import { DISPLAY_NAME_MAX } from '@sengoku/contracts';
import { updateDisplayNameAction, type ActionState } from './actions';
import { CREATOR_COPY } from '../../src/creator-copy';

const INITIAL: ActionState = {};

/**
 * 作品ページに出すお名前を決めるフォーム。
 *
 * ⚠️ **誰の分かを送らない。** アカウントは API がトークンから決める。
 * 隠し欄で送れる形にすると、そこが他人の名前を書き換える道になる。
 *
 * ⚠️ **「使えるかどうか」を打ちながら確かめる仕掛けを作らない。**
 * 一文字ごとに問い合わせると、登録済みのお名前を総当たりで集められる。
 * 送ってから答える。
 *
 * ⚠️ **`maxLength` 以上の検証を画面に書かない。** 見えない文字や
 * 運営とまぎらわしい語の判定はサーバーが持つ。画面にも書くと 2 か所になる。
 */
export function DisplayNameForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(updateDisplayNameAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {/* ⚠️ 色ではなく言葉で伝える。「登録しました」と書く。 */}
      {state.done === true ? <Notice title={CREATOR_COPY.displayNameSaved} /> : null}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="displayName">
          {CREATOR_COPY.fieldDisplayName}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldDisplayNameHint}</p>
        <input
          className="sengoku-form__input"
          id="displayName"
          name="displayName"
          type="text"
          maxLength={DISPLAY_NAME_MAX}
          /*
            ⚠️ **打った値を初期値にする。** 空欄から始めると、変えるつもりが
               無いのに全部打ち直すことになる。
          */
          defaultValue={current ?? ''}
          required
        />
        <p className="sengoku-form__hint">{CREATOR_COPY.displayNameChangeHint}</p>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '登録しています…' : CREATOR_COPY.submitDisplayName}
      </button>
    </form>
  );
}
