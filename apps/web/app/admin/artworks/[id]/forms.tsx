'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import {
  archiveArtworkAction,
  deleteArtworkAction,
  publishArtworkAction,
  updateArtworkAction,
  uploadArtworkImageAction,
  type AdminActionState,
} from '../../actions';
import { ADMIN_COPY } from '../../../../src/admin-copy';

const INITIAL: AdminActionState = {};

/**
 * 運営の操作ボタン。
 *
 * ⚠️ **押せるが何も起きないボタンを置かない。** 動くと思って操作した人が、
 * 失敗に気付けない。押せるものは必ずサーバーへ届き、結果を返す。
 *
 * ⚠️ **送信中は押せなくする。** 二度押しで同じ操作が 2 回走らないように。
 */

export function ArtworkEditForm({
  artworkId,
  title,
  description,
  maxSupply,
  supplyEditable,
}: {
  readonly artworkId: string;
  readonly title: string;
  readonly description: string;
  readonly maxSupply: number;
  /** 公開後は発行数を変えられない。変えられないものは触らせない。 */
  readonly supplyEditable: boolean;
}) {
  const [state, action, pending] = useActionState(updateArtworkAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="title">
          作品名
        </label>
        <input
          className="sengoku-form__input"
          id="title"
          name="title"
          type="text"
          defaultValue={title}
          maxLength={120}
          required
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="description">
          説明
        </label>
        <textarea
          className="sengoku-form__input"
          id="description"
          name="description"
          rows={5}
          maxLength={4000}
          defaultValue={description}
        />
      </div>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="maxSupply">
          発行する数
        </label>
        {supplyEditable ? (
          <input
            className="sengoku-form__input"
            id="maxSupply"
            name="maxSupply"
            type="number"
            inputMode="numeric"
            min={1}
            defaultValue={maxSupply}
          />
        ) : (
          /*
            ⚠️ 入力欄を出したまま無効にしない。触れる形で置くと、
               直せるはずだと思わせてしまう。理由を書いて数だけ見せる。
          */
          <p className="sengoku-form__hint">
            {maxSupply}（公開後は変更できません。増やすと購入済みの方の前提が、
            減らすと発行済みの数との整合が崩れるためです）
          </p>
        )}
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '直しています…' : ADMIN_COPY.submitEdit}
      </button>
    </form>
  );
}

export function ArtworkImageForm({
  artworkId,
  hasImage,
}: {
  readonly artworkId: string;
  /** まだ 1 枚も無いときに「入れ替える」と書かない。何を指しているか分からない。 */
  readonly hasImage: boolean;
}) {
  const [state, action, pending] = useActionState(uploadArtworkImageAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />
      <p className="sengoku-form__hint">{ADMIN_COPY.imageHint}</p>
      <input
        className="sengoku-form__file"
        name="image"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        required
      />
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending
          ? '登録しています…'
          : hasImage
            ? ADMIN_COPY.submitImageReplace
            : ADMIN_COPY.submitImage}
      </button>
    </form>
  );
}

export function ArtworkPublishButton({ artworkId }: { readonly artworkId: string }) {
  const [state, action, pending] = useActionState(publishArtworkAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />
      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '公開しています…' : ADMIN_COPY.submitPublish}
      </button>
    </form>
  );
}

export function ArtworkArchiveButton({ artworkId }: { readonly artworkId: string }) {
  const [state, action, pending] = useActionState(archiveArtworkAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />
      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '処理しています…' : ADMIN_COPY.submitArchive}
      </button>
    </form>
  );
}

/**
 * 作品を完全に消す。
 *
 * ⚠️ **確認の言葉を打たせる。** 取り消せない操作を 1 クリックの
 * 届く場所に置かない。ブラウザの確認ダイアログにしないのは、
 * 出ない環境があるうえ、勢いで「OK」を押せてしまうため。
 */
export function ArtworkDeleteForm({ artworkId }: { readonly artworkId: string }) {
  const [state, action, pending] = useActionState(deleteArtworkAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      <Notice tone="alert" title={ADMIN_COPY.deleteWarning} hint={ADMIN_COPY.deleteHint} />
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      <input type="hidden" name="artworkId" value={artworkId} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor="confirm">
          {ADMIN_COPY.deleteConfirmLabel}
        </label>
        <input
          className="sengoku-form__input"
          id="confirm"
          name="confirm"
          type="text"
          autoComplete="off"
          required
        />
      </div>

      <button className="sengoku-button sengoku-button--danger" type="submit" disabled={pending}>
        {pending ? '消しています…' : ADMIN_COPY.submitDelete}
      </button>
    </form>
  );
}
