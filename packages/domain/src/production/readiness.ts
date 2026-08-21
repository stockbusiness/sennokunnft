import type { LegalDocumentKind } from '../legal/document';
import type { JobHeartbeat } from '../operations/dashboard';

/**
 * 本番販売を始めてよいか（実運営 指示書 P0-7）。
 *
 * **売れる状態と、売ってよい状態は別である。** 支払い口を作る仕組みは
 * 動いていても、規約が掲げられていない・鍵の接続が確かめられていない・
 * 誰も責任を引き受けていない、という状態で売ると、返せない・届けられない・
 * 説明できないことが起きる。起きてから直すのでは間に合わない。
 *
 * ⚠️ **分からないことは「満たしていない」へ倒す。** 記録が無いことを
 * 「たぶん大丈夫」と読むと、この仕組みは何も守らない。**証拠が無い＝未達**。
 *
 * ⚠️ **画面を隠すだけにしない。** 判定は API 側で使い、条件未達なら
 * 本番の支払い口を作らせない。画面を隠しても API は直接叩ける。
 *
 * ⚠️ **ここに時計も DB も持たない。** 事実は呼び出し元が集めて渡す。
 * 持たせると、10 条件それぞれの境目を試験で再現できなくなる。
 */

/** 何を確かめるか。⚠️ 語彙を閉じる。増やすときは判定と文言も一緒に書く。 */
export const PRODUCTION_READINESS_CHECKS = [
  /** 1. 決済事業者の本番の鍵が、受付中の世代として有効。 */
  'payment_credential_active',
  /** 2. その世代に Webhook の署名鍵があり、実際に受信できている。 */
  'webhook_signature_configured',
  /** 3. 手数料率が承認済み（0 は「未設定」であって「無料」ではない）。 */
  'platform_fee_rate_approved',
  /** 4. 規約・プライバシー・特商法の 3 つが施行中。 */
  'legal_documents_published',
  /** 5. OVEW Wallet への接続が確かめられている。 */
  'wallet_connection_verified',
  /** 6. メールの送信経路が確かめられている。 */
  'mail_connection_verified',
  /** 7. 受取権の発行と Wallet へのお届けの時計が動いている。 */
  'jobs_running',
  /** 8. 運営責任者が二要素で入っている（`UD-801` の段階導入・段 4）。 */
  'admin_mfa_satisfied',
  /** 9. 直近の通し試験（E2E 販売試験）が成功している。 */
  'e2e_sale_test_passed',
  /** 10. 運営責任者の承認記録がある。 */
  'owner_approval_recorded',
] as const;
export type ProductionReadinessCheckKey = (typeof PRODUCTION_READINESS_CHECKS)[number];

/**
 * しきい値。
 *
 * ⚠️ **設定として外に出す。** 運用が始まってから必ず調整することになる。
 * 定数で埋めると、そのたびにデプロイが要る。
 */
export interface ProductionReadinessThresholds {
  /** 接続確認がこれより古ければ、確かめ直す。 */
  readonly connectionCheckValidForDays: number;
  /** 二要素で入った記録がこれより古ければ、入り直してもらう。 */
  readonly mfaValidForDays: number;
  /** 時計がこれを超えて成功していなければ、止まっているとみなす。 */
  readonly jobStaleAfterMinutes: number;
}

export const DEFAULT_PRODUCTION_READINESS_THRESHOLDS: ProductionReadinessThresholds = {
  /*
    ⚠️ **無期限にしない。** 相手側の証明書も鍵も入れ替わる。一度通った
       ことを永久の証拠にすると、切れていることに売れなくなってから気づく。
  */
  connectionCheckValidForDays: 30,
  mfaValidForDays: 90,
  // ⚠️ P0-6 の運営ダッシュボードと同じ値にする。片方だけ動かすと食い違う。
  jobStaleAfterMinutes: 150,
};

/**
 * 時計が動いていることを要求する処理。
 *
 * ⚠️ **お金を受け取ったあとに必要なものだけ。** 知らせや取消の補完は
 * 止まっていても売った品は渡せる。ここを増やしすぎると、本質的でない
 * 停止で販売が止まる。
 */
export const PRODUCTION_REQUIRED_JOB_KEYS = ['issue-entitlements', 'deliver-entitlements'] as const;

/** 受付中の決済世代。⚠️ **秘密は含めない。** 有無と確認の結果だけ。 */
export interface AcceptingCredentialFact {
  readonly id: string;
  readonly generation: number;
  /** 直近の接続確認が成功したか。⚠️ `null` は「一度も確かめていない」。 */
  readonly lastCheckSucceeded: boolean | null;
  readonly lastCheckAt: Date | null;
  /**
   * 決済事業者からの知らせを最後に受け取った時刻。
   *
   * ⚠️ **署名鍵が「入っている」ことでは足りない。** 入れ間違えても、
   * 受け取るまでは誰も気づかない。**実際に届いたこと**を条件にする。
   */
  readonly lastWebhookReceivedAt: Date | null;
}

/** 接続確認の結果。 */
export interface ConnectionCheckFact {
  readonly succeeded: boolean;
  readonly executedAt: Date;
}

/**
 * 人が残した証跡。
 *
 * ⚠️ **決済世代に紐づく。** 鍵を替えたら通し試験も承認も取り直す。
 * 紐づけないと、前の運営会社の鍵で通した試験が、新しい鍵の証拠として
 * 残り続ける。
 */
export interface AttestationFact {
  readonly succeeded: boolean;
  readonly credentialId: string;
  readonly attestedAt: Date;
}

/** オーナーの二要素の記録。⚠️ 「入ったことがある」であって、いまの設定ではない。 */
export interface OwnerMfaFact {
  readonly accountId: string;
  readonly lastAal2At: Date | null;
}

export interface ProductionReadinessFacts {
  readonly acceptingCredential: AcceptingCredentialFact | null;
  readonly platformFeeRateBps: number;
  /** 施行中の法務文書の種別。 */
  readonly publishedLegalKinds: readonly LegalDocumentKind[];
  readonly walletCheck: ConnectionCheckFact | null;
  readonly mailCheck: ConnectionCheckFact | null;
  /** ⚠️ P0-6 の心拍をそのまま使う。二重に数えない。 */
  readonly jobs: readonly JobHeartbeat[];
  /** ⚠️ **0 人は未達。** オーナーが居ないなら、責任を引き受ける人が居ない。 */
  readonly owners: readonly OwnerMfaFact[];
  readonly latestE2eSaleTest: AttestationFact | null;
  readonly latestOwnerApproval: AttestationFact | null;
}

export interface ProductionReadinessCheck {
  readonly key: ProductionReadinessCheckKey;
  readonly label: string;
  readonly satisfied: boolean;
  /** いまの状態。⚠️ 秘密を書かない。 */
  readonly detail: string;
  /** 満たしていないときに何をすればよいか。⚠️ 満たしていても書いておく。 */
  readonly remedy: string;
}

export interface ProductionReadiness {
  /** ⚠️ **10 個すべて満たしたときだけ真。** */
  readonly ready: boolean;
  readonly checks: readonly ProductionReadinessCheck[];
  readonly unsatisfiedKeys: readonly ProductionReadinessCheckKey[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 10 条件を確かめる。
 *
 * ⚠️ **どれか 1 つでも欠けたら本番販売はできない。** 「9 つ満たしている
 * から惜しい」という状態は無い。欠けているものが 1 つあれば、そこで
 * お金か信用のどちらかが失われうる。
 */
export function evaluateProductionReadiness(input: {
  readonly facts: ProductionReadinessFacts;
  readonly thresholds: ProductionReadinessThresholds;
  readonly now: Date;
}): ProductionReadiness {
  const { facts, thresholds, now } = input;
  const credential = facts.acceptingCredential;

  const checks: readonly ProductionReadinessCheck[] = [
    paymentCredentialCheck(credential, thresholds, now),
    webhookCheck(credential),
    feeRateCheck(facts.platformFeeRateBps),
    legalCheck(facts.publishedLegalKinds),
    connectionCheck(
      'wallet_connection_verified',
      'OVEW Wallet への接続確認',
      facts.walletCheck,
      thresholds,
      now,
      '外部サービスの画面から、OVEW Wallet の接続確認を実行してください。',
    ),
    connectionCheck(
      'mail_connection_verified',
      'メール送信の接続確認',
      facts.mailCheck,
      thresholds,
      now,
      '外部サービスの画面から、メールの試し送りを実行してください。',
    ),
    jobsCheck(facts.jobs, thresholds, now),
    mfaCheck(facts.owners, thresholds, now),
    attestationCheck(
      'e2e_sale_test_passed',
      '直近の通し試験（E2E 販売試験）',
      facts.latestE2eSaleTest,
      credential,
      '本番の鍵で 1 件購入し、お届けまで通ることを確かめて、結果を記録してください。',
    ),
    attestationCheck(
      'owner_approval_recorded',
      '運営責任者の承認',
      facts.latestOwnerApproval,
      credential,
      '運営責任者が、本番販売の開始を承認して記録してください。',
    ),
  ];

  const unsatisfied = checks.filter((row) => !row.satisfied).map((row) => row.key);
  return { ready: unsatisfied.length === 0, checks, unsatisfiedKeys: unsatisfied };
}

function paymentCredentialCheck(
  credential: AcceptingCredentialFact | null,
  thresholds: ProductionReadinessThresholds,
  now: Date,
): ProductionReadinessCheck {
  const label = '決済の鍵（受付中の世代）';
  const remedy = '決済の鍵の画面で本番の世代を取り込み、接続確認を通してから有効化してください。';

  if (credential === null) {
    return {
      key: 'payment_credential_active',
      label,
      satisfied: false,
      // ⚠️ 0 件と 2 件を区別しない。どちらも「どれを使うか決まっていない」。
      detail: '受付中の世代がありません。',
      remedy,
    };
  }
  if (credential.lastCheckSucceeded !== true || credential.lastCheckAt === null) {
    return {
      key: 'payment_credential_active',
      label,
      satisfied: false,
      detail: `第 ${String(credential.generation)} 世代の接続確認が済んでいません。`,
      remedy,
    };
  }
  if (isStale(credential.lastCheckAt, thresholds.connectionCheckValidForDays, now)) {
    return {
      key: 'payment_credential_active',
      label,
      satisfied: false,
      detail: `第 ${String(credential.generation)} 世代の接続確認が古くなっています。`,
      remedy: '決済の鍵の画面から、接続確認をやり直してください。',
    };
  }
  return {
    key: 'payment_credential_active',
    label,
    satisfied: true,
    detail: `第 ${String(credential.generation)} 世代が受付中です。`,
    remedy,
  };
}

/**
 * Webhook の署名。
 *
 * ⚠️ **「鍵が入っている」では足りない。** 入れ間違えても、受け取るまで
 * 誰も気づかない。届いたことがあるかどうかで見る。**署名の検証を通って
 * 記録された知らせだけが、ここへ現れる。**
 */
function webhookCheck(credential: AcceptingCredentialFact | null): ProductionReadinessCheck {
  const label = '決済の知らせ（Webhook）の受信';
  const remedy =
    '決済事業者の管理画面で送信先を設定し、試験用の知らせを 1 通送って届くことを確かめてください。';

  if (credential === null) {
    return {
      key: 'webhook_signature_configured',
      label,
      satisfied: false,
      detail: '受付中の世代がないため、確かめられません。',
      remedy,
    };
  }
  if (credential.lastWebhookReceivedAt === null) {
    return {
      key: 'webhook_signature_configured',
      label,
      satisfied: false,
      detail: 'この世代では、まだ一度も知らせを受け取っていません。',
      remedy,
    };
  }
  return {
    key: 'webhook_signature_configured',
    label,
    satisfied: true,
    detail: '署名の検証を通った知らせを受け取っています。',
    remedy,
  };
}

/**
 * 手数料率。
 *
 * ⚠️ **0 は「無料」ではなく「まだ決めていない」。** ここで気を利かせて
 * 既定値を入れると、決めていないまま売れてしまう。
 */
function feeRateCheck(bps: number): ProductionReadinessCheck {
  const satisfied = bps > 0;
  return {
    key: 'platform_fee_rate_approved',
    label: '手数料率の承認',
    satisfied,
    detail: satisfied
      ? `${(bps / 100).toFixed(2)} %（税込価格に対する率）が設定されています。`
      : '手数料率が未設定です（0 は「無料」ではなく「まだ決めていない」）。',
    remedy: 'オーナーが、返金と精算の設定画面で手数料率を承認してください。',
  };
}

/**
 * 法務文書。
 *
 * ⚠️ **3 つそろって初めて売れる。** 特商法表記を掲げられない通信販売は、
 * 販売そのものが法に触れる（支払い口の作成でも同じ判定をしている）。
 */
function legalCheck(published: readonly LegalDocumentKind[]): ProductionReadinessCheck {
  /*
    ⚠️ **販売規約（`creator_terms`）はここに入れない。** あれは作家さまと
       こちらの取り決めで、買う人へ掲げる義務のあるものではない。作家さまが
       売り始める前に要るのは確かだが、それは**別の関門**（プロフィールの
       「売る準備」）で見る。ここへ混ぜると、作家さまがまだ 1 人も居ない
       立ち上げ期に本番販売が開けなくなる。
  */
  const required: readonly LegalDocumentKind[] = ['terms', 'privacy', 'tokushoho'];
  const missing = required.filter((kind) => !published.includes(kind));
  const names: Readonly<Record<LegalDocumentKind, string>> = {
    terms: '利用規約',
    privacy: 'プライバシーポリシー',
    tokushoho: '特定商取引法に基づく表記',
    creator_terms: '販売規約（作家さま向け）',
  };
  return {
    key: 'legal_documents_published',
    label: '規約・プライバシー・特商法の掲示',
    satisfied: missing.length === 0,
    detail:
      missing.length === 0
        ? '3 つとも施行中です。'
        : `${missing.map((kind) => names[kind]).join('・')}が施行されていません。`,
    remedy: '規約・法務の画面で、それぞれの版を公開して施行日を迎えてください。',
  };
}

function connectionCheck(
  key: ProductionReadinessCheckKey,
  label: string,
  fact: ConnectionCheckFact | null,
  thresholds: ProductionReadinessThresholds,
  now: Date,
  remedy: string,
): ProductionReadinessCheck {
  if (fact === null) {
    return {
      key,
      label,
      satisfied: false,
      detail: 'まだ一度も確かめていません。',
      remedy,
    };
  }
  if (!fact.succeeded) {
    return { key, label, satisfied: false, detail: '直近の確認が失敗しています。', remedy };
  }
  if (isStale(fact.executedAt, thresholds.connectionCheckValidForDays, now)) {
    return {
      key,
      label,
      satisfied: false,
      // ⚠️ 相手側の証明書も鍵も入れ替わる。一度通ったことを永久の証拠にしない。
      detail: `直近の確認が ${String(thresholds.connectionCheckValidForDays)} 日より古くなっています。`,
      remedy,
    };
  }
  return { key, label, satisfied: true, detail: '直近の確認が成功しています。', remedy };
}

/**
 * 時計仕掛け。
 *
 * ⚠️ **止まったまま売り始めない。** 発行が止まっていれば、お金を受け取った
 * のにお渡しするものが作られない。売る前に動いていることを確かめる。
 */
function jobsCheck(
  jobs: readonly JobHeartbeat[],
  thresholds: ProductionReadinessThresholds,
  now: Date,
): ProductionReadinessCheck {
  const label = '発行・お届けの時計';
  const remedy = '時計（cron）の設定を確かめ、1 巡させてから確かめ直してください。';
  const byKey = new Map(jobs.map((job) => [job.jobKey, job]));

  const stopped = PRODUCTION_REQUIRED_JOB_KEYS.filter((jobKey) => {
    const job = byKey.get(jobKey);
    // ⚠️ **記録が無いものは止まっている扱い。** 「まだ動いていない」も未達。
    if (job === undefined || job.lastSucceededAt === null) {
      return true;
    }
    return now.getTime() - job.lastSucceededAt.getTime() > thresholds.jobStaleAfterMinutes * 60_000;
  });

  const names: Readonly<Record<string, string>> = {
    'issue-entitlements': '受取権の発行',
    'deliver-entitlements': 'ウォレットへのお届け',
  };
  return {
    key: 'jobs_running',
    label,
    satisfied: stopped.length === 0,
    detail:
      stopped.length === 0
        ? '発行・お届けとも、直近に成功しています。'
        : `${stopped.map((jobKey) => names[jobKey] ?? jobKey).join('・')}が動いていません。`,
    remedy,
  };
}

/**
 * 管理者の二要素。
 *
 * ⚠️ **「入ったことがある」であって、いまの設定ではない。** 相手側の設定を
 * 毎回問い合わせるのではなく、二要素で入った記録を根拠にしている。
 * 外したことは、こちらからは分からない——だから**期限を切る**。
 *
 * ⚠️ **オーナーが 0 人なら未達。** 責任を引き受ける人が居ない状態で
 * 本番販売を始めない。
 */
function mfaCheck(
  owners: readonly OwnerMfaFact[],
  thresholds: ProductionReadinessThresholds,
  now: Date,
): ProductionReadinessCheck {
  const label = '運営責任者の二要素認証';
  const remedy =
    'オーナーが認証基盤で二要素を登録し、二要素で入り直してください（登録しただけでは記録されません）。';

  if (owners.length === 0) {
    return {
      key: 'admin_mfa_satisfied',
      label,
      satisfied: false,
      detail: 'オーナーが登録されていません。',
      remedy: 'オーナーを 1 人以上登録してください。',
    };
  }
  const unverified = owners.filter(
    (owner) =>
      owner.lastAal2At === null || isStale(owner.lastAal2At, thresholds.mfaValidForDays, now),
  );
  return {
    key: 'admin_mfa_satisfied',
    label,
    satisfied: unverified.length === 0,
    detail:
      unverified.length === 0
        ? `オーナー ${String(owners.length)} 名とも、二要素で入った記録があります。`
        : `オーナー ${String(owners.length)} 名のうち ${String(unverified.length)} 名に、直近の記録がありません。`,
    remedy,
  };
}

/**
 * 人が残した証跡。
 *
 * ⚠️ **「最新のものが成功している」を見る。** 過去のどこかに成功が
 * あることではない。失敗したあとに直したなら、直したあとの記録を残す。
 *
 * ⚠️ **決済世代が替わったら失効する。** 前の鍵で通した試験は、
 * 新しい鍵の証拠にならない。承認も同じで、鍵が替わるのは運営会社や
 * 入金先が変わるということである。
 */
function attestationCheck(
  key: ProductionReadinessCheckKey,
  label: string,
  fact: AttestationFact | null,
  credential: AcceptingCredentialFact | null,
  remedy: string,
): ProductionReadinessCheck {
  if (credential === null) {
    return {
      key,
      label,
      satisfied: false,
      detail: '受付中の決済世代がないため、記録を紐づけられません。',
      remedy: '先に本番の決済の鍵を有効化してください。',
    };
  }
  if (fact === null) {
    return { key, label, satisfied: false, detail: '記録がありません。', remedy };
  }
  if (fact.credentialId !== credential.id) {
    return {
      key,
      label,
      satisfied: false,
      detail: '決済の鍵が替わったため、記録が失効しています。',
      remedy,
    };
  }
  if (!fact.succeeded) {
    return { key, label, satisfied: false, detail: '直近の記録が「不成立」です。', remedy };
  }
  return { key, label, satisfied: true, detail: '直近の記録が有効です。', remedy };
}

function isStale(at: Date, validForDays: number, now: Date): boolean {
  return now.getTime() - at.getTime() > validForDays * DAY_MS;
}
