'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import {
  activateListingAction,
  archiveArtworkAction,
  createListingAction,
  publishArtworkAction,
  suspendListingAction,
  uploadImageAction,
  type ActionState,
} from '../../actions';
import { CREATOR_COPY } from '../../../../src/creator-copy';

const INITIAL: ActionState = {};

/**
 * 出品者の操作ボタン。
 *
 * ⚠️ **押せるが何も起きないボタンを置かない。** 動くと思って操作した人が、
 * 失敗に気付けない。押せるものは必ずサーバーへ届き、結果を返す。
 *
 * ⚠️ **送信中は押せなくする。** 二度押しで同じ操作が 2 回走らないように。
 * 冪等キーは API 側にもあるが、画面でも止めておくほうが親切。
 */

export function ImageForm({ artworkId }: { readonly artworkId: string }) {
  const [state, action, pending] = useActionState(uploadImageAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />
      <p className="sengoku-form__hint">{CREATOR_COPY.fieldImageHint}</p>
      <input
        className="sengoku-form__file"
        name="image"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        required
      />
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '登録しています…' : '画像を登録する'}
      </button>
    </form>
  );
}

export function PublishButton({ artworkId }: { readonly artworkId: string }) {
  const [state, action, pending] = useActionState(publishArtworkAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '公開しています…' : CREATOR_COPY.submitPublish}
      </button>
    </form>
  );
}

export function ArchiveButton({ artworkId }: { readonly artworkId: string }) {
  const [state, action, pending] = useActionState(archiveArtworkAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '処理しています…' : CREATOR_COPY.submitArchive}
      </button>
    </form>
  );
}

export function ListingForm({ artworkId }: { readonly artworkId: string }) {
  const [state, action, pending] = useActionState(createListingAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="priceAmount">
          {CREATOR_COPY.fieldPrice}
        </label>
        <p className="sengoku-form__hint">{CREATOR_COPY.fieldPriceHint}</p>
        <input
          className="sengoku-form__input"
          id="priceAmount"
          name="priceAmount"
          type="number"
          inputMode="numeric"
          min={1}
          required
        />
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '処理しています…' : CREATOR_COPY.submitListing}
      </button>
    </form>
  );
}

export function ListingStateButtons({
  artworkId,
  listingId,
  status,
}: {
  readonly artworkId: string;
  readonly listingId: string;
  readonly status: string;
}) {
  const [activateState, activate, activating] = useActionState(activateListingAction, INITIAL);
  const [suspendState, suspend, suspending] = useActionState(suspendListingAction, INITIAL);
  const error = activateState.error ?? suspendState.error;

  return (
    <>
      {error === undefined ? null : <Notice tone="alert" title={error} />}
      {status === 'active' ? (
        <form className="sengoku-form" action={suspend}>
          <input type="hidden" name="artworkId" value={artworkId} />
          <input type="hidden" name="listingId" value={listingId} />
          <button
            className="sengoku-button sengoku-button--quiet"
            type="submit"
            disabled={suspending}
          >
            {suspending ? '処理しています…' : CREATOR_COPY.submitSuspend}
          </button>
        </form>
      ) : (
        <form className="sengoku-form" action={activate}>
          <input type="hidden" name="artworkId" value={artworkId} />
          <input type="hidden" name="listingId" value={listingId} />
          <button className="sengoku-button" type="submit" disabled={activating}>
            {activating ? '処理しています…' : CREATOR_COPY.submitActivate}
          </button>
        </form>
      )}
    </>
  );
}
