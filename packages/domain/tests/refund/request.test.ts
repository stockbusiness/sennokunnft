import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  canApprove,
  categoryOf,
  checkRefundAmount,
  creatorInquiryExpired,
  isExcludedByDefault,
  needsCreatorConfirmation,
  REFUND_REQUEST_REASONS,
  requiresDualApproval,
  suggestDisposition,
} from '../../src/refund/request';

/**
 * 返金の申請と審査（方針整理 2026-08-22）。
 *
 * ⚠️ **この組の主題は 5 つ。**
 *  1. 区分は**理由から決まる**（人が選び直せない）
 *  2. **二重承認は「別の人」でなければ通らない**
 *  3. 調べ終える前に承認できない
 *  4. `claimed` と発行済みは、既定で**取り消さない**
 *  5. 作家さまの期限が過ぎても、**申請は止まらない**
 */
describe('理由と区分', () => {
  /*
    ⚠️ **区分を人に選ばせない。** 選べると、作家さまへの確認が要る理由を
       「運営だけ」にして飛ばせてしまう。
  */
  it('理由から区分が決まる', () => {
    expect(categoryOf('duplicate_payment')).toBe('operator_only');
    expect(categoryOf('not_as_described')).toBe('creator_confirmation');
    expect(categoryOf('buyer_change_of_mind')).toBe('excluded');
  });

  it('すべての理由に区分がある', () => {
    for (const reason of REFUND_REQUEST_REASONS) {
      expect(['operator_only', 'creator_confirmation', 'excluded']).toContain(categoryOf(reason));
    }
    // ⚠️ 空振りでないことを確かめる（語彙が空でない）。
    expect(REFUND_REQUEST_REASONS.length).toBe(15);
  });

  it('チャージバックは運営だけで判断する', () => {
    // ⚠️ もう引かれている。作家さまの回答を待つ意味が無い。
    expect(needsCreatorConfirmation('chargeback')).toBe(false);
  });

  it('権利侵害は作家さまへ確かめる', () => {
    expect(needsCreatorConfirmation('rights_infringement')).toBe(true);
  });

  /*
    ⚠️ **「申請できない」ではない。** 申請は受け付け、既定では却下する。
       受け付けないと、申し出そのものが記録に残らない。
  */
  it('原則対象外でも、申請そのものは区分として表せる', () => {
    expect(isExcludedByDefault('after_transfer')).toBe(true);
    expect(isExcludedByDefault('system_failure')).toBe(false);
  });
});

describe('権利の扱い', () => {
  /*
    ⚠️ **一部返金の既定は「維持」。** 返した額だけでは、どれを取り消すか
       決まらない。
  */
  it('一部返金なら、既定は維持', () => {
    expect(
      suggestDisposition({ entitlementStatus: 'issued', mintStatus: null, isFullRefund: false }),
    ).toBe('keep');
  });

  it('未受取の全額返金なら、既定は取消', () => {
    expect(
      suggestDisposition({ entitlementStatus: 'issued', mintStatus: null, isFullRefund: true }),
    ).toBe('revoke');
  });

  /*
    ⚠️ **受け取り済みは既定で維持。** 回収できない（`UD-104` 追補）。
       取り消すなら、運営が例外として指定する。
  */
  it('受取済みは、全額返金でも既定は維持', () => {
    expect(
      suggestDisposition({ entitlementStatus: 'claimed', mintStatus: null, isFullRefund: true }),
    ).toBe('keep');
  });

  /*
    ⚠️ **外部へ送信済みの可能性があるものは維持。** 取り消したことにすると、
       記録と実物が食い違う。
  */
  it('発行処理中・発行済みは維持', () => {
    expect(
      suggestDisposition({ entitlementStatus: null, mintStatus: 'processing', isFullRefund: true }),
    ).toBe('keep');
    expect(
      suggestDisposition({ entitlementStatus: null, mintStatus: 'succeeded', isFullRefund: true }),
    ).toBe('keep');
  });
});

describe('二重承認', () => {
  /** ⚠️ しきい値が `null` なら使わない。0 を「常に」の意味に使わない。 */
  it('しきい値が無ければ、二重承認は要らない', () => {
    expect(requiresDualApproval({ amount: 1_000_000, thresholdAmount: null })).toBe(false);
  });

  it('しきい値以上なら要る', () => {
    expect(requiresDualApproval({ amount: 50_000, thresholdAmount: 50_000 })).toBe(true);
    expect(requiresDualApproval({ amount: 49_999, thresholdAmount: 50_000 })).toBe(false);
  });

  /*
    ⚠️ **二重承認の要は「別の人であること」。** 同じ人が申請して承認できる
       なら、承認の欄が 1 つ増えただけで歯止めにならない。
  */
  it('同じ人は承認できない', () => {
    expect(
      canApprove({
        status: 'reviewed',
        requestedByAccountId: 'staff-1',
        approverAccountId: 'staff-1',
        dualApprovalRequired: true,
      }),
    ).toEqual({ ok: false, reason: 'same_person' });
  });

  it('別の人なら承認できる', () => {
    expect(
      canApprove({
        status: 'reviewed',
        requestedByAccountId: 'staff-1',
        approverAccountId: 'owner-1',
        dualApprovalRequired: true,
      }),
    ).toEqual({ ok: true });
  });

  /*
    ⚠️ **調べ終える前に承認させない。** 承認だけ先に押せると、作家さまへの
       確認も調査も飛ばした承認ができる。
  */
  it('調べ終える前は承認できない', () => {
    expect(
      canApprove({
        status: 'submitted',
        requestedByAccountId: null,
        approverAccountId: 'owner-1',
        dualApprovalRequired: false,
      }),
    ).toEqual({ ok: false, reason: 'not_reviewed' });
    expect(
      canApprove({
        status: 'creator_review',
        requestedByAccountId: null,
        approverAccountId: 'owner-1',
        dualApprovalRequired: false,
      }),
    ).toEqual({ ok: false, reason: 'not_reviewed' });
  });

  it('決着した申請は承認できない', () => {
    for (const status of ['executed', 'rejected'] as const) {
      expect(
        canApprove({
          status,
          requestedByAccountId: null,
          approverAccountId: 'owner-1',
          dualApprovalRequired: false,
        }),
      ).toEqual({ ok: false, reason: 'already_settled' });
    }
  });
});

describe('作家さまへの確認の期限', () => {
  /*
    ⚠️ **土日を飛ばす。** ⚠️ **祝日は見ていない**——表を持っていないため。
       連休のある月は実際より短くなる。
  */
  it('土日を飛ばして数える', () => {
    // 2026-08-20（木）09:00 JST から 3 営業日 → 8/25（火）。
    const from = new Date('2026-08-20T00:00:00.000Z');
    expect(addBusinessDays(from, 3).toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });

  it('金曜からなら、翌週の水曜になる', () => {
    // 2026-08-21（金）→ 24(月) 25(火) 26(水)。
    const from = new Date('2026-08-21T00:00:00.000Z');
    expect(addBusinessDays(from, 3).toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });

  /*
    ⚠️ **期限が過ぎても申請は止まらない。** 「答えないと返金できない」に
       すると、答えない作家さまがいるだけで購入者が待たされる。
  */
  it('答えていなければ、期限を過ぎたと分かる', () => {
    const dueAt = new Date('2026-08-25T00:00:00.000Z');
    expect(
      creatorInquiryExpired({ dueAt, answeredAt: null, now: new Date('2026-08-26T00:00:00.000Z') }),
    ).toBe(true);
    expect(
      creatorInquiryExpired({ dueAt, answeredAt: null, now: new Date('2026-08-24T00:00:00.000Z') }),
    ).toBe(false);
  });

  it('答えていれば、期限を過ぎても「切れて」いない', () => {
    expect(
      creatorInquiryExpired({
        dueAt: new Date('2026-08-25T00:00:00.000Z'),
        answeredAt: new Date('2026-08-24T00:00:00.000Z'),
        now: new Date('2026-08-30T00:00:00.000Z'),
      }),
    ).toBe(false);
  });
});

describe('金額', () => {
  /** ⚠️ 受け取った額より多く返さない。 */
  it('残額を超えたら断る', () => {
    expect(checkRefundAmount({ amount: 5000, orderTotal: 12000, alreadyRefunded: 8000 })).toEqual({
      ok: false,
      reason: 'exceeds_remaining',
    });
  });

  it('0 円と小数を断る', () => {
    expect(checkRefundAmount({ amount: 0, orderTotal: 12000, alreadyRefunded: 0 }).ok).toBe(false);
    expect(checkRefundAmount({ amount: 1.5, orderTotal: 12000, alreadyRefunded: 0 }).ok).toBe(
      false,
    );
  });

  it('残額ちょうどなら全額返金になる', () => {
    expect(checkRefundAmount({ amount: 4000, orderTotal: 12000, alreadyRefunded: 8000 })).toEqual({
      ok: true,
      isFullRefund: true,
    });
  });

  it('残額に満たなければ一部返金', () => {
    expect(checkRefundAmount({ amount: 3000, orderTotal: 12000, alreadyRefunded: 0 })).toEqual({
      ok: true,
      isFullRefund: false,
    });
  });
});
