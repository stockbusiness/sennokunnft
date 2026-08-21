import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_ATTENTION_KEYS,
  customerAttentions,
  netPaidAmount,
  type CustomerEntitlement,
  type CustomerSummary,
} from '../src/customer/profile';
import {
  DUPLICATE_SIGNALS,
  rankDuplicateCandidates,
  type DuplicateCandidate,
} from '../src/customer/duplicate';

/**
 * 顧客サポート（実運営 指示書 P1-1）。
 *
 * ⚠️ ここで守っているのは 2 つ。
 *  1. **氏名とメールアドレスの平文が、どこにも現れないこと**（`UD-503`）
 *  2. **「候補」を「同一人物」として扱わないこと**——統合はしない
 */

const SUMMARY: CustomerSummary = {
  accountId: 'account-1',
  maskedEmail: 't*****@e******.jp',
  commonUserId: 'cu_0123456789abcdef0123456789abcdef',
  status: 'active',
  orderCount: 3,
  paidAmount: 36_000,
  refundedAmount: 0,
  entitlementCount: 3,
  unclaimedCount: 0,
  firstOrderAt: new Date('2026-08-01T00:00:00.000Z'),
  lastOrderAt: new Date('2026-08-20T00:00:00.000Z'),
};

const CLAIMED: CustomerEntitlement = {
  id: 'ent-1',
  orderNumber: 'SNK-20260820-0001',
  artworkTitle: 'サンプル作品',
  serialNo: 1,
  status: 'claimed',
  walletDeliveryStatus: 'delivered',
  claimedAt: new Date('2026-08-20T01:00:00.000Z'),
  walletDeliveredAt: new Date('2026-08-20T02:00:00.000Z'),
};

function attentions(
  summary: Partial<CustomerSummary> = {},
  entitlements: readonly CustomerEntitlement[] = [CLAIMED],
  hasRefundInProgress = false,
) {
  return customerAttentions({
    summary: { ...SUMMARY, ...summary },
    entitlements,
    hasRefundInProgress,
  });
}

describe('差し引き後の手取り', () => {
  /*
    ⚠️ **画面で引き算をさせない。** 応対中の人が暗算すると間違う。
  */
  it('返金を差し引く', () => {
    expect(netPaidAmount({ ...SUMMARY, paidAmount: 36_000, refundedAmount: 12_000 })).toBe(24_000);
  });

  /*
    ⚠️ **負を隠さない。** 返金が支払いを超えるのは記録の食い違いで、
       0 に丸めると気づけなくなる。
  */
  it('返金が支払いを超えたら負のまま返す', () => {
    expect(netPaidAmount({ ...SUMMARY, paidAmount: 1_000, refundedAmount: 3_000 })).toBe(-2_000);
  });
});

describe('応対の前に知っておくべきこと', () => {
  /*
    ⚠️ **「問題ありません」という行を作らない。** 作ると読み飛ばす習慣がつき、
       問題があるときも読み飛ばされる。
  */
  it('何も無ければ空で返る', () => {
    expect(attentions()).toEqual([]);
  });

  it('停止中のアカウントは真っ先に出る', () => {
    const found = attentions({ status: 'suspended' });
    expect(found[0]?.key).toBe('account_suspended');
  });

  it('お受け取りがまだなら出る', () => {
    const found = attentions({ unclaimedCount: 2 });
    expect(found.map((row) => row.key)).toContain('unclaimed_entitlements');
    expect(found.find((row) => row.key === 'unclaimed_entitlements')?.detail).toContain('2');
  });

  it('受け取り済みなのに届いていなければ出る', () => {
    const found = attentions({}, [{ ...CLAIMED, walletDeliveryStatus: 'pending' }]);
    expect(found.map((row) => row.key)).toContain('wallet_delivery_stalled');
  });

  /*
    ⚠️ **未受取のものを「お届けが滞っている」に混ぜない。** 届ける先が
       そもそも無いので、混ぜると常に出っぱなしになる。
  */
  it('未受取のものは「お届けが滞っている」に数えない', () => {
    const found = attentions({ unclaimedCount: 1 }, [
      { ...CLAIMED, status: 'issued', claimedAt: null, walletDeliveryStatus: 'not_started' },
    ]);
    expect(found.map((row) => row.key)).not.toContain('wallet_delivery_stalled');
  });

  it('共通顧客IDが未解決で、受取権があれば出る', () => {
    const found = attentions({ commonUserId: null, entitlementCount: 1 });
    expect(found.map((row) => row.key)).toContain('common_user_unresolved');
  });

  /*
    ⚠️ **何も買っていない方には出さない。** 出しても、応対する人に
       できることが無い。
  */
  it('何も買っていなければ、共通顧客IDの未解決は出さない', () => {
    const found = attentions({ commonUserId: null, entitlementCount: 0 }, []);
    expect(found.map((row) => row.key)).not.toContain('common_user_unresolved');
  });

  it('返金の手続き中なら出る', () => {
    expect(attentions({}, [CLAIMED], true).map((row) => row.key)).toContain('refund_in_progress');
  });

  it('語彙にない印は出ない', () => {
    const found = attentions(
      { status: 'suspended', unclaimedCount: 1, commonUserId: null },
      [{ ...CLAIMED, walletDeliveryStatus: 'pending' }],
      true,
    );
    for (const row of found) {
      expect(CUSTOMER_ATTENTION_KEYS).toContain(row.key);
    }
  });
});

describe('同じ方かもしれないアカウント', () => {
  const base = {
    maskedEmail: 't*****@e******.jp',
    commonUserId: null,
    status: 'active' as const,
    orderCount: 1,
    entitlementCount: 1,
  };

  /*
    ⚠️ **ご連絡先の一致のほうが強い。** 共通顧客IDは相手（代理店システム）の
       判断で、こちらの判断ではない。
  */
  it('ご連絡先の一致を上に置く', () => {
    const ranked = rankDuplicateCandidates([
      {
        ...base,
        accountId: 'b',
        signals: ['common_user_id'],
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        ...base,
        accountId: 'a',
        signals: ['email_hash'],
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      },
    ]);
    expect(ranked.map((row) => row.accountId)).toEqual(['a', 'b']);
  });

  it('両方一致すればいちばん上', () => {
    const ranked = rankDuplicateCandidates([
      {
        ...base,
        accountId: 'a',
        signals: ['email_hash'],
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        ...base,
        accountId: 'b',
        signals: ['email_hash', 'common_user_id'],
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      },
    ]);
    expect(ranked[0]?.accountId).toBe('b');
  });

  /*
    ⚠️ **並びが実行のたびに変わると、見比べができない。**
  */
  it('同点は作られた順で安定する', () => {
    const rows: DuplicateCandidate[] = [
      {
        ...base,
        accountId: 'new',
        signals: ['email_hash'],
        createdAt: new Date('2026-08-05T00:00:00.000Z'),
      },
      {
        ...base,
        accountId: 'old',
        signals: ['email_hash'],
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ];
    expect(rankDuplicateCandidates(rows).map((row) => row.accountId)).toEqual(['old', 'new']);
    // ⚠️ 元の配列を壊さない（呼び出し元が持ち回る）。
    expect(rows.map((row) => row.accountId)).toEqual(['new', 'old']);
  });

  it('候補が無ければ空', () => {
    expect(rankDuplicateCandidates([])).toEqual([]);
  });

  it('手がかりは 2 種類だけ', () => {
    expect([...DUPLICATE_SIGNALS]).toEqual(['email_hash', 'common_user_id']);
  });
});
