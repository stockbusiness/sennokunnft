import { describe, expect, it } from 'vitest';
import {
  BUYER_REFUND_REASON_VALUES,
  REFUND_REQUEST_REASON_VALUES,
  REFUND_REQUEST_STATUS_VALUES,
} from '@sengoku/contracts';
import {
  buyerRefundReasonLabel,
  entitlementDispositionLabel,
  REFUND_REQUEST_COPY,
  receivableStatusLabel,
  refundCategoryLabel,
  refundEventLabel,
  refundReasonLabel,
  refundRequestStatusLabel,
  refundRequestStatusTone,
} from './refund-request-copy';

/**
 * 返金の申請と審査の画面文言（方針整理 2026-08-22）。
 *
 * ⚠️ **ここで見たいのは 4 つ。**
 *  1. 言葉が抜けている状態を作らないこと（符号がそのまま画面へ出ない）
 *  2. **作家さまへ「返金する」と読める言葉を出さないこと**——作家さまが
 *     返金を実行する口は、この仕組みに存在しない
 *  3. **購入者へ「返金されます」と読める言葉を出さないこと**——お受けした
 *     ことと、お返しすることは別である
 *  4. `executed` を「よかった」の色にしないこと
 */

describe('状態の言葉', () => {
  it('すべての状態に言葉がある', () => {
    for (const status of REFUND_REQUEST_STATUS_VALUES) {
      const label = refundRequestStatusLabel(status);
      expect(label).not.toBe('');
      // ⚠️ 符号がそのまま出ていないこと。
      expect(label).not.toBe(status);
    }
  });

  it('お返し済みを「よかった」の色にしない', () => {
    /*
      ⚠️ **お金が出ていった記録であって、めでたい結果ではない。** 緑にすると、
         返金の多い月ほど一覧が明るく見える。
    */
    expect(refundRequestStatusTone('executed')).toBe('neutral');
  });

  it('却下を赤にしない（正しい判断の結果でもある）', () => {
    expect(refundRequestStatusTone('rejected')).toBe('neutral');
  });

  it('送れなかったものだけを赤にする', () => {
    expect(refundRequestStatusTone('execution_failed')).toBe('danger');
  });
});

describe('事由の言葉', () => {
  it('すべての事由に言葉がある', () => {
    for (const reason of REFUND_REQUEST_REASON_VALUES) {
      expect(refundReasonLabel(reason)).not.toBe(reason);
      expect(refundReasonLabel(reason)).not.toBe('');
    }
  });

  it('購入者が選べる事由には、購入者向けの言葉がある', () => {
    for (const reason of BUYER_REFUND_REASON_VALUES) {
      expect(buyerRefundReasonLabel(reason)).not.toBe('');
    }
  });

  it('購入者には分からない事由を選択肢に出さない', () => {
    /*
      ⚠️ **チャージバックは決済会社から届く事実。** 人が申し出る事由ではない。
    */
    expect(BUYER_REFUND_REASON_VALUES).not.toContain('chargeback');
    expect(BUYER_REFUND_REASON_VALUES).not.toContain('wrong_grant');
    expect(BUYER_REFUND_REASON_VALUES).not.toContain('fraudulent_use');
  });

  it('Web3 の言葉を出さない', () => {
    // ⚠️ 40 代以上に分かる言葉にする（`UI 方針`）。
    const all = REFUND_REQUEST_REASON_VALUES.map(refundReasonLabel).join('');
    for (const forbidden of ['NFT', 'Mint', 'ミント', 'ウォレット', 'Wallet', 'トークン']) {
      expect(all).not.toContain(forbidden);
    }
  });
});

describe('作家さまへお見せする言葉', () => {
  /*
    ⚠️ **この試験がこの組のいちばんの主題。** 作家さまが決済会社へ返金を
       投げる口は無い。言葉だけ置くと「押せば返せる」と思われる——そして
       「押しても動かない」と言われ、動くように直そうという話になる。
  */
  it('作家さま向けの文言に「返金する」操作を書かない', () => {
    const creatorFacing = [
      REFUND_REQUEST_COPY.creatorTitle,
      REFUND_REQUEST_COPY.creatorDescription,
      REFUND_REQUEST_COPY.creatorAnswerLabel,
      REFUND_REQUEST_COPY.creatorAnswerHint,
      REFUND_REQUEST_COPY.creatorSubmit,
      REFUND_REQUEST_COPY.creatorEmpty,
      REFUND_REQUEST_COPY.receivablesHint,
    ].join('');

    for (const forbidden of ['返金する', '返金します', 'ご返金します', '返金を実行']) {
      expect(creatorFacing).not.toContain(forbidden);
    }
  });

  it('決めるのは運営だと、作家さまへ伝えている', () => {
    expect(REFUND_REQUEST_COPY.creatorDescription).toContain('運営');
    // ⚠️ 可否の欄が無い理由を、その場で書いてある。
    expect(REFUND_REQUEST_COPY.creatorAnswerHint).toContain('ありません');
  });

  it('期限を過ぎても受け付けると伝えている', () => {
    /*
      ⚠️ **「もう遅い」と読ませない。** 遅れて届いた事実にも値打ちがある。
    */
    expect(REFUND_REQUEST_COPY.creatorExpiredHint).toContain('お受けします');
  });
});

describe('購入者へお見せする言葉', () => {
  it('お受けした時点で返金を約束しない', () => {
    /*
      ⚠️ **ここを曖昧に書くと、断ったときに「話が違う」になる。**
         そしてそれは、こちらの書き方が悪い。
    */
    expect(REFUND_REQUEST_COPY.buyerHint).toContain('決まるものではありません');
    expect(REFUND_REQUEST_COPY.buyerSent).not.toContain('ご返金します');
    expect(REFUND_REQUEST_COPY.buyerSubmit).not.toContain('返金する');
  });

  it('お申し出の欄に金額の案内を置かない', () => {
    const buyerFacing = [
      REFUND_REQUEST_COPY.buyerHint,
      REFUND_REQUEST_COPY.buyerReasonLabel,
      REFUND_REQUEST_COPY.buyerStatementLabel,
      REFUND_REQUEST_COPY.buyerStatementHint,
    ].join('');
    expect(buyerFacing).not.toContain('金額');
  });
});

describe('運営へお見せする言葉', () => {
  it('決済会社が受け付けただけだと伝えている', () => {
    // ⚠️ 「入金された」と読ませない。ここを曖昧にすると問い合わせが増える。
    expect(REFUND_REQUEST_COPY.executeCaution).toContain('受け付けた');
    expect(REFUND_REQUEST_COPY.executed(1000)).toContain('数日');
  });

  it('運営の記録が誰にも見えないことを、その場で書いてある', () => {
    expect(REFUND_REQUEST_COPY.noteHint).toContain('表示されません');
  });

  it('金額の再入力の理由を書いてある', () => {
    expect(REFUND_REQUEST_COPY.approveHint).toContain('もう一度');
  });
});

describe('その他の言葉', () => {
  it('区分が「選び直せる」と読めない', () => {
    // ⚠️ 事由から決まる。画面で選ばせない。
    expect(refundCategoryLabel('operator_only')).not.toBe('');
    expect(refundCategoryLabel('creator_confirmation')).not.toBe('');
    expect(refundCategoryLabel('excluded')).not.toBe('');
  });

  it('デジタル会員証の扱いに言葉がある', () => {
    expect(entitlementDispositionLabel('revoke')).toBe('取り消す');
    expect(entitlementDispositionLabel('keep')).toBe('そのまま残す');
  });

  it('お戻しの状態に言葉がある', () => {
    for (const status of ['outstanding', 'offset', 'settled', 'written_off'] as const) {
      expect(receivableStatusLabel(status)).not.toBe(status);
    }
  });

  it('知らない経過は符号のまま出す（行が消えるほうが困る）', () => {
    expect(refundEventLabel('refund_request.opened')).toBe('お申し出をお受けしました');
    // ⚠️ 新しい操作を足したときに、経過からその行が消えないこと。
    expect(refundEventLabel('refund_request.something_new')).toBe('refund_request.something_new');
  });
});
