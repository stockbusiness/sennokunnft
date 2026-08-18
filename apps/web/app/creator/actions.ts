'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  activateListing,
  archiveArtwork,
  createArtwork,
  createListing,
  publishArtwork,
  suspendListing,
  uploadArtworkImage,
  type CreatorResult,
} from '../../src/creator-client';
import { creatorErrorMessage } from '../../src/creator-copy';

/**
 * 出品者の操作。
 *
 * ⚠️ **ここは受け渡しだけを行う。判定はすべて API 側。**
 * 「発行数は公開後に変えられない」「価格は 1 円以上」などの規則を
 * 画面側にも書くと、2 か所に同じ規則ができて必ずずれる。
 * 画面が出すのは**入力の案内**であって、検証ではない。
 *
 * ⚠️ **失敗の理由をそのまま画面へ流さない。**
 * サーバーの応答本文には内部情報が混ざりうる。
 * `creatorErrorMessage` が決まった言葉に置き換える。
 */

export interface ActionState {
  readonly error?: string;
}

/** 画像として受け取ってよい種別。判定は API 側が中身で行う（ここは足切り）。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fail<T>(result: CreatorResult<T>): ActionState {
  return { error: result.ok ? undefined : creatorErrorMessage(result.reason) };
}

export async function createArtworkAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const maxSupply = Number.parseInt(text(form, 'maxSupply'), 10);
  if (!Number.isSafeInteger(maxSupply)) {
    // 数として読めない入力だけは手前で止める。API へ NaN を送っても
    // 意味のある答えが返らないため。値の妥当性は API が判定する。
    return { error: '発行する数は数字で入力してください。' };
  }

  const description = text(form, 'description');
  const created = await createArtwork({
    slug: text(form, 'slug'),
    title: text(form, 'title'),
    ...(description === '' ? {} : { description }),
    maxSupply,
  });
  if (!created.ok) {
    return fail(created);
  }

  // 画像は任意。無くても下書きは作れる（公開するときに要る）。
  const image = form.get('image');
  if (image instanceof File && image.size > 0) {
    if (!IMAGE_TYPES.has(image.type)) {
      // ⚠️ 作品は既にできている。ここで止めても消さない。
      //    消すと「登録できたのか分からない」状態になる。
      return { error: '画像は PNG・JPEG・WebP のいずれかを選んでください。' };
    }
    const uploaded = await uploadArtworkImage(
      created.data.id,
      await image.arrayBuffer(),
      image.type,
    );
    if (!uploaded.ok) {
      return fail(uploaded);
    }
  }

  redirect(`/creator/artworks/${created.data.id}`);
}

export async function uploadImageAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'artworkId');
  const image = form.get('image');
  if (!(image instanceof File) || image.size === 0) {
    return { error: '画像のファイルを選んでください。' };
  }
  if (!IMAGE_TYPES.has(image.type)) {
    return { error: '画像は PNG・JPEG・WebP のいずれかを選んでください。' };
  }

  const uploaded = await uploadArtworkImage(id, await image.arrayBuffer(), image.type);
  if (!uploaded.ok) {
    return fail(uploaded);
  }
  revalidatePath(`/creator/artworks/${id}`);
  return {};
}

export async function publishArtworkAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'artworkId');
  const result = await publishArtwork(id);
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/creator/artworks/${id}`);
  revalidatePath('/creator');
  return {};
}

export async function archiveArtworkAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = text(form, 'artworkId');
  const result = await archiveArtwork(id);
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/creator/artworks/${id}`);
  revalidatePath('/creator');
  return {};
}

export async function createListingAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const artworkId = text(form, 'artworkId');
  const priceAmount = Number.parseInt(text(form, 'priceAmount'), 10);
  if (!Number.isSafeInteger(priceAmount)) {
    return { error: '価格は数字で入力してください。' };
  }

  const result = await createListing({
    artworkId,
    priceAmount,
    // 通貨は当面 JPY 固定（`UD-401` の通貨部分は決定済み）。
    priceCurrency: 'JPY',
  });
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/creator/artworks/${artworkId}`);
  return {};
}

export async function activateListingAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await activateListing(text(form, 'listingId'));
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/creator/artworks/${text(form, 'artworkId')}`);
  revalidatePath('/');
  return {};
}

export async function suspendListingAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await suspendListing(text(form, 'listingId'));
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/creator/artworks/${text(form, 'artworkId')}`);
  revalidatePath('/');
  return {};
}
