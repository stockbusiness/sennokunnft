import { describe, expect, it } from 'vitest';
import {
  allowedVariables,
  decideNotification,
  canResendNotification,
  isRetryableMailOutcome,
  mailErrorCodeFor,
  maskEmail,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_MAX_ATTEMPTS,
  referencedVariables,
  renderTemplate,
  subjectTypeOf,
  validateTemplate,
} from '../src/index';

describe('知らせの種別', () => {
  it('すべての種別に対象の種類が決まっている', () => {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      // ⚠️ 語彙そのものと突き合わせる。書き写すと、足したときに片方が古くなる。
      expect(NOTIFICATION_SUBJECT_TYPES).toContain(subjectTypeOf(eventType));
    }
    /*
      ⚠️ **数を書いておく。** 種別を足すのは「全購入者へ届く経路が増える」
         ということ。ここが落ちて手が止まるのは、そのための仕掛けである。
    */
    expect(NOTIFICATION_EVENT_TYPES).toHaveLength(11);
  });

  it('⚠️ 差し込み語彙に氏名・メール・住所を入れない（UD-503）', () => {
    // 語彙に無ければ、文面へ書きようがない。
    const forbidden = ['email', 'mail', 'name', 'address', 'phone', 'tel'];
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      for (const variable of allowedVariables(eventType)) {
        const lower = variable.toLowerCase();
        /*
          ⚠️ **人を指す語だけを弾く。** `siteName`（事業者名）・
             `artworkTitle`（作品名）・`documentName`（文書の題）は、
             どれも人ではない。除外を足すときは、**それが人を指さないこと**を
             確かめてから足すこと。
        */
        const notAboutPeople = ['sitename', 'artworktitle', 'documentname'];
        for (const word of forbidden) {
          if (notAboutPeople.includes(lower)) continue;
          expect(lower.includes(word), `${eventType}.${variable}`).toBe(false);
        }
      }
    }
  });

  it('⚠️ 金額の語を持つのは、金額を伝える知らせだけ', () => {
    expect(allowedVariables('payment.failed')).not.toContain('totalAmount');
    expect(allowedVariables('payment.succeeded')).toContain('totalAmount');
    expect(allowedVariables('refund.completed')).toContain('refundAmount');
  });
});

describe('文面の検査', () => {
  it('その種別で使える語だけを許す', () => {
    const ok = validateTemplate({
      eventType: 'payment.succeeded',
      subject: '【{{siteName}}】お支払いを確認しました',
      body: '{{orderNumber}} / {{totalAmount}} / {{orderUrl}}',
    });
    expect(ok.ok).toBe(true);
  });

  it('⚠️ 語彙に無い語は公開の時点で弾く（送る時点ではない）', () => {
    const result = validateTemplate({
      eventType: 'payment.succeeded',
      subject: '件名',
      body: 'ようこそ {{buyerEmail}} 様',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOTIFICATION_TEMPLATE_UNKNOWN_VARIABLE');
    }
  });

  it('⚠️ 件名に改行を入れさせない（ヘッダ差し込みを防ぐ）', () => {
    const result = validateTemplate({
      eventType: 'order.placed',
      subject: '件名\nBcc: attacker@example.test',
      body: '{{orderNumber}}',
    });
    expect(result.ok).toBe(false);
  });

  it('空の件名・本文を弾く', () => {
    expect(validateTemplate({ eventType: 'order.placed', subject: '  ', body: 'x' }).ok).toBe(
      false,
    );
    expect(validateTemplate({ eventType: 'order.placed', subject: 'x', body: '  ' }).ok).toBe(
      false,
    );
  });

  it('差し込み語を重複なく拾う', () => {
    expect(referencedVariables('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });
});

describe('文面の差し込み', () => {
  it('値を差し込む', () => {
    const result = renderTemplate(
      { eventType: 'payment.succeeded', subject: '{{orderNumber}}', body: '{{totalAmount}}' },
      { orderNumber: 'ORD-1', totalAmount: '1,000 円' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.subject).toBe('ORD-1');
      expect(result.value.body).toBe('1,000 円');
    }
  });

  it('⚠️ 値が足りなければ落とす（空文字で埋めない）', () => {
    const result = renderTemplate(
      { eventType: 'payment.succeeded', subject: '{{orderNumber}}', body: '{{totalAmount}}' },
      { orderNumber: 'ORD-1' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOTIFICATION_RENDER_INCOMPLETE');
    }
  });

  it('⚠️ 差し込んだ値の中の記法を再帰的に展開しない', () => {
    const result = renderTemplate(
      { eventType: 'entitlement.delivered', subject: 'x', body: '{{artworkTitle}}' },
      { artworkTitle: '{{orderNumber}}', orderNumber: 'ORD-1' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 展開すると、作品名に書いた文字列から別の値を引き出せてしまう。
      expect(result.value.body).toBe('{{orderNumber}}');
    }
  });
});

describe('宛先の伏せ方', () => {
  it('先頭 1 文字と TLD だけ残す', () => {
    expect(maskEmail('tanaka@example.jp')).toBe('t*****@e******.jp');
  });

  it('⚠️ 1 文字の局所部でも中身を出さない', () => {
    expect(maskEmail('a@b.jp')).toBe('*@*.jp');
  });

  it('⚠️ 形の壊れた値でも中身を出さない', () => {
    expect(maskEmail('not-an-email')).toBe('n***********');
    expect(maskEmail('@example.jp')).toBe('@**********');
  });

  it('伏せた結果に元の局所部が残らない', () => {
    const masked = maskEmail('tanaka@example.jp');
    expect(masked.includes('tanaka')).toBe(false);
    expect(masked.includes('example')).toBe(false);
  });
});

describe('送信後の扱い', () => {
  const context = { attemptCount: 1, maxAttempts: NOTIFICATION_MAX_ATTEMPTS };

  it('受け付けられたら SENT', () => {
    const decision = decideNotification({ kind: 'accepted', providerMessageId: 'm1' }, context);
    expect(decision.next).toBe('SENT');
  });

  it('⚠️ 宛先が悪い（4xx）は再試行しない', () => {
    expect(isRetryableMailOutcome({ kind: 'rejected', statusCode: 422 })).toBe(false);
    const decision = decideNotification({ kind: 'rejected', statusCode: 422 }, context);
    expect(decision.next).toBe('FAILED');
  });

  it('5xx と 429 は再試行する', () => {
    expect(isRetryableMailOutcome({ kind: 'rejected', statusCode: 503 })).toBe(true);
    expect(isRetryableMailOutcome({ kind: 'rejected', statusCode: 429 })).toBe(true);
    const decision = decideNotification({ kind: 'rejected', statusCode: 503 }, context);
    expect(decision.next).toBe('PENDING');
  });

  it('上限を超えたら DEAD（FAILED と分ける）', () => {
    const decision = decideNotification(
      { kind: 'timeout' },
      { attemptCount: NOTIFICATION_MAX_ATTEMPTS, maxAttempts: NOTIFICATION_MAX_ATTEMPTS },
    );
    expect(decision.next).toBe('DEAD');
  });

  it('失敗の符号に応答本文を混ぜない', () => {
    expect(mailErrorCodeFor({ kind: 'rejected', statusCode: 500 })).toBe('http_500');
    expect(mailErrorCodeFor({ kind: 'timeout' })).toBe('timeout');
  });

  it('⚠️ 送り直せるのは失敗した知らせだけ', () => {
    expect(canResendNotification('FAILED')).toBe(true);
    expect(canResendNotification('DEAD')).toBe(true);
    expect(canResendNotification('SENT')).toBe(false);
    expect(canResendNotification('PROCESSING')).toBe(false);
    // 送らないと決めたものを、一覧の見た目のために送れるようにしない。
    expect(canResendNotification('SKIPPED')).toBe(false);
  });
});
