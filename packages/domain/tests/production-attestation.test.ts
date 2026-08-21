import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_KINDS,
  ATTESTATION_NOTE_MAX_LENGTH,
  decideAttestation,
  isAttestationKind,
} from '../src/production/attestation';

/** 人が残す証跡（実運営 指示書 P0-7）。 */

const BASE = {
  kind: 'e2e_sale_test' as const,
  succeeded: true,
  credentialId: 'cred-1',
  attestedByAccountId: 'owner-1',
  note: null as string | null,
};

describe('種別', () => {
  it('2 種類だけ', () => {
    expect([...ATTESTATION_KINDS]).toEqual(['e2e_sale_test', 'owner_approval']);
  });

  it('知らない種別は通さない', () => {
    expect(isAttestationKind('anything_goes')).toBe(false);
  });
});

describe('記録してよいか', () => {
  it('成功はそのまま記録できる', () => {
    const result = decideAttestation(BASE);
    expect(result.ok).toBe(true);
  });

  /*
    ⚠️ **「通りませんでした」だけの記録は、次に読む人の手がかりにならない。**
  */
  it('不成立には覚え書きが要る', () => {
    const result = decideAttestation({ ...BASE, succeeded: false, note: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('FAILURE_REQUIRES_NOTE');
  });

  it('空白だけの覚え書きは、書いていないのと同じ', () => {
    const result = decideAttestation({ ...BASE, succeeded: false, note: '  \n  ' });
    expect(result.ok).toBe(false);
  });

  it('不成立でも、理由があれば記録できる', () => {
    const result = decideAttestation({
      ...BASE,
      succeeded: false,
      note: 'お届けまで進まず、配送の巡回で止まりました。',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.succeeded).toBe(false);
  });

  it('長すぎる覚え書きは断る（詳しくは別の資料へ）', () => {
    const result = decideAttestation({
      ...BASE,
      note: 'あ'.repeat(ATTESTATION_NOTE_MAX_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NOTE_TOO_LONG');
  });

  it('前後の空白は落とす', () => {
    const result = decideAttestation({ ...BASE, note: '  通しました  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.note).toBe('通しました');
  });

  /*
    ⚠️ **順序を強制しない。** 10 条件が満たされる前でも承認は記録できる。
       強制すると、鍵の切り替え日に合わせて段取りする運用ができなくなる。
       押した記録は残り、条件の判定は毎回やり直されるので、
       早く押しても近道にはならない。
  */
  it('条件が満たされる前でも、承認そのものは記録できる', () => {
    const result = decideAttestation({ ...BASE, kind: 'owner_approval' });
    expect(result.ok).toBe(true);
  });

  /*
    ⚠️ **どの世代についての記録かを必ず持つ。** 型で必須にしてあるので
       省略できないが、値が写ることをここで確かめる。
  */
  it('どの決済世代についての記録かが残る', () => {
    const result = decideAttestation({ ...BASE, credentialId: 'cred-9' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.credentialId).toBe('cred-9');
    expect(result.command.attestedByAccountId).toBe('owner-1');
  });
});
