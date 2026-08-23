import type { OperationsSeverity } from './dashboard';

/**
 * 記録どうしの食い違いを探す（実運営 指示書 P0-6「システム整合性チェック」）。
 *
 * ⚠️ **直さない。数えるだけ。** 食い違いを見つけた機械が黙って直すと、
 * なぜ食い違ったのかが分からないまま同じことが繰り返される。
 * ここは「どこがおかしいか」を人へ渡すところまで。
 *
 * ⚠️ **0 件が正常。** 1 件でもあれば、どこかで想定していない順序が
 * 起きている。件数が少ないから軽い、ということはない。
 */

/** 何を調べるか。⚠️ 語彙を閉じる。増やすときは意味も一緒に書く。 */
export const CONSISTENCY_CHECK_KEYS = [
  /** 支払い済みなのに、受取権が数量ぶん作られていない注文。 */
  'paid_without_entitlements',
  /** 作品の発行済み数と、実際の受取権の数が合わない。 */
  'supply_drift',
  /** 作品の押さえている数と、実際の仮引当が合わない。 */
  'reserved_count_drift',
  /** 取り消したのに、Wallet へ取消を送っていない受取権（M3a）。 */
  'revoked_without_wallet_notice',
  /** 受取記録があるのに、配送の行が 1 件も無い受取権。 */
  'claimed_without_delivery',
  /** 送信履歴に、伏せていない宛先が入っている（`UD-503`）。 */
  'unmasked_recipient',
] as const;
export type ConsistencyCheckKey = (typeof CONSISTENCY_CHECK_KEYS)[number];

export interface ConsistencyFinding {
  readonly key: ConsistencyCheckKey;
  readonly label: string;
  readonly count: number;
  /**
   * 見つかった対象の識別子（先頭のみ）。
   *
   * ⚠️ **全件を出さない。** 数千件あったときに画面が固まる。
   * 直すのは一覧側の口で、ここは「どこを見ればよいか」の手がかり。
   */
  readonly sampleIds: readonly string[];
  readonly severity: OperationsSeverity;
  readonly action: string;
}

/** 調べた結果の生の値。⚠️ 判定は含めない。 */
export interface ConsistencyCounts {
  readonly paidWithoutEntitlements: readonly string[];
  readonly supplyDrift: readonly string[];
  readonly reservedCountDrift: readonly string[];
  readonly revokedWithoutWalletNotice: readonly string[];
  readonly claimedWithoutDelivery: readonly string[];
  readonly unmaskedRecipient: readonly string[];
}

/** 手がかりとして出す件数の上限。 */
export const CONSISTENCY_SAMPLE_LIMIT = 20;

const DEFINITIONS: Readonly<
  Record<
    ConsistencyCheckKey,
    { readonly label: string; readonly action: string; readonly critical: boolean }
  >
> = {
  paid_without_entitlements: {
    label: 'お支払い済みなのに受取権が足りない注文',
    /*
      ⚠️ **いちばん重い。** お金を受け取っているのに、お渡しするものが
         無い状態そのもの。
    */
    action: '受取権の一覧から発行し直してください。時計が止まっている可能性もあります。',
    critical: true,
  },
  supply_drift: {
    label: '発行済み数と受取権の数が合わない作品',
    /*
      ⚠️ **重い。** 数え間違いは在庫の売り越しにつながる。ただし
         「多く数えている」側なら売り越しは起きないため、まず調べる。
    */
    action: '作品の発行済み数と受取権の実数を照合し、原因を特定してください。自動では直しません。',
    critical: true,
  },
  reserved_count_drift: {
    label: '押さえている数と仮引当が合わない作品',
    /*
      ⚠️ **重い。どちらへずれても困る。**
         多く数えていれば売れるはずの枠が売れず、少なく数えていれば
         売り越しになる。⚠️ **`issued_count` のずれ（`supply_drift`）とは
         別の話。** あちらは発行した数、こちらは「まだ受取権になって
         いない枠」を数えているかどうか。
    */
    action:
      '仮引当の行と受取権の数を突き合わせ、どの注文でずれたかを特定してください。自動では直しません。',
    critical: true,
  },
  revoked_without_wallet_notice: {
    label: '取り消したのにウォレットへ伝えていない受取権',
    action: '取消の知らせの補完（reconcile-revocations）を実行してください。',
    critical: true,
  },
  claimed_without_delivery: {
    label: 'お受け取り済みなのに配送の記録が無い受取権',
    /*
      ⚠️ **黄色。** Wallet へ繋ぐ前に受け取られた分は、これが正常な姿。
         繋いだあとに増えるようなら異常。
    */
    action:
      'ウォレット連携を有効にする前のお受け取りであれば正常です。有効化後に増えていれば調べてください。',
    critical: false,
  },
  unmasked_recipient: {
    label: '伏せていない宛先が残っている送信履歴',
    /*
      ⚠️ **重い。** DB の CHECK があるので本来 0 件。1 件でもあれば、
         制約を迂回した経路があるということ。
    */
    action: '至急、どの経路で入ったかを特定してください。DB の制約を迂回した書き込みがあります。',
    critical: true,
  },
};

/**
 * 生の値から、画面に出す形を作る。
 *
 * ⚠️ **0 件のものも返す。** 消すと「調べたのか、調べていないのか」が
 * 分からない。**調べて 0 件だった**ことを示すのが、この画面の値打ち。
 */
export function buildConsistencyFindings(counts: ConsistencyCounts): readonly ConsistencyFinding[] {
  const entries: readonly [ConsistencyCheckKey, readonly string[]][] = [
    ['paid_without_entitlements', counts.paidWithoutEntitlements],
    ['supply_drift', counts.supplyDrift],
    ['reserved_count_drift', counts.reservedCountDrift],
    ['revoked_without_wallet_notice', counts.revokedWithoutWalletNotice],
    ['claimed_without_delivery', counts.claimedWithoutDelivery],
    ['unmasked_recipient', counts.unmaskedRecipient],
  ];

  return entries.map(([key, ids]) => {
    const definition = DEFINITIONS[key];
    return {
      key,
      label: definition.label,
      count: ids.length,
      sampleIds: ids.slice(0, CONSISTENCY_SAMPLE_LIMIT),
      severity: ids.length === 0 ? 'normal' : definition.critical ? 'critical' : 'warning',
      action: definition.action,
    };
  });
}
