import { z } from 'zod';

/**
 * 作家さまのプロフィール（決定 2026-08-20）。
 *
 * **屋号・ペンネームを許す。重複は許さない。**
 *
 * ⚠️ **自分の分しか読み書きできない。** 誰の分かを本文で受け取る欄を
 * 作らない。作ると、他人の名前を書き換える道ができる——名乗る名前は
 * 本人のもので、運営が勝手に変えるものではない。
 *
 * ⚠️ **本名を求めない。** 屋号・ペンネームで足りる。本人確認が要るのは
 * お支払いの段（`UD-124`）で、そこは別の仕組みになる。
 */

export const DISPLAY_NAME_MAX = 40;

export const creatorProfileSchema = z.object({
  /** ⚠️ まだ登録していなければ `null`。 */
  displayName: z.string().nullable(),
});
export type CreatorProfileView = z.infer<typeof creatorProfileSchema>;

/**
 * 表示名の登録・変更。
 *
 * ⚠️ **ここでは長さだけ見る。** 見えない文字や運営を名乗る名前の判定は
 * ドメイン（`validateDisplayName`）が持つ。契約側にも書くと、規則が
 * 2 か所になって必ずずれる。
 */
export const updateCreatorProfileRequestSchema = z.object({
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX),
});
export type UpdateCreatorProfileRequest = z.infer<typeof updateCreatorProfileRequestSchema>;
