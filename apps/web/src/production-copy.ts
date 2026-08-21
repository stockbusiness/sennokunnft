import type { ProductionReadinessCheckView } from '@sengoku/contracts';
import type { StatusToneName } from '@sengoku/ui';

/**
 * 本番販売ガードの言葉（P0-7）。
 *
 * ⚠️ **「あと少し」と言わない。** 9 つ満たしていても売れない。
 * 「もうすぐ」と読ませると、足りない 1 つが軽く見える。
 */
export const PRODUCTION_COPY = {
  title: '本番販売の準備',
  description:
    'すべての条件がそろうまで、本番のお支払い口は作られません。ひとつずつ確かめてください。',
  readyTitle: '本番販売を始められます。',
  readyHint: '条件は毎回確かめ直されます。どれかが崩れると、その時点で止まります。',
  notReadyTitle: 'まだ本番販売を始められません。',
  attestationsTitle: '押された記録',
  attestationsDescription:
    '通し試験と承認の記録です。⚠️ **消せません。** 訂正は、新しい記録を足して表します。',
  noteWarning: '⚠️ 鍵や合言葉を書かないでください。この欄はそのまま保存され、消せません。',
} as const;

/** 充足の色。⚠️ 満たしていないものだけが赤。 */
export function checkTone(satisfied: boolean): StatusToneName {
  return satisfied ? 'success' : 'danger';
}

export function checkLabel(satisfied: boolean): string {
  return satisfied ? 'そろっています' : 'まだです';
}

/**
 * 先頭に出す一言。
 *
 * ⚠️ **件数で安心させない。** 「10 件中 9 件」と書くと、残る 1 つが
 * 些細に見える。売れないことは、9 件そろっていても変わらない。
 */
export function readinessMessage(ready: boolean, enforced: boolean): string {
  if (ready) {
    return PRODUCTION_COPY.readyTitle;
  }
  return enforced
    ? PRODUCTION_COPY.notReadyTitle
    : 'この環境では止めませんが、本番では下の条件がそろうまでお支払い口を作れません。';
}

/** この環境で実際に止まるか。⚠️ 止まらない環境では、その旨をはっきり出す。 */
export function enforcementNote(enforced: boolean, environment: string): string {
  return enforced
    ? '条件が未達のあいだ、本番のお支払い口は作られません。'
    : `ここは ${environment} です。条件が未達でもお支払い口は作れます（試すためです）。`;
}

export function attestationKindLabel(kind: string): string {
  switch (kind) {
    case 'e2e_sale_test':
      return '通し試験';
    case 'owner_approval':
      return '責任者の承認';
    default:
      return kind;
  }
}

export function attestationResultLabel(succeeded: boolean): string {
  return succeeded ? '成立' : '不成立';
}

/** 満たしていない条件だけを、上から順に。 */
export function unsatisfied(
  checks: readonly ProductionReadinessCheckView[],
): readonly ProductionReadinessCheckView[] {
  return checks.filter((row) => !row.satisfied);
}
