'use server';

import { revalidatePath } from 'next/cache';
import { answerRefundInquiry } from '../../../src/creator-client';
import { creatorErrorMessage } from '../../../src/creator-copy';
import { REFUND_REQUEST_COPY as COPY } from '../../../src/refund-request-copy';
import type { ActionState } from '../actions';

/**
 * 事実確認へのご回答（方針整理 2026-08-22）。
 *
 * ⚠️ **ここに「返金する」操作を足さない。** 作家さまが決済会社へ返金を
 * 投げる経路は、この仕組みに存在しない。販売の代金は運営の決済アカウントで
 * 受けているので、返せるのも運営だけである。
 *
 * ⚠️ **「返金してよい・いけない」を送る欄も作らない。** 伺うのは事実で、
 * 決めるのは運営である。可否の欄があると、答えが「反対」で埋まったときに
 * 運営が返金しづらくなる。
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function answerRefundInquiryAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const requestId = text(form, 'requestId');
  const answer = text(form, 'answer');
  if (answer === '') {
    return { error: `${COPY.creatorAnswerLabel}をご入力ください。` };
  }

  const result = await answerRefundInquiry(requestId, { answer });
  if (!result.ok) {
    /*
      ⚠️ **「すでに答えている」と「あなた宛てではない」を分けない。**
         分けると、別の方宛ての依頼があることを教えてしまう。API 側も
         同じ符号にそろえてある。
    */
    if (result.code === 'REFUND_REQUEST_NOT_ACTIONABLE') {
      return { error: COPY.creatorAlreadyAnswered };
    }
    return { error: creatorErrorMessage(result.reason, result.code) };
  }

  revalidatePath('/creator/refund-inquiries');
  return { done: true };
}
