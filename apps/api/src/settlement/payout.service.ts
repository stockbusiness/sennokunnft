import { Inject, Injectable } from '@nestjs/common';
import {
  buildPayoutDraft,
  canConfirmPayout,
  isPeriodClosed,
  parsePayoutPeriod,
  payoutDueAt,
  previousPayoutPeriod,
  transitionPayoutStatus,
  type AuditLogPort,
  type ClockPort,
  type IdGeneratorPort,
  type IntegrationEnvironment,
  type PayoutDraft,
  type PayoutLineView,
  type PayoutPeriod,
  type PayoutRepository,
  type PayoutAccountCipherPort,
  type PayoutAccountPort,
  type PayoutStatus,
  type PayoutView,
  type SettlementSettingsRepository,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 精算（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **金額を人が書き換える口を作らない**（`SETTLEMENT_AND_REFUND.md` §4）。
 * ここに「金額を直す」メソッドを足さないこと。訂正は**次の期間での調整**
 * として行う。直接書き換えを許すと、明細と振込額が食い違ったときに、
 * どちらが正しいのか誰にも分からなくなる。
 *
 * ⚠️ **設定は「締めるとき」に 1 度だけ読む。** 読んだ値は精算へ焼き付ける。
 * 判定のたびに読むと、最低支払額を変えた瞬間に過去の精算が動く
 * （`SETTLEMENT_AND_REFUND.md` §0 の三層）。
 */

/** 注入の合図。⚠️ interface は実行時に消えるので、型では注入できない。 */
export const PAYOUT_CONFIG = Symbol('sengoku:payout-config');

export interface PayoutConfig {
  readonly repository: PayoutRepository;
  readonly settings: SettlementSettingsRepository;
  /** このプロセスの環境。⚠️ 要求から受け取らない。 */
  readonly appEnvironment: IntegrationEnvironment;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly audit: AuditLogPort;
  /**
   * お振込先（P1-3・決定 2026-08-21）。
   *
   * ⚠️ **`null` は「この配備では預かる仕組みが無い」。** 暗号鍵を設定して
   * いない配備がある。必須にすると、そこで起動しなくなる。
   *
   * ⚠️ **作家さま向けの口と同じ組を使う。** 2 つ持つと、鍵を入れ替える
   * ときに片方だけ古いままになる。
   */
  readonly payoutAccounts: {
    readonly store: PayoutAccountPort;
    readonly cipher: PayoutAccountCipherPort;
  } | null;
}

/**
 * 振込のために読んだ結果（決定 2026-08-21）。
 *
 * ⚠️ **「取れなかった」を分けている。** 運営の次の一手が違うため——
 * 未登録なら作家さまへお願いし、鍵が無ければ運用担当へ伝え、
 * **包みが解けなければ振り込まない**。
 */
export type PayoutAccountReveal =
  | {
      readonly status: 'resolved';
      readonly account: {
        readonly bankName: string;
        readonly branchName: string;
        readonly accountType: 'ordinary' | 'checking';
        readonly accountNumber: string;
        readonly accountHolderKana: string;
        readonly updatedAt: Date;
      };
    }
  | { readonly status: 'missing' }
  | { readonly status: 'not_configured' }
  | { readonly status: 'undecipherable' }
  | { readonly status: 'not_payable_yet' };

/** 締めた結果。⚠️ 作家さまごとに 1 件ずつ返す。丸めない。 */
export interface ClosePeriodResult {
  readonly periodKey: string;
  readonly items: readonly PayoutView[];
}

@Injectable()
export class PayoutService {
  constructor(@Inject(PAYOUT_CONFIG) private readonly config: PayoutConfig) {}

  list(query: {
    readonly limit: number;
    readonly periodKey?: string | undefined;
    readonly creatorAccountId?: string | undefined;
    readonly status?: PayoutStatus | undefined;
  }): Promise<readonly PayoutView[]> {
    return this.config.repository.list(query);
  }

  async detail(payoutId: string): Promise<{
    readonly payout: PayoutView;
    readonly lines: readonly PayoutLineView[];
    readonly openRefundWindows: number;
    readonly payoutAccountStatus: 'registered' | 'missing' | 'unavailable';
  } | null> {
    const payout = await this.config.repository.findById(payoutId);
    if (payout === null) {
      return null;
    }
    const lines = await this.config.repository.listLines(payoutId);
    /*
      ⚠️ **状態だけを見る。包みは解かない。** 画面を開いただけで復号が
         走る形にすると、監査ログに残らないところで口座が読まれる
         （読むのは別の口＝`payout_account.view_full`）。
    */
    const payoutAccountStatus = await this.payoutAccountStatusOf(payout.creatorAccountId);

    /*
      ⚠️ **確定済みなら、いま数え直さない。** 確定の時点で 0 だったことは
         記録として残っている。数え直すと、あとから足された注文で
         「確定済みなのに窓が開いている」という読み方ができてしまう。
    */
    if (payout.status !== 'draft') {
      return { payout, lines, openRefundWindows: 0, payoutAccountStatus };
    }
    const openRefundWindows = await this.config.repository.countOpenRefundWindows(
      payout.id,
      this.config.clock.now(),
    );
    return { payout, lines, openRefundWindows, payoutAccountStatus };
  }

  private async payoutAccountStatusOf(
    creatorAccountId: string,
  ): Promise<'registered' | 'missing' | 'unavailable'> {
    const payoutAccounts = this.config.payoutAccounts;
    if (payoutAccounts === null) {
      return 'unavailable';
    }
    const found = await payoutAccounts.store.find(creatorAccountId);
    return found === null ? 'missing' : 'registered';
  }

  /**
   * 振込のために、お振込先を伏せずに読む（決定 2026-08-21）。
   *
   * ⚠️ **確定した精算のためだけに開く。** 下書きのうちに読む理由が無い。
   * 絞っておくと、監査ログの 1 行が**何のためだったか**を後から説明できる。
   *
   * ⚠️ **読めたかどうかに関わらず、必ず記録する。** 「開こうとした」こと
   * 自体が記録の対象である。
   *
   * ⚠️ **記録に口座の値を入れない。** 入れた瞬間、包んで保管した意味が
   * 監査ログの側から失われる。残すのは「誰が・いつ・どの精算のために」まで。
   */
  /**
   * 繰越がマイナスのまま残っている作家さま（決定 2026-08-22）。
   *
   * ⚠️ **取り立てる仕組みではない。** 見えるようにするだけである。請求書を
   * 作る口も、金額を書き換える口も無い。大きい額が出たときに、運営が個別に
   * 判断できればよい。
   */
  listNegativeCarries(limit = 50) {
    return this.config.repository.listNegativeCarries(limit);
  }

  async revealPayoutAccount(input: {
    readonly payoutId: string;
    readonly actorAccountId: string;
  }): Promise<PayoutAccountReveal | null> {
    const payout = await this.config.repository.findById(input.payoutId);
    if (payout === null) {
      return null;
    }

    const result = await this.readPayoutAccount(payout);
    await this.config.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'payout_account.viewed',
      targetType: 'payout',
      targetId: payout.id,
      // ⚠️ 口座の値をここへ入れない。残すのは結果の種類まで。
      summary: { result: result.status, creatorAccountId: payout.creatorAccountId },
    });
    return result;
  }

  private async readPayoutAccount(payout: PayoutView): Promise<PayoutAccountReveal> {
    /*
      ⚠️ **下書きでは開かない。** 「確定する前に確かめたい」は、状態
         （`payoutAccountStatus`）で足りる。番号は振り込むときに要る。
    */
    if (payout.status === 'draft') {
      return { status: 'not_payable_yet' };
    }

    const payoutAccounts = this.config.payoutAccounts;
    if (payoutAccounts === null) {
      return { status: 'not_configured' };
    }

    const record = await payoutAccounts.store.find(payout.creatorAccountId);
    if (record === null) {
      return { status: 'missing' };
    }

    /*
      ⚠️ **解けなかったら、伏せた表記で代用しない。** 「***4567 までは
         分かる」と出すと、そのまま振り込もうとする人が出る。解けないのは
         鍵の入れ替えを誤ったか、行が差し替えられたかで、**どちらでも
         振り込んではいけない**。
    */
    const accountNumber = payoutAccounts.cipher.open(
      record.sealedAccountNumber,
      payout.creatorAccountId,
    );
    if (accountNumber === null) {
      return { status: 'undecipherable' };
    }

    return {
      status: 'resolved',
      account: {
        bankName: record.bankName,
        branchName: record.branchName,
        accountType: record.accountType,
        accountNumber,
        accountHolderKana: record.accountHolderKana,
        updatedAt: record.updatedAt,
      },
    };
  }

  /**
   * 期間を締めて、作家さまごとの下書きを作る。
   *
   * ⚠️ **作家さまを指定させない。** その期間に売上か繰越のある方を、
   * こちらで洗い出す。指定できると、指定し忘れた方がいつまでも
   * 支払われない——そして誰も気づかない。
   *
   * ⚠️ **何度でも作り直せる。** ただし `draft` のときだけ。締めたあとの
   * 精算は動かさない。
   */
  async closePeriod(input: {
    readonly periodKey: string;
    readonly actorAccountId: string;
  }): Promise<ClosePeriodResult> {
    const now = this.config.clock.now();
    const period = this.periodOrThrow(input.periodKey);

    /*
      ⚠️ **締めを迎えていない期間は締めさせない。** `endAt` は「翌月の
         1 日 0 時（JST）」なので、その瞬間より前に集計すると、まだ売れる
         余地のある期間を締めることになる。
    */
    if (!isPeriodClosed(period, now)) {
      throw new DomainErrorException('PAYOUT_PERIOD_NOT_CLOSED');
    }

    const settings = await this.config.settings.find(this.config.appEnvironment);
    if (settings === null) {
      /*
        ⚠️ **既定値を作らない。** 最低支払額も振込手数料の負担も、
           決めていないまま精算へ焼き付けてはいけない。焼き付けた値は
           もう直せない。
      */
      throw new DomainErrorException('SETTLEMENT_SETTINGS_INVALID');
    }

    const previous = previousPayoutPeriod(period);
    const creators = await this.config.repository.listCreatorsForPeriod({
      periodStart: period.startAt,
      periodEnd: period.endAt,
      previousPeriodKey: previous.key,
    });

    const items: PayoutView[] = [];
    for (const creatorAccountId of creators) {
      /*
        ⚠️ **締めたあとの精算は飛ばす。** 例外にしない——1 人でも確定
           済みの方がいると、その期間を作り直せなくなる。飛ばした事実は
           監査ログの件数から読める。
      */
      const existing = await this.config.repository.findByPeriod(creatorAccountId, period.key);
      if (existing !== null && existing.status !== 'draft') {
        continue;
      }

      const draft = await this.buildFor(creatorAccountId, period, settings, now);
      const saved = await this.config.repository.saveDraft({
        payoutId: this.config.ids.generate(),
        creatorAccountId,
        periodKey: period.key,
        periodStart: period.startAt,
        periodEnd: period.endAt,
        // ⚠️ 期日も焼き付ける。設定を変えても過去の精算は動かない。
        dueAt: payoutDueAt(period, settings.payoutOffsetMonths),
        currency: 'JPY',
        grossAmount: draft.grossAmount,
        feeAmount: draft.feeAmount,
        refundedAmount: draft.refundedAmount,
        carriedInAmount: draft.carriedInAmount,
        netAmount: draft.netAmount,
        carriedOutAmount: draft.carriedOutAmount,
        deferredDisputeCount: draft.deferredDisputeCount,
        deferredDisputeAmount: draft.deferredDisputeAmount,
        minimumPayoutAmount: draft.minimumPayoutAmount,
        transferFeeBearer: draft.transferFeeBearer,
        lines: draft.lines.map((line) => ({ id: this.config.ids.generate(), ...line })),
        now,
      });
      items.push(saved);
    }

    await this.config.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'payout.period_closed',
      targetType: 'payout_period',
      targetId: period.key,
      // ⚠️ 金額は秘密ではないが、ここに要るのは件数まで。
      summary: { periodKey: period.key, creators: creators.length, drafts: items.length },
    });

    return { periodKey: period.key, items };
  }

  /**
   * 確定する。
   *
   * ⚠️ **返金の窓が開いている注文が 1 件でもあれば断る**
   * （`SETTLEMENT_AND_REFUND.md` §2-3）。閉じる前に確定すると、返金のたびに
   * 作家さまから返してもらう話になる。いちばん揉める作業で、少額なら
   * 回収を諦めることになり、諦めた分は運営の損になる。
   *
   * ⚠️ **決着していないチャージバックがあるときも断る**（2026-08-22）。
   * 同じ理由だが、こちらは**期限では閉じない**——カード会社が決着させる
   * まで開いたまま。別の符号で返し、画面も別の文言で伝える。
   */
  async confirm(input: {
    readonly payoutId: string;
    readonly actorAccountId: string;
  }): Promise<PayoutView> {
    const now = this.config.clock.now();
    const payout = await this.findOrThrow(input.payoutId);
    this.assertTransition(payout.status, 'confirmed');

    /*
      ⚠️ **この精算の明細そのものから数え直す。** 下書きを作った時点の
         件数ではない。作ってから確定するまでのあいだに窓は閉じるので、
         作った時点で止めると、いつまでも確定できない精算ができる。
    */
    const openRefundWindows = await this.config.repository.countOpenRefundWindows(payout.id, now);
    /*
      ⚠️ **争いも数える。** 争いの最中にお支払いすると、負けたときに
         作家さまから返してもらう話になる。返金の窓と同じ性質の歯止めだが、
         **期限では閉じない**——カード会社が決めるまで開いたまま。
    */
    const openDisputes = await this.config.repository.countOpenDisputes(payout.id);
    const allowed = canConfirmPayout({ openRefundWindows, openDisputes });
    if (!allowed.ok) {
      throw new DomainErrorException(allowed.error.code);
    }

    const advanced = await this.config.repository.advance({
      payoutId: payout.id,
      from: 'draft',
      to: 'confirmed',
      actorAccountId: input.actorAccountId,
      now,
    });
    if (advanced === null) {
      // 同時に押された。⚠️ 2 回通す形にしない。
      throw new DomainErrorException('PAYOUT_NOT_EDITABLE');
    }

    await this.config.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'payout.confirmed',
      targetType: 'payout',
      targetId: payout.id,
      summary: {
        periodKey: payout.periodKey,
        netAmount: advanced.netAmount,
        carriedOutAmount: advanced.carriedOutAmount,
      },
    });
    return advanced;
  }

  /**
   * 支払い済みにする。
   *
   * ⚠️ **これは「振り込んだ」という宣言であって、振込そのものではない。**
   * 実際に振り込んだかを機械は確かめられない。だからオーナー限定にし、
   * 誰がいつ宣言したかを必ず残す。
   */
  async markPaid(input: {
    readonly payoutId: string;
    readonly actorAccountId: string;
  }): Promise<PayoutView> {
    const now = this.config.clock.now();
    const payout = await this.findOrThrow(input.payoutId);
    this.assertTransition(payout.status, 'paid');

    const advanced = await this.config.repository.advance({
      payoutId: payout.id,
      from: 'confirmed',
      to: 'paid',
      actorAccountId: input.actorAccountId,
      now,
    });
    if (advanced === null) {
      throw new DomainErrorException('PAYOUT_NOT_EDITABLE');
    }

    await this.config.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'payout.paid',
      targetType: 'payout',
      targetId: payout.id,
      summary: { periodKey: payout.periodKey, netAmount: advanced.netAmount },
    });
    return advanced;
  }

  /**
   * まだ締めていない期間の見込み（P1-2）。
   *
   * ⚠️ **締めるときと同じ関数を通す。** 見込みを別の式で出すと、締めた
   * ときに額が変わり、そのたびに作家さまから「話が違う」と言われる。
   * **見込みと実額がずれないことが、あの画面の唯一の存在理由**である。
   *
   * ⚠️ **設定はいまの値。** 見込みなので焼き付けない。締めた時点の値で
   * 確定するのは、締める側の仕事。
   */
  async estimateFor(creatorAccountId: string, period: PayoutPeriod): Promise<PayoutDraft> {
    const settings = await this.config.settings.find(this.config.appEnvironment);
    return this.buildFor(
      creatorAccountId,
      period,
      {
        /*
          ⚠️ **設定が無ければ 0 と `creator`。** 既定値をここで作らない。
             「決めていない」ことが、そのまま見込みに現れるほうがよい。
        */
        minimumPayoutAmount: settings?.minimumPayoutAmount ?? 0,
        transferFeeBearer: settings?.transferFeeBearer ?? 'creator',
      },
      this.config.clock.now(),
    );
  }

  /**
   * 締めるときの集計。
   *
   * ⚠️ **保存された金額と比べ直す用途に使わない。** 比べて差があったら
   * 直す、という作りにすると、締めたあとに金額が動く道ができる。
   */
  private async buildFor(
    creatorAccountId: string,
    period: PayoutPeriod,
    settings: { minimumPayoutAmount: number; transferFeeBearer: 'creator' | 'platform' },
    now: Date,
  ): Promise<PayoutDraft> {
    const previous = previousPayoutPeriod(period);
    const [candidates, clawbacks, carriedInAmount] = await Promise.all([
      this.config.repository.listCandidates({
        creatorAccountId,
        periodStart: period.startAt,
        periodEnd: period.endAt,
      }),
      this.config.repository.listClawbacks(creatorAccountId),
      this.config.repository.carriedInAmount(creatorAccountId, previous.key),
    ]);

    return buildPayoutDraft({
      period,
      creatorAccountId,
      candidates,
      clawbacks,
      carriedInAmount,
      minimumPayoutAmount: settings.minimumPayoutAmount,
      transferFeeBearer: settings.transferFeeBearer,
      now,
    });
  }

  private periodOrThrow(periodKey: string): PayoutPeriod {
    const parsed = parsePayoutPeriod(periodKey);
    if (!parsed.ok) {
      throw new DomainErrorException(parsed.error.code);
    }
    return parsed.value;
  }

  private async findOrThrow(payoutId: string): Promise<PayoutView> {
    const payout = await this.config.repository.findById(payoutId);
    if (payout === null) {
      throw new DomainErrorException('PAYOUT_NOT_FOUND');
    }
    return payout;
  }

  /** ⚠️ 状態機械はドメインが持つ。ここでは呼ぶだけ。 */
  private assertTransition(from: PayoutStatus, to: PayoutStatus): void {
    const moved = transitionPayoutStatus(from, to);
    if (!moved.ok) {
      throw new DomainErrorException(moved.error.code);
    }
  }
}
