import { describe, expect, it } from 'vitest';
import {
  LEGAL_BODY_MAX,
  LEGAL_TITLE_MAX,
  TOKUSHOHO_FIELD_KEYS,
  effectiveVersion,
  isErr,
  isOk,
  missingTokushohoFields,
  publishLegalVersion,
  renderLegalBody,
  saveLegalDraft,
  unwrap,
  type LegalDocumentKind,
  type LegalDocumentVersion,
  type TokushohoFields,
} from '../src/index';

const NOW = new Date('2026-08-19T00:00:00.000Z');

function filledTokushoho(): TokushohoFields {
  return Object.fromEntries(
    TOKUSHOHO_FIELD_KEYS.map((key) => [key, `値: ${key}`]),
  ) as unknown as TokushohoFields;
}

function emptyTokushoho(): TokushohoFields {
  return Object.fromEntries(
    TOKUSHOHO_FIELD_KEYS.map((key) => [key, '']),
  ) as unknown as TokushohoFields;
}

function draft(
  kind: LegalDocumentKind,
  overrides: Partial<LegalDocumentVersion> = {},
): LegalDocumentVersion {
  return {
    id: 'version-1',
    kind,
    version: 1,
    status: 'draft',
    title: '利用規約',
    bodyText: kind === 'tokushoho' ? null : '本文です。',
    tokushoho: kind === 'tokushoho' ? filledTokushoho() : null,
    effectiveFrom: null,
    requiresReconsent: false,
    publishedAt: null,
    createdByAccountId: 'account-1',
    publishedByAccountId: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('公開済みの版は書き換えられない', () => {
  it('下書きでなければ保存を断る', () => {
    const published = draft('terms', { status: 'published', effectiveFrom: NOW, publishedAt: NOW });
    const result = saveLegalDraft(published, { title: '書き換え', bodyText: 'あとから直す' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('LEGAL_VERSION_NOT_DRAFT');
    }
  });

  it('公開済みを二重に公開しない', () => {
    const published = draft('terms', { status: 'published', effectiveFrom: NOW, publishedAt: NOW });
    const result = publishLegalVersion({
      version: published,
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      publishedByAccountId: 'account-1',
      requiresReconsent: false,
      now: NOW,
      currentEffectiveFrom: null,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('LEGAL_VERSION_NOT_DRAFT');
    }
  });
});

describe('HTML は保存の時点で断る', () => {
  /*
    ⚠️ 描画側で無視するだけにすると、別の描画経路（メール・PDF）が
       できたときにそちらへ流れる。入口で止める。
  */
  for (const body of ['<script>alert(1)</script>', '<img src=x>', 'ふつうの文<b>太字</b>']) {
    it(`本文に HTML があれば断る: ${body.slice(0, 20)}`, () => {
      const result = saveLegalDraft(draft('terms'), { title: '利用規約', bodyText: body });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe('LEGAL_DOCUMENT_INVALID');
      }
    });
  }

  it('不等号そのものは通してよい（`5 < 10` のような文）', () => {
    const result = saveLegalDraft(draft('terms'), {
      title: '利用規約',
      bodyText: '数量が 5 < 10 の場合',
    });
    expect(isOk(result)).toBe(true);
  });

  it('長すぎる本文を断る', () => {
    const result = saveLegalDraft(draft('terms'), {
      title: '利用規約',
      bodyText: 'あ'.repeat(LEGAL_BODY_MAX + 1),
    });
    expect(isErr(result)).toBe(true);
  });

  it('長すぎる表題を断る', () => {
    const result = saveLegalDraft(draft('terms'), {
      title: 'あ'.repeat(LEGAL_TITLE_MAX + 1),
      bodyText: '本文',
    });
    expect(isErr(result)).toBe(true);
  });
});

describe('特商法の表記', () => {
  it('下書きでは空欄を許す（書きかけで保存できる）', () => {
    const result = saveLegalDraft(draft('tokushoho', { tokushoho: emptyTokushoho() }), {
      title: '特定商取引法に基づく表記',
      tokushoho: emptyTokushoho(),
    });
    expect(isOk(result)).toBe(true);
  });

  it('欠けたままでは公開させない', () => {
    const version = draft('tokushoho', { tokushoho: emptyTokushoho() });
    const result = publishLegalVersion({
      version,
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      publishedByAccountId: 'account-1',
      requiresReconsent: false,
      now: NOW,
      currentEffectiveFrom: null,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('LEGAL_DOCUMENT_INCOMPLETE');
    }
  });

  it('欠けている項目の名前を返す（どこを直せばよいか分かる）', () => {
    const fields = { ...filledTokushoho(), phoneNumber: '', returnPolicy: '   ' };
    expect(missingTokushohoFields(fields)).toEqual(['phoneNumber', 'returnPolicy']);
  });

  it('12 項目すべてを対象にする（法で示すべき項目の数）', () => {
    expect(TOKUSHOHO_FIELD_KEYS).toHaveLength(12);
    expect(missingTokushohoFields(null)).toHaveLength(12);
  });

  it('埋まっていれば公開できる', () => {
    const result = publishLegalVersion({
      version: draft('tokushoho'),
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      publishedByAccountId: 'account-1',
      requiresReconsent: false,
      now: NOW,
      currentEffectiveFrom: null,
    });
    expect(isOk(result)).toBe(true);
  });
});

describe('施行日', () => {
  it('過去の日付では公開できない（過去の注文に効く版が入れ替わる）', () => {
    const result = publishLegalVersion({
      version: draft('terms'),
      effectiveFrom: new Date('2026-08-18T00:00:00.000Z'),
      publishedByAccountId: 'account-1',
      requiresReconsent: false,
      now: NOW,
      currentEffectiveFrom: null,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('LEGAL_EFFECTIVE_DATE_INVALID');
    }
  });

  it('いま施行中の版より前の日付では公開できない', () => {
    const result = publishLegalVersion({
      version: draft('terms'),
      effectiveFrom: new Date('2026-08-20T00:00:00.000Z'),
      publishedByAccountId: 'account-1',
      requiresReconsent: false,
      now: NOW,
      currentEffectiveFrom: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(isErr(result)).toBe(true);
  });

  it('未来の日付を指定できる（公開の予約）', () => {
    const effectiveFrom = new Date('2026-09-01T00:00:00.000Z');
    const result = publishLegalVersion({
      version: draft('terms'),
      effectiveFrom,
      publishedByAccountId: 'account-9',
      requiresReconsent: false,
      now: NOW,
      currentEffectiveFrom: null,
    });
    expect(isOk(result)).toBe(true);
    const published = unwrap(result);
    expect(published.status).toBe('published');
    expect(published.effectiveFrom).toEqual(effectiveFrom);
    expect(published.publishedByAccountId).toBe('account-9');
  });

  it('本文が空のままでは公開できない', () => {
    const result = publishLegalVersion({
      version: draft('terms', { bodyText: '   ' }),
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      publishedByAccountId: 'account-1',
      requiresReconsent: false,
      now: NOW,
      currentEffectiveFrom: null,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('LEGAL_DOCUMENT_INCOMPLETE');
    }
  });
});

describe('いま施行されている版を選ぶ', () => {
  const older = draft('terms', {
    id: 'v1',
    version: 1,
    status: 'published',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    publishedAt: NOW,
  });
  const newer = draft('terms', {
    id: 'v2',
    version: 2,
    status: 'published',
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    publishedAt: NOW,
  });
  const scheduled = draft('terms', {
    id: 'v3',
    version: 3,
    status: 'published',
    effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
    publishedAt: NOW,
  });
  const pending = draft('terms', { id: 'v4', version: 4 });

  it('施行日が来ているうち、いちばん新しいものを選ぶ', () => {
    expect(effectiveVersion([older, newer, scheduled, pending], NOW)?.id).toBe('v2');
  });

  it('施行日が来ていない版は選ばない（公開済み＝いま有効ではない）', () => {
    expect(effectiveVersion([scheduled], NOW)).toBeNull();
  });

  it('下書きは決して選ばない', () => {
    expect(effectiveVersion([pending], NOW)).toBeNull();
  });

  it('施行日をまたぐと、選ばれる版が入れ替わる', () => {
    const after = new Date('2026-12-02T00:00:00.000Z');
    expect(effectiveVersion([newer, scheduled], after)?.id).toBe('v3');
  });
});

describe('本文の組み直し', () => {
  it('HTML 文字列を作らない（構造だけを返す）', () => {
    const blocks = renderLegalBody('## 第1条\n本文です。\n- ひとつ\n- ふたつ\n\n次の段落。');
    expect(blocks).toEqual([
      { type: 'heading', text: '第1条' },
      { type: 'paragraph', text: '本文です。' },
      { type: 'list', items: ['ひとつ', 'ふたつ'] },
      { type: 'paragraph', text: '次の段落。' },
    ]);
  });

  it('空文字なら何も返さない', () => {
    expect(renderLegalBody('')).toEqual([]);
  });

  it('段落の中の改行は保つ（条文は行の切れ目に意味がある）', () => {
    expect(renderLegalBody('1行目\n2行目')).toEqual([{ type: 'paragraph', text: '1行目\n2行目' }]);
  });
});
