import { describe, expect, it } from 'vitest';
import { audienceFor, revisionValues, shouldNotifyRevision } from '../src';

/**
 * 法務文書の改定通知（`UD-127`）。
 *
 * ⚠️ **この組の主題は 2 つ。**
 *  1. **送らない判断が効くこと**——誤字直しで全員へ送ると、次に本当に
 *     大事な改定を送ったときに読まれなくなる
 *  2. **本文をメールへ写さないこと**——写すと版が 2 か所に増え、
 *     食い違ったときにどちらが約束なのか言えなくなる
 */

const PUBLISHED = {
  publishedAt: new Date('2026-08-21T00:00:00.000Z'),
  requiresReconsent: true,
  noticesEnqueuedAt: null,
};

describe('知らせを積むべきか', () => {
  it('公開済みで、再同意が要って、まだ積んでいないなら積む', () => {
    expect(shouldNotifyRevision(PUBLISHED)).toBe(true);
  });

  /*
    ⚠️ **誤字直しで全員へ送らない。** 送るたびに開かれなくなる。
       送らない判断も、送る判断と同じくらい大事である。
  */
  it('再同意が要らない改定では積まない', () => {
    expect(shouldNotifyRevision({ ...PUBLISHED, requiresReconsent: false })).toBe(false);
  });

  /*
    ⚠️ **下書きでは積まない。** 公開をやめたときに「戻します」と
       言って回ることになる。
  */
  it('まだ公開していない版では積まない', () => {
    expect(shouldNotifyRevision({ ...PUBLISHED, publishedAt: null })).toBe(false);
  });

  it('積み終えた版では積み直さない', () => {
    expect(
      shouldNotifyRevision({
        ...PUBLISHED,
        noticesEnqueuedAt: new Date('2026-08-21T01:00:00.000Z'),
      }),
    ).toBe(false);
  });
});

describe('誰に送るか', () => {
  /*
    ⚠️ **その版より前に同意した人だけ。** 同じ版に同意済みの人へ送ると、
       「もう同意しています」という知らせになる。
  */
  it('その版より前に同意した人を対象にする', () => {
    expect(audienceFor({ kind: 'terms', version: 3 })).toEqual({
      kind: 'terms',
      beforeVersion: 3,
    });
  });

  it('文書の種類ごとに分かれる', () => {
    expect(audienceFor({ kind: 'creator_terms', version: 1 }).kind).toBe('creator_terms');
  });
});

describe('差し込む値', () => {
  const format = (value: Date): string => value.toISOString().slice(0, 10);

  /*
    ⚠️ **本文そのものを差し込まない。** 規約は長く、メールへ写すと
       版が 2 か所に増える。読みに行く先だけを渡す。
  */
  it('読みに行く先と施行日を渡す', () => {
    const values = revisionValues({
      documentName: '利用規約',
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      legalUrl: 'https://example.test/legal/terms',
      formatDate: format,
    });
    expect(values).toEqual({
      documentName: '利用規約',
      effectiveFrom: '2026-09-01',
      legalUrl: 'https://example.test/legal/terms',
    });
    // ⚠️ 本文を入れる欄が、そもそも無い。
    expect(Object.keys(values)).not.toContain('bodyText');
  });

  /*
    ⚠️ **施行日が空なのは、こちらの不具合。** 「未定」と書くと、
       利用者には正常な案内に見えてしまい、誰も気づかない。
  */
  it('施行日を取れなかったら、そうと分かる言葉にする', () => {
    const values = revisionValues({
      documentName: '利用規約',
      effectiveFrom: null,
      legalUrl: 'https://example.test/legal/terms',
      formatDate: format,
    });
    expect(values.effectiveFrom).toContain('取得できませんでした');
    expect(values.effectiveFrom).not.toContain('未定');
  });
});
