'use server';

import type { AdminOrderView } from '@sengoku/contracts';
import { lookupAdminOrdersByEmail } from '../../../src/admin-client';
import { adminErrorMessage } from '../../../src/admin-copy';
import { ORDER_COPY } from '../../../src/order-copy';

/**
 * メールアドレスからの照合（`UD-121`）。
 *
 * ⚠️ **平文をここへ残さない。** 受け取ってすぐ API へ渡し、
 * 戻す状態にも通知にも載せない。ログにも出さない（`UD-503`）。
 *
 * ⚠️ **URL へ載せない。** 一覧の検索は GET でよいが、これだけは
 * サーバーアクション経由の POST にしてある。問い合わせ文字列は
 * アクセスログ・ブラウザ履歴・共有されたリンクに残る。
 */
export interface EmailLookupState {
  readonly error?: string;
  /**
   * 見つかった注文。⚠️ 購入者を特定する情報は含めない。
   *
   * ⚠️ **`undefined`（まだ押していない）と `[]`（引いたが 0 件）を分ける。**
   * 同じにすると、画面を開いただけで「見つかりませんでした」と出る。
   */
  readonly items?: readonly AdminOrderView[];
}

export async function lookupOrdersByEmailAction(
  _previous: EmailLookupState,
  form: FormData,
): Promise<EmailLookupState> {
  const raw = form.get('email');
  const email = typeof raw === 'string' ? raw.trim() : '';
  if (email === '') {
    return { error: ORDER_COPY.emailLookupLabel + 'をご入力ください。' };
  }

  const result = await lookupAdminOrdersByEmail(email);
  if (!result.ok) {
    /*
      ⚠️ **「見つかりません」に丸めない。** 鍵の無い配備では
         `EMAIL_LOOKUP_UNAVAILABLE` が返る。0 件と同じ見せ方にすると、
         問い合わせてきた方に「そのご注文はありません」と、
         事実でないことを答えることになる。
    */
    if (result.reason === 'unavailable' && result.code === 'EMAIL_LOOKUP_UNAVAILABLE') {
      return { error: ORDER_COPY.emailLookupUnavailable };
    }
    return { error: adminErrorMessage(result.reason) };
  }

  return { items: result.data.items };
}
