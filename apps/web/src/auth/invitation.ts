import { acceptInvitationResponseSchema } from '@sengoku/contracts';
import { getWebEnv } from '../env';

/**
 * ログインした直後に、自分宛の招待を引き取る（`UD-803`）。
 *
 * ⚠️ **招待IDを送らない。** 送る形にすると、他人宛の招待IDを指定して
 * 権限を取れる。API 側は、こちらのトークンに入っている
 * **確認済みのメールアドレス**だけを手掛かりに引く。
 *
 * ⚠️ **失敗してもログインを止めない。** 招待が無いのが普通の状態で、
 * ここで転ぶと「メールのリンクを開いたのに入れない」になる。
 * 何が起きても、入れることを優先する。
 */
export async function claimStaffInvitation(accessToken: string): Promise<boolean> {
  const { WEB_API_BASE_URL } = getWebEnv();
  try {
    const response = await fetch(`${WEB_API_BASE_URL}/api/v1/me/staff-invitation/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      return false;
    }
    const parsed = acceptInvitationResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.accepted;
  } catch {
    // 通信できなくてもログインは通す。招待は次に入ったときに引き取れる。
    return false;
  }
}
