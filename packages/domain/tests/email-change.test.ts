import { describe, expect, it } from 'vitest';
import {
  EMAIL_CHANGE_NOTE_MAX_LENGTH,
  EMAIL_CHANGE_STATUSES,
  completeEmailChange,
  isSettled,
  rejectEmailChange,
  verifyIdentity,
  type EmailChangeStatus,
} from '../src/customer/email-change';

/**
 * ご連絡先の変更申請（実運営 指示書 P1-1）。
 *
 * ⚠️ **この組の主題はひとつ。本人確認を飛ばして「済」にできないこと。**
 * 飛ばされたことは、乗っ取られるまで誰にも分からない。
 */

describe('状態', () => {
  it('4 つだけ', () => {
    expect([...EMAIL_CHANGE_STATUSES]).toEqual([
      'requested',
      'identity_verified',
      'completed',
      'rejected',
    ]);
  });

  it.each(['completed', 'rejected'] as const)('%s は終わっている', (status) => {
    expect(isSettled(status)).toBe(true);
  });

  it.each(['requested', 'identity_verified'] as const)('%s はまだ終わっていない', (status) => {
    expect(isSettled(status)).toBe(false);
  });
});

describe('本人確認', () => {
  it('申し出を受けた状態から記録できる', () => {
    const result = verifyIdentity({
      current: 'requested',
      method: 'order_details_match',
      note: 'ご注文番号と金額が一致しました。',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('identity_verified');
    expect(result.value.method).toBe('order_details_match');
  });

  it('覚え書きは無くてもよい', () => {
    const result = verifyIdentity({
      current: 'requested',
      method: 'identity_document',
      note: null,
    });
    expect(result.ok).toBe(true);
  });

  it('長すぎる覚え書きは断る', () => {
    const result = verifyIdentity({
      current: 'requested',
      method: 'identity_document',
      note: 'あ'.repeat(EMAIL_CHANGE_NOTE_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NOTE_TOO_LONG');
  });

  it.each(['completed', 'rejected'] as const)('%s の申請は動かせない', (current) => {
    const result = verifyIdentity({ current, method: 'order_details_match', note: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ALREADY_SETTLED');
  });
});

describe('済ませる', () => {
  /*
    ⚠️ **この試験がこの仕組みの存在理由。** 本人確認を飛ばして済ませられると、
       この表はただの作業記録になり、何も守らなくなる。
  */
  it('本人確認を飛ばして済ませられない', () => {
    const result = completeEmailChange({ current: 'requested', note: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('IDENTITY_NOT_VERIFIED');
  });

  it('本人確認が済んでいれば済ませられる', () => {
    const result = completeEmailChange({
      current: 'identity_verified',
      note: '認証基盤側で変更しました。',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('completed');
  });

  it.each(['completed', 'rejected'] as const)('%s の申請は済ませ直せない', (current) => {
    const result = completeEmailChange({ current, note: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ALREADY_SETTLED');
  });
});

describe('見送る', () => {
  /*
    ⚠️ **理由の無い見送りは、次の問い合わせで何の役にも立たない。**
  */
  it('理由が要る', () => {
    const result = rejectEmailChange({ current: 'requested', note: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('REJECTION_REQUIRES_NOTE');
  });

  it('空白だけの理由は、書いていないのと同じ', () => {
    const result = rejectEmailChange({ current: 'requested', note: '   ' });
    expect(result.ok).toBe(false);
  });

  it('理由があれば見送れる', () => {
    const result = rejectEmailChange({
      current: 'requested',
      note: 'ご本人であることを確認できませんでした。',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
  });

  /*
    ⚠️ **本人確認の前でも見送れる。** 確認が通らなかったときに
       見送れないと、宙に浮いた申請が溜まる。
  */
  it('本人確認の前でも見送れる', () => {
    const result = rejectEmailChange({
      current: 'requested',
      note: '取り下げのご連絡がありました。',
    });
    expect(result.ok).toBe(true);
  });
});

describe('通しの流れ', () => {
  it('申し出 → 本人確認 → 済', () => {
    let status: EmailChangeStatus = 'requested';

    const verified = verifyIdentity({
      current: status,
      method: 'existing_contact_reply',
      note: null,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    status = verified.value.status;

    const completed = completeEmailChange({ current: status, note: null });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    status = completed.value.status;

    // ⚠️ 済んだあとは、もう動かせない。
    expect(isSettled(status)).toBe(true);
    expect(completeEmailChange({ current: status, note: null }).ok).toBe(false);
  });
});
