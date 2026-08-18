'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  archiveAdminArtwork,
  deleteAdminArtwork,
  publishAdminArtwork,
  updateAdminArtwork,
  uploadAdminArtworkImage,
  type AdminResult,
} from '../../src/admin-client';
import { ADMIN_COPY, adminErrorMessage } from '../../src/admin-copy';

/**
 * 運営の操作。
 *
 * ⚠️ **ここは受け渡しだけを行う。判定はすべて API 側。**
 * 「公開中は消せない」「発行済みがあると消せない」などの規則を
 * 画面側にも書くと、2 か所に同じ規則ができて必ずずれる。
 * 画面が出すのは**操作の案内**であって、検証ではない。
 *
 * ⚠️ **失敗の理由をそのまま画面へ流さない。**
 * サーバーの応答本文には内部情報が混ざりうる。
 * `adminErrorMessage` が決まった言葉に置き換える。
 */

export interface AdminActionState {
  readonly error?: string;
}

/** 画像として受け取ってよい種別。判定は API 側が中身で行う（ここは足切り）。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fail<T>(result: AdminResult<T>): AdminActionState {
  return { error: result.ok ? undefined : adminErrorMessage(result.reason, result.code) };
}

export async function updateArtworkAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'artworkId');
  const rawSupply = text(form, 'maxSupply');

  const input: { title?: string; description?: string; maxSupply?: number } = {
    title: text(form, 'title'),
    description: text(form, 'description'),
  };

  if (rawSupply !== '') {
    const maxSupply = Number.parseInt(rawSupply, 10);
    if (!Number.isSafeInteger(maxSupply)) {
      // 数として読めない入力だけは手前で止める。API へ NaN を送っても
      // 意味のある答えが返らないため。値の妥当性は API が判定する。
      return { error: '発行する数は数字で入力してください。' };
    }
    input.maxSupply = maxSupply;
  }

  const result = await updateAdminArtwork(id, input);
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/admin/artworks/${id}`);
  revalidatePath('/admin/artworks');
  return {};
}

export async function uploadArtworkImageAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'artworkId');
  const image = form.get('image');
  if (!(image instanceof File) || image.size === 0) {
    return { error: '画像のファイルを選んでください。' };
  }
  if (!IMAGE_TYPES.has(image.type)) {
    return { error: '画像は PNG・JPEG・WebP のいずれかを選んでください。' };
  }

  const result = await uploadAdminArtworkImage(id, await image.arrayBuffer(), image.type);
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/admin/artworks/${id}`);
  return {};
}

export async function publishArtworkAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'artworkId');
  const result = await publishAdminArtwork(id);
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/admin/artworks/${id}`);
  revalidatePath('/admin/artworks');
  // 公開ページの見え方も変わる。
  revalidatePath('/');
  return {};
}

export async function archiveArtworkAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'artworkId');
  const result = await archiveAdminArtwork(id);
  if (!result.ok) {
    return fail(result);
  }
  revalidatePath(`/admin/artworks/${id}`);
  revalidatePath('/admin/artworks');
  revalidatePath('/');
  return {};
}

/**
 * 作品を完全に消す。
 *
 * ⚠️ **合言葉の入力を要求する。** 「本当によろしいですか」の確認だけでは、
 * 消すつもりが無い人でも勢いで押せてしまう。取り消せない操作なので、
 * 手を止める仕掛けを 1 つ挟む。
 *
 * ⚠️ **この確認は保護ではない。** 画面を経由せずに API を叩けば
 * 通らないので、消してよいかの判定は API 側にある。ここは事故を減らすだけ。
 */
export async function deleteArtworkAction(
  _previous: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const id = text(form, 'artworkId');
  if (text(form, 'confirm') !== ADMIN_COPY.deleteConfirmWord) {
    return { error: ADMIN_COPY.deleteConfirmMismatch };
  }

  const result = await deleteAdminArtwork(id);
  if (!result.ok) {
    return fail(result);
  }

  revalidatePath('/admin/artworks');
  revalidatePath('/admin/listings');
  revalidatePath('/');
  // 詳細画面はもう開けない。一覧へ戻す。
  redirect('/admin/artworks');
}
