'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import type { CreatorProfileDetailView } from '@sengoku/contracts';
import { updateShopProfileAction, type ActionState } from './actions';
import { CREATOR_COPY } from '../../src/creator-copy';

const INITIAL: ActionState = {};

/** 入力欄の組の数。⚠️ `actions.ts` の `LINK_SLOTS` と同じ数にする。 */
const LINK_SLOTS = 5;

/**
 * お店の情報を書くフォーム。
 *
 * ⚠️ **誰の分かを送らない。** アカウントは API がトークンから決める。
 *
 * ⚠️ **`maxLength` 以上の検証を書かない。** `https` かどうか、インボイス
 * 登録番号の形は API 側が判定する。画面にも書くと 2 か所になり、片方だけ
 * 直したときに「画面は通るのに保存できない」が生まれる。
 *
 * ⚠️ **`type="url"` にしない。** ブラウザの既定の検証は `http://` も
 * 通してしまい、「画面は通ったのに断られた」になる。判定は API に任せ、
 * 案内の文で `https://` だけと伝える。
 */
export function ShopProfileForm({ current }: { current: CreatorProfileDetailView }) {
  const [state, action, pending] = useActionState(updateShopProfileAction, INITIAL);

  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {/* ⚠️ 色ではなく言葉で伝える。 */}
      {state.done === true ? <Notice title={CREATOR_COPY.shopSaved} /> : null}

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="shopName">
          {CREATOR_COPY.fieldShopName}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldShopNameHint}</p>
        <input
          className="sengoku-form__input"
          id="shopName"
          name="shopName"
          type="text"
          maxLength={60}
          /* ⚠️ 打った値を初期値にする。空欄から始めると全部打ち直しになる。 */
          defaultValue={current.shopName ?? ''}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="bio">
          {CREATOR_COPY.fieldBio}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldBioHint}</p>
        <textarea
          className="sengoku-form__input"
          id="bio"
          name="bio"
          rows={6}
          maxLength={2000}
          defaultValue={current.bio ?? ''}
        />
      </div>

      <fieldset className="sengoku-form__field">
        <legend className="sengoku-form__label">{CREATOR_COPY.fieldLinks}</legend>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldLinksHint}</p>
        {Array.from({ length: LINK_SLOTS }, (_unused, index) => {
          const link = current.links[index];
          return (
            <div className="sengoku-link-row" key={index}>
              <label className="sengoku-visually-hidden" htmlFor={`linkLabel${String(index)}`}>
                {`${String(index + 1)} 件目の名前`}
              </label>
              <input
                className="sengoku-form__input"
                id={`linkLabel${String(index)}`}
                name={`linkLabel${String(index)}`}
                type="text"
                maxLength={30}
                placeholder="名前（例: X）"
                defaultValue={link?.label ?? ''}
              />
              <label className="sengoku-visually-hidden" htmlFor={`linkUrl${String(index)}`}>
                {`${String(index + 1)} 件目のお住所`}
              </label>
              <input
                className="sengoku-form__input"
                id={`linkUrl${String(index)}`}
                name={`linkUrl${String(index)}`}
                type="text"
                inputMode="url"
                placeholder="https://"
                defaultValue={link?.url ?? ''}
              />
            </div>
          );
        })}
      </fieldset>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="invoiceNumber">
          {CREATOR_COPY.fieldInvoiceNumber}
        </label>
        {/* ⚠️ 「任意」を先に書く。免税事業者の方に不安を持たせない。 */}
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldInvoiceNumberHint}</p>
        <input
          className="sengoku-form__input"
          id="invoiceNumber"
          name="invoiceNumber"
          type="text"
          inputMode="text"
          maxLength={14}
          defaultValue={current.invoiceNumber ?? ''}
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '保存しています…' : CREATOR_COPY.submitShop}
      </button>
    </form>
  );
}
