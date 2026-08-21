/**
 * 運営が朝いちばんに見る画面の中身（実運営 指示書 P0-6）。
 *
 * ⚠️ **赤は「いま手を動かす必要がある」ときだけ。** 数が多いだけで赤く
 * すると、運営は毎朝赤を見ることになり、そのうち見なくなる。**赤が
 * 意味を持つのは、赤でないときがある場合だけ**である。
 *
 * ⚠️ **ここに時計を持たない。** 現在時刻は呼び出し元が渡す。持たせると、
 * 「止まっている」の判定を試験で再現できなくなる。
 */

/** 見出しの色。⚠️ 3 段しか無い。増やすと運営が優先順位を決められない。 */
export const OPERATIONS_SEVERITIES = [
  /** 平常。 */
  'normal',
  /** 気に留める。⚠️ **今日中に見ればよい。** */
  'warning',
  /** **いま手を動かす。** 放置すると利用者に実害が出る。 */
  'critical',
] as const;
export type OperationsSeverity = (typeof OPERATIONS_SEVERITIES)[number];

/**
 * 集計の生の値。
 *
 * ⚠️ **判定を含めない。** どこを赤くするかは下の関数が決める。
 * 数え上げる側が色まで決めると、しきい値を変えるのに SQL を触ることになる。
 */
export interface OperationsCounts {
  /** 本日（JST）の注文数と売上。⚠️ 売上は支払い済みのみ。 */
  readonly todayOrderCount: number;
  readonly todayPaidAmount: number;
  readonly todayPaidCount: number;
  /** 本日の決済失敗件数。 */
  readonly todayPaymentFailedCount: number;
  /** 受取権の発行待ち・発行を打ち切った注文。 */
  readonly issuancePendingCount: number;
  readonly issuanceFailedCount: number;
  /** Wallet への配送待ち・打ち切り。 */
  readonly walletDeliveryPendingCount: number;
  readonly walletDeliveryFailedCount: number;
  /** 人の確認を待っていること（返金の確定不能を含む）。 */
  readonly operationsReviewOpenCount: number;
  /** 知らせの送信待ち・打ち切り。 */
  readonly notificationPendingCount: number;
  readonly notificationFailedCount: number;
  /** 外部サービスの接続確認の失敗（直近）。 */
  readonly integrationFailureCount: number;
  /** 決済事業者からの知らせを最後に受け取った時刻。 */
  readonly lastWebhookReceivedAt: Date | null;
}

/** 時計仕掛けの最後の成功。⚠️ **無い＝一度も成功していない。** */
export interface JobHeartbeat {
  readonly jobKey: string;
  readonly lastSucceededAt: Date | null;
  readonly lastFailedAt: Date | null;
  readonly lastOutcome: 'succeeded' | 'failed' | null;
}

/**
 * しきい値。
 *
 * ⚠️ **設定として外に出す。** 運用が始まってから必ず調整することになる。
 * 定数で埋めると、そのたびにデプロイが要る。
 */
export interface OperationsThresholds {
  /** これを超えて時計が動いていなければ赤。 */
  readonly jobStaleAfterMinutes: number;
  /** これを超えて決済事業者から音沙汰が無ければ気に留める。 */
  readonly webhookQuietAfterMinutes: number;
}

export const DEFAULT_OPERATIONS_THRESHOLDS: OperationsThresholds = {
  /*
    ⚠️ **日次の時計に合わせない。** 発行と配送は 1 時間ごとに回す前提で、
       2 巡ぶん止まっていたら異常とみなす。日次に合わせると、
       止まってから丸一日気づけない。
  */
  jobStaleAfterMinutes: 150,
  webhookQuietAfterMinutes: 24 * 60,
};

/** 画面に出す 1 項目。 */
export interface OperationsIndicator {
  readonly key: string;
  readonly label: string;
  /** 数える対象が無い項目（最終受信日時など）は `null`。 */
  readonly count: number | null;
  readonly severity: OperationsSeverity;
  /**
   * 何をすればよいか。
   *
   * ⚠️ **赤に必ず添える。** 「異常です」だけ出しても、受け取った人は
   * 次の一手が分からない。分からないまま放置されるくらいなら、
   * 出さないほうがまだ害が少ない。
   */
  readonly action: string | null;
}

/**
 * 数え上げた値から、画面に出す形を作る。
 *
 * ⚠️ **赤にするのは 4 つだけ。**
 *   1. 発行を打ち切った注文がある——**お金を受け取ったのに渡せていない**
 *   2. 人の確認を待っていることがある——機械が決められなかった
 *   3. 時計が止まっている——止まると、上の 2 つが増え続ける
 *   4. 知らせの送信を打ち切った——買った方が状況を知る手立てを失う
 *
 * ⚠️ **「待ち」は赤にしない。** 待ちは仕組みが動いている証拠で、
 * 次の巡回で減る。赤くすると、正常な状態が毎朝赤く見える。
 */
export function buildIndicators(input: {
  readonly counts: OperationsCounts;
  readonly jobs: readonly JobHeartbeat[];
  readonly thresholds: OperationsThresholds;
  readonly now: Date;
}): readonly OperationsIndicator[] {
  const { counts, thresholds, now } = input;

  return [
    {
      key: 'today_orders',
      label: '本日のご注文',
      count: counts.todayOrderCount,
      severity: 'normal',
      action: null,
    },
    {
      key: 'today_paid_amount',
      label: '本日の売上（税込）',
      count: counts.todayPaidAmount,
      severity: 'normal',
      action: null,
    },
    {
      key: 'today_paid_count',
      label: '本日のお支払い成立',
      count: counts.todayPaidCount,
      severity: 'normal',
      action: null,
    },
    {
      key: 'today_payment_failed',
      label: '本日のお支払い不成立',
      /*
        ⚠️ **失敗は起きるもの。** カードの残高不足や有効期限切れは日常で、
           こちらに直せることは無い。件数だけ見えていればよい。
      */
      count: counts.todayPaymentFailedCount,
      severity: 'normal',
      action: null,
    },
    {
      key: 'issuance_pending',
      label: '受取権の発行待ち',
      count: counts.issuancePendingCount,
      // ⚠️ 待ちは正常。次の巡回で減る。
      severity: 'normal',
      action: null,
    },
    {
      key: 'issuance_failed',
      label: '受取権の発行を打ち切り',
      count: counts.issuanceFailedCount,
      /*
        ⚠️ **ここは赤。** お金を受け取ったのに、お渡しするものが
           作れていない。放っておくと利用者に実害が残る。
      */
      severity: counts.issuanceFailedCount > 0 ? 'critical' : 'normal',
      action:
        counts.issuanceFailedCount > 0
          ? '受取権の一覧から、失敗した注文を確かめて発行し直してください。'
          : null,
    },
    {
      key: 'wallet_delivery_pending',
      label: 'ウォレットへのお届け待ち',
      count: counts.walletDeliveryPendingCount,
      severity: 'normal',
      action: null,
    },
    {
      key: 'wallet_delivery_failed',
      label: 'ウォレットへのお届けを打ち切り',
      count: counts.walletDeliveryFailedCount,
      /*
        ⚠️ **黄色。** 相手側の障害であることが多く、こちらの手当ては
           相手の復旧を待ってから。ただし放置はしない。
      */
      severity: counts.walletDeliveryFailedCount > 0 ? 'warning' : 'normal',
      action:
        counts.walletDeliveryFailedCount > 0
          ? 'お届けの一覧で理由を確かめ、相手側が復旧していれば送り直してください。'
          : null,
    },
    {
      key: 'operations_review_open',
      label: '人の確認を待っていること',
      count: counts.operationsReviewOpenCount,
      // ⚠️ 赤。機械が決められなかったことで、誰かが見るまで動かない。
      severity: counts.operationsReviewOpenCount > 0 ? 'critical' : 'normal',
      action:
        counts.operationsReviewOpenCount > 0
          ? '確認事項の一覧を開き、対応のうえ印を付けてください。'
          : null,
    },
    {
      key: 'notification_pending',
      label: '知らせの送信待ち',
      count: counts.notificationPendingCount,
      severity: 'normal',
      action: null,
    },
    {
      key: 'notification_failed',
      label: '知らせの送信を打ち切り',
      count: counts.notificationFailedCount,
      /*
        ⚠️ **赤。** 買った方が状況を知る手立てを失っている。
           こちらは「送ったつもり」でいるので、気づけるのはここだけ。
      */
      severity: counts.notificationFailedCount > 0 ? 'critical' : 'normal',
      action:
        counts.notificationFailedCount > 0
          ? '知らせの履歴で理由を確かめ、直したうえで送り直してください。'
          : null,
    },
    {
      key: 'integration_failure',
      label: '外部サービスの接続確認の失敗',
      count: counts.integrationFailureCount,
      severity: counts.integrationFailureCount > 0 ? 'warning' : 'normal',
      action:
        counts.integrationFailureCount > 0
          ? '外部サービスの画面で、接続先と資格情報を確かめてください。'
          : null,
    },
    webhookIndicator(counts.lastWebhookReceivedAt, thresholds, now),
    ...input.jobs.map((job) => jobIndicator(job, thresholds, now)),
  ];
}

/**
 * 決済事業者からの音沙汰。
 *
 * ⚠️ **「静か」を赤にしない。** 注文が無ければ知らせも来ない。
 * 売れていない日と、Webhook が壊れている日は、ここからは区別できない。
 * **区別できないことを赤で断言しない。**
 */
function webhookIndicator(
  lastReceivedAt: Date | null,
  thresholds: OperationsThresholds,
  now: Date,
): OperationsIndicator {
  if (lastReceivedAt === null) {
    return {
      key: 'webhook_last_received',
      label: '決済の知らせの最終受信',
      count: null,
      // ⚠️ 一度も受け取っていない。繋ぐ前ならこれが正常。
      severity: 'warning',
      action: '決済事業者からの知らせをまだ一度も受け取っていません。設定をご確認ください。',
    };
  }
  const quiet =
    now.getTime() - lastReceivedAt.getTime() > thresholds.webhookQuietAfterMinutes * 60_000;
  return {
    key: 'webhook_last_received',
    label: '決済の知らせの最終受信',
    count: null,
    severity: quiet ? 'warning' : 'normal',
    action: quiet
      ? '決済事業者からの知らせが長く届いていません。ご注文が無いだけかもしれませんが、設定もご確認ください。'
      : null,
  };
}

/**
 * 時計仕掛けの生死。
 *
 * ⚠️ **止まっていることは赤。** 発行も配送も知らせも、止まれば全部
 * 溜まる。しかも溜まっている側の指標は「待ち」として黄色にもならない
 * ので、**ここが唯一の気づき口**になる。
 */
function jobIndicator(
  job: JobHeartbeat,
  thresholds: OperationsThresholds,
  now: Date,
): OperationsIndicator {
  const label = `${jobLabel(job.jobKey)}の最終成功`;
  if (job.lastSucceededAt === null) {
    return {
      key: `job_${job.jobKey}`,
      label,
      count: null,
      /*
        ⚠️ **一度も成功していない。** 繋ぐ前ならこれが正常なので、
           黄色にとどめる。赤にすると、立ち上げの日から赤で埋まる。
      */
      severity: 'warning',
      action: 'この処理はまだ一度も成功していません。時計の設定をご確認ください。',
    };
  }
  const stale =
    now.getTime() - job.lastSucceededAt.getTime() > thresholds.jobStaleAfterMinutes * 60_000;
  return {
    key: `job_${job.jobKey}`,
    label,
    count: null,
    severity: stale ? 'critical' : 'normal',
    action: stale
      ? 'この処理が長く成功していません。止まっているあいだ、発行やお届けが溜まり続けます。'
      : null,
  };
}

/** 時計仕掛けの呼び名。⚠️ 運営に伝わる言葉で。内部の識別子を出さない。 */
export const JOB_LABELS: Readonly<Record<string, string>> = {
  'release-expired-reservations': 'お取り置きの解放',
  'issue-entitlements': '受取権の発行',
  'deliver-entitlements': 'ウォレットへのお届け',
  'reconcile-revocations': '取消の知らせの補完',
  'send-notifications': '知らせの送信',
};

function jobLabel(jobKey: string): string {
  return JOB_LABELS[jobKey] ?? jobKey;
}

/** 画面全体でいちばん重い色。⚠️ 一覧の先頭に出す。 */
export function overallSeverity(indicators: readonly OperationsIndicator[]): OperationsSeverity {
  if (indicators.some((row) => row.severity === 'critical')) {
    return 'critical';
  }
  if (indicators.some((row) => row.severity === 'warning')) {
    return 'warning';
  }
  return 'normal';
}
