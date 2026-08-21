import { Injectable } from '@nestjs/common';
import type {
  PayoutAccountResponse,
  PayoutAccountView,
  CreatorEarningsDetailResponse,
  CreatorEarningsResponse,
  CreatorProfileDetailView,
} from '@sengoku/contracts';
import {
  isErr,
  validatePayoutAccount,
  buildEarningsCsv,
  creatorSetupChecklist,
  estimateFromDraft,
  payoutDueAt,
  payoutPeriodContaining,
  parsePayoutPeriod,
  summarizeByArtwork,
  toEarningsCsvRows,
  validateCreatorProfile,
  type ArtworkSales,
  type AuditLogPort,
  type ClockPort,
  type CreatorEarningsPort,
  type CreatorLink,
  type CreatorPeriodEarnings,
  type CreatorProfilePort,
  type CreatorProfileRepository,
  type IntegrationEnvironment,
  type LegalConsentRepository,
  type PayoutLineDraft,
  type PayoutRepository,
  type PayoutView,
  type SettlementSettingsRepository,
  type StoragePort,
  type PayoutAccountCipherPort,
  type PayoutAccountPort,
  type PayoutAccountRecord,
  type PayoutAccountType,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';
import type { NotificationService } from '../notification/notification.service';
import type { PayoutService } from '../settlement/payout.service';

/**
 * 作家さまが見る売上とプロフィール（実運営 指示書 P1-2）。
 *
 * ⚠️ **見込みは `PayoutService.estimateFor` を通す。** 締めるときと同じ
 * 関数である。別の式で出すと、締めたときに額が変わり、そのたびに
 * 「話が違う」という問い合わせになる。
 *
 * ⚠️ **誰の分かをトークンから取る。** このクラスは `creatorAccountId` を
 * 引数で受けるが、呼び出す controller は必ずトークンの値を渡す。
 * 要求から受け取れる形にすると、そこが他人の売上を覗く道になる。
 */
@Injectable()
export class CreatorOperationsService {
  constructor(
    private readonly payoutService: PayoutService,
    private readonly payouts: PayoutRepository,
    private readonly earnings: CreatorEarningsPort,
    private readonly profiles: CreatorProfilePort,
    private readonly displayNames: CreatorProfileRepository,
    /**
     * 販売規約への同意を引く口。
     *
     * ⚠️ **`null` は「この配備では確かめられない」。** そのときは
     * 「未同意」として出す——**同意したことにしない**。分からないことを
     * 「済み」に倒すと、同意を取らないまま売り始められる。
     */
    private readonly consents: LegalConsentRepository | null,
    private readonly settings: SettlementSettingsRepository,
    private readonly storage: StoragePort,
    private readonly appEnvironment: IntegrationEnvironment,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    /**
     * お振込先（P1-3）。
     *
     * ⚠️ **`null` は「この配備では預かれない」。** 暗号鍵を設定していない
     * 配備がある。必須にすると、そこで起動しなくなる。画面は
     * 「まだご登録いただけません」と断る。
     */
    private readonly payoutAccounts: {
      readonly store: PayoutAccountPort;
      readonly cipher: PayoutAccountCipherPort;
    } | null,
    /** お振込先が変わったことを知らせる口。⚠️ `null` なら積まない。 */
    private readonly notifications: NotificationService | null,
    private readonly siteUrl: string,
  ) {}

  /** 売上のまとめ。⚠️ 進行中の期間は見込み、過ぎた期間は締めた記録。 */
  async earningsOf(creatorAccountId: string): Promise<CreatorEarningsResponse> {
    const now = this.clock.now();
    const period = payoutPeriodContaining(now);
    const offsetMonths = (await this.settings.find(this.appEnvironment))?.payoutOffsetMonths ?? 0;

    const [draft, history] = await Promise.all([
      this.payoutService.estimateFor(creatorAccountId, period),
      this.payouts.list({ creatorAccountId, limit: HISTORY_LIMIT }),
    ]);

    const current = estimateFromDraft({
      draft,
      dueAt: payoutDueAt(period, offsetMonths),
    });

    return {
      current: toEarningsView(current),
      history: history.map(toHistoryView),
      byArtwork: summarizeByArtwork(draft.lines).map(toArtworkView),
      nextPayout: nextPayoutOf(current, history),
    };
  }

  /** ある期間の明細。⚠️ 締めた期間も、進行中の期間も同じ形で返す。 */
  async detailOf(
    creatorAccountId: string,
    periodKey: string | undefined,
  ): Promise<CreatorEarningsDetailResponse> {
    const { period: view, lines } = await this.resolvePeriod(creatorAccountId, periodKey);
    return {
      period: toEarningsView(view),
      lines: lines.map((line) => ({
        orderNumber: line.orderNumber,
        artworkTitleSnapshot: line.artworkTitleSnapshot,
        grossAmount: line.grossAmount,
        feeRateBps: line.feeRateBps,
        feeAmount: line.feeAmount,
        netAmount: line.netAmount,
        isClawback: line.isClawback,
      })),
      byArtwork: summarizeByArtwork(lines).map(toArtworkView),
    };
  }

  /**
   * 明細を CSV で書き出す。
   *
   * ⚠️ **買った方の情報を 1 つも入れない**（列そのものが無い）。明細は
   * 作家さまの手元へ落ちて、表計算やメールに渡っていく。落ちた先まで
   * こちらの管理は及ばない。
   */
  async csvOf(creatorAccountId: string, periodKey: string | undefined): Promise<string> {
    const { period: view, lines } = await this.resolvePeriod(creatorAccountId, periodKey);
    return buildEarningsCsv(toEarningsCsvRows({ periodKey: view.periodKey, lines }));
  }

  async profileOf(creatorAccountId: string): Promise<CreatorProfileDetailView> {
    const [profile, account, consent, payoutAccount] = await Promise.all([
      this.profiles.find(creatorAccountId),
      this.displayNames.find(creatorAccountId),
      this.consents === null
        ? Promise.resolve(null)
        : this.consents.findLatestConsent(creatorAccountId, 'creator_terms'),
      // ⚠️ 預かれない配備では `undefined`。そのときは未登録として出る。
      this.payoutAccounts?.store.find(creatorAccountId) ?? Promise.resolve(null),
    ]);

    return {
      displayName: account?.displayName ?? null,
      shopName: profile?.shopName ?? null,
      bio: profile?.bio ?? null,
      links: profile === null ? [] : profile.links.map((link) => ({ ...link })),
      // ⚠️ 鍵ではなく URL を返す。画面がそのまま出せるように。
      iconUrl:
        profile?.iconKey === undefined || profile.iconKey === null
          ? null
          : this.storage.publicUrl(profile.iconKey),
      coverUrl:
        profile?.coverKey === undefined || profile.coverKey === null
          ? null
          : this.storage.publicUrl(profile.coverKey),
      invoiceNumber: profile?.invoiceNumber ?? null,
      salesTermsAcceptedAt: consent?.consentedAt.toISOString() ?? null,
      setup: creatorSetupChecklist({
        hasDisplayName: (account?.displayName ?? null) !== null,
        salesTermsAcceptedAt: consent?.consentedAt ?? null,
        // お振込先（P1-3）。⚠️ 預かれない配備では、常に未登録として出る。
        hasPayoutAccount: payoutAccount !== null,
        hasInvoiceNumber: (profile?.invoiceNumber ?? null) !== null,
      }).map((row) => ({ ...row })),
    };
  }

  /* --- お振込先（P1-3・`UD-124` 決定 2026-08-21）--- */

  /**
   * ご自分のお振込先を見る。
   *
   * ⚠️ **口座番号そのものは返さない。** 返すのは伏せた表記まで。画面を
   * 開くたびに番号が経路へ流れる形にしない。振込のために全体が要るのは
   * 運営だけで、そこは別の口（権限＋監査つき）にしてある。
   */
  async payoutAccountOf(creatorAccountId: string): Promise<PayoutAccountResponse> {
    const record = await this.payoutAccounts?.store.find(creatorAccountId);
    return { account: record == null ? null : toPayoutAccountView(record) };
  }

  /**
   * お振込先を登録する・差し替える。
   *
   * ⚠️ **お金の行き先が変わる操作である。** 乗っ取られた側から見れば、
   * いちばん実入りのある操作。**必ず記録し、ご本人へ知らせる**——
   * 気づけるのは本人だけ。
   *
   * ⚠️ **記録に口座の値を残さない。** 監査ログに番号が残れば、包んだ意味が
   * 無くなる。残すのは「変えた」という事実まで。
   */
  async savePayoutAccount(
    creatorAccountId: string,
    input: {
      readonly bankName: string;
      readonly branchName: string;
      readonly accountType: PayoutAccountType;
      readonly accountNumber: string;
      readonly accountHolderKana: string;
    },
  ): Promise<PayoutAccountResponse> {
    const payoutAccounts = this.payoutAccounts;
    if (payoutAccounts === null) {
      // ⚠️ 預かれない配備。**「登録できた」と見せない。**
      throw new DomainErrorException('PAYOUT_ACCOUNT_UNAVAILABLE');
    }

    const validated = validatePayoutAccount(input);
    if (isErr(validated)) {
      throw new DomainErrorException(validated.error.code);
    }

    const now = this.clock.now();
    const { replaced } = await payoutAccounts.store.save({
      creatorAccountId,
      bankName: validated.value.bankName,
      branchName: validated.value.branchName,
      accountType: validated.value.accountType,
      /*
        ⚠️ **結び付ける相手はアカウントID。** 別の作家さまの行へ暗号文を
           貼り替えても復号できないようにする（支払先の差し替えを塞ぐ）。
      */
      sealedAccountNumber: payoutAccounts.cipher.seal(
        validated.value.accountNumber,
        creatorAccountId,
      ),
      maskedAccountNumber: validated.value.maskedAccountNumber,
      accountHolderKana: validated.value.accountHolderKana,
      updatedAt: now,
    });

    await this.audit.record({
      actorAccountId: creatorAccountId,
      action: 'payout_account.saved',
      targetType: 'account',
      targetId: creatorAccountId,
      // ⚠️ 口座の値をここへ入れない。包んだ意味が無くなる。
      summary: { replaced },
    });

    /*
      ⚠️ **差し替えのときだけ知らせる。** 初めての登録に「変更されました」と
         届くと、身に覚えのない知らせになる。
      ⚠️ **変えた本人にも届ける。** 「押した本人だから要らない」ではない——
         押したのが本人でないときに気づけるのが、この知らせの目的である。
    */
    if (replaced && this.notifications !== null) {
      await this.notifications.enqueue({
        eventType: 'payout_account.changed',
        /*
          ⚠️ **対象IDに時刻を含める。** アカウントだけを対象にすると、
             2 回目以降の変更が重複として捨てられ、**乗っ取りの 2 回目が
             知らされない**。
        */
        subjectId: `${creatorAccountId}:${String(now.getTime())}`,
        accountId: creatorAccountId,
        values: {
          changedAt: formatJst(now),
          contactUrl: `${this.siteUrl.replace(/\/+$/, '')}/contact`,
        },
      });
    }

    return this.payoutAccountOf(creatorAccountId);
  }

  /** プロフィールを保存する。⚠️ 表示名と画像には触れない。 */
  async saveProfile(
    creatorAccountId: string,
    input: {
      readonly shopName: string | null;
      readonly bio: string | null;
      readonly links: readonly CreatorLink[];
      readonly invoiceNumber: string | null;
    },
  ): Promise<CreatorProfileDetailView> {
    const decision = validateCreatorProfile(input);
    if (!decision.ok) {
      throw new DomainErrorException('CREATOR_PROFILE_INVALID');
    }

    await this.profiles.save({
      accountId: creatorAccountId,
      shopName: decision.value.shopName,
      bio: decision.value.bio,
      links: decision.value.links,
      invoiceNumber: decision.value.invoiceNumber,
      now: this.clock.now(),
    });

    /*
      ⚠️ **本文を監査ログへ写さない。** 紹介文は作家さまの文章で、
         2 か所に増やすと消せない場所が 2 つになる。
    */
    await this.audit.record({
      actorAccountId: creatorAccountId,
      action: 'creator.profile_saved',
      targetType: 'account',
      targetId: creatorAccountId,
      summary: { linkCount: decision.value.links.length },
    });

    return this.profileOf(creatorAccountId);
  }

  /**
   * 期間を解決して明細を取る。
   *
   * ⚠️ **締めた期間は保存された明細、進行中は見込み。** どちらを見せるかを
   * 呼び出し側に判断させない。判断が散ると、片方だけ直す事故が起きる。
   */
  private async resolvePeriod(
    creatorAccountId: string,
    periodKey: string | undefined,
  ): Promise<{
    readonly period: CreatorPeriodEarnings;
    readonly lines: readonly PayoutLineDraft[];
  }> {
    const now = this.clock.now();
    const offsetMonths = (await this.settings.find(this.appEnvironment))?.payoutOffsetMonths ?? 0;

    if (periodKey === undefined) {
      const period = payoutPeriodContaining(now);
      const draft = await this.payoutService.estimateFor(creatorAccountId, period);
      return {
        period: estimateFromDraft({ draft, dueAt: payoutDueAt(period, offsetMonths) }),
        lines: draft.lines,
      };
    }

    const parsed = parsePayoutPeriod(periodKey);
    if (!parsed.ok) {
      throw new DomainErrorException(parsed.error.code);
    }

    const saved = await this.payouts.findByPeriod(creatorAccountId, periodKey);
    if (saved !== null) {
      return {
        period: toHistoryDomain(saved),
        lines: await this.earnings.linesOf(saved.id),
      };
    }

    /*
      ⚠️ **締めていない過去の期間も見せる。** 「まだ締めていません」とだけ
         出すと、作家さまは何が起きているのか分からない。見込みとして出す。
    */
    const draft = await this.payoutService.estimateFor(creatorAccountId, parsed.value);
    return {
      period: estimateFromDraft({ draft, dueAt: payoutDueAt(parsed.value, offsetMonths) }),
      lines: draft.lines,
    };
  }
}

/** 履歴に出す件数。⚠️ 無制限にしない。 */
const HISTORY_LIMIT = 24;

function toEarningsView(view: CreatorPeriodEarnings) {
  return {
    periodKey: view.periodKey,
    state: view.state,
    grossAmount: view.grossAmount,
    feeAmount: view.feeAmount,
    refundedAmount: view.refundedAmount,
    carriedInAmount: view.carriedInAmount,
    netAmount: view.netAmount,
    carriedOutAmount: view.carriedOutAmount,
    minimumPayoutAmount: view.minimumPayoutAmount,
    dueAt: view.dueAt.toISOString(),
    openRefundWindows: view.openRefundWindows,
  };
}

/** 締めた精算を、見込みと同じ形へ写す。⚠️ 計算はしない。 */
function toHistoryDomain(payout: PayoutView): CreatorPeriodEarnings {
  /*
    ⚠️ **保存された締め月の文字列から組み直す。** 保存の時点で確定した
       期間なので、いまの時計から作り直さない。
  */
  const parsed = parsePayoutPeriod(payout.periodKey);
  return {
    periodKey: payout.periodKey,
    period: parsed.ok ? parsed.value : payoutPeriodContaining(payout.periodStart),
    state: payout.status,
    grossAmount: payout.grossAmount,
    feeAmount: payout.feeAmount,
    refundedAmount: payout.refundedAmount,
    carriedInAmount: payout.carriedInAmount,
    netAmount: payout.netAmount,
    carriedOutAmount: payout.carriedOutAmount,
    minimumPayoutAmount: payout.minimumPayoutAmount,
    dueAt: payout.dueAt,
    // ⚠️ 締めた時点で 0 だったことは記録として残っている。数え直さない。
    openRefundWindows: 0,
  };
}

function toHistoryView(payout: PayoutView) {
  return toEarningsView(toHistoryDomain(payout));
}

function toArtworkView(row: ArtworkSales) {
  return { ...row };
}

/**
 * 次にお振込みするもの。
 *
 * ⚠️ **0 円の振込予定を出さない。** 最低支払額に満たないときや売上が
 * 無いときは `null`。0 円と書かれた予定は、期待させておいて何も起きない。
 *
 * ⚠️ **締めた精算を先に見る。** 確定した額があるなら、それが次の振込。
 * 見込みは、確定したものが無いときの見通しにすぎない。
 */
function nextPayoutOf(
  current: CreatorPeriodEarnings,
  history: readonly PayoutView[],
): { readonly periodKey: string; readonly amount: number; readonly dueAt: string } | null {
  const pending = history
    .filter((row) => row.status !== 'paid' && row.netAmount > 0)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];

  if (pending !== undefined) {
    return {
      periodKey: pending.periodKey,
      amount: pending.netAmount,
      dueAt: pending.dueAt.toISOString(),
    };
  }
  if (current.netAmount <= 0) {
    return null;
  }
  return {
    periodKey: current.periodKey,
    amount: current.netAmount,
    dueAt: current.dueAt.toISOString(),
  };
}

/**
 * 画面へ出す形にする。
 *
 * ⚠️ **口座番号そのものを載せない。** 載せる欄が契約に無いので、
 * うっかり載せても型で落ちる。
 */
function toPayoutAccountView(record: PayoutAccountRecord): PayoutAccountView {
  return {
    bankName: record.bankName,
    branchName: record.branchName,
    accountType: record.accountType,
    maskedAccountNumber: record.maskedAccountNumber,
    accountHolderKana: record.accountHolderKana,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** 日時。⚠️ 日本時間で出す（読むのは日本の作家さま）。 */
function formatJst(value: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}
