import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUANCE_BATCH_SIZE,
  type AuditLogPort,
  type ClockPort,
  type EntitlementIssuanceRepository,
  type IssuanceOutcome,
  type SupplyReconciliation,
} from '@sengoku/domain';

/** 注入の合図。⚠️ interface は実行時に消えるので、型では注入できない。 */
export const ISSUANCE_CONFIG = Symbol('sengoku:issuance-config');

export interface IssuanceConfig {
  readonly repository: EntitlementIssuanceRepository;
  readonly audit: AuditLogPort;
  readonly clock: ClockPort;
}

/**
 * 受取権の発行（P0-1）。
 *
 * **決済が済んだ注文を受取権に変える。** ここが開くまで、Claim も
 * Wallet 配送も返金時の失効も、作ってあるのに一度も動かない。
 *
 * ⚠️ **起動の口を 2 つ持つ。**
 *   1. 決済確定の直後（`runForOrder`）——待たせないための道。
 *   2. 時計からの掃き出し（`sweep`）——取りこぼしを拾う道。
 *
 * どちらも同じ処理を呼ぶ。**1 だけにすると、Webhook を処理した直後に
 * プロセスが落ちた注文が永久に発行されない。2 だけにすると、購入直後の
 * 画面に「準備中」が出続ける。**
 *
 * ⚠️ **発行の失敗で決済の確定を巻き戻さない。** お金は既に動いている。
 * 巻き戻すと「払ったのに注文が無い」になる。発行は別の失敗として記録し、
 * あとから何度でも再開できる形にする。
 */
@Injectable()
export class EntitlementIssuanceService {
  private readonly logger = new Logger(EntitlementIssuanceService.name);

  constructor(@Inject(ISSUANCE_CONFIG) private readonly config: IssuanceConfig) {}

  /**
   * 1 注文ぶんを発行する。
   *
   * ⚠️ **例外を外へ出さない。** 呼び出し元は決済の Webhook で、そこで
   * 投げると Stripe には「処理できなかった」と伝わり、同じ知らせが
   * 送り直される。決済の確定自体は済んでいるので、それは正しくない。
   */
  async runForOrder(orderId: string): Promise<IssuanceOutcome | null> {
    const now = this.config.clock.now();
    try {
      const result = await this.config.repository.issueForOrder(orderId, now);
      if (!result.ok) {
        await this.fail(orderId, result.error.code);
        return null;
      }
      if (result.value.issued > 0) {
        await this.config.audit.record({
          actorAccountId: null,
          action: 'entitlement.issued',
          targetType: 'order',
          targetId: orderId,
          /*
            ⚠️ **枚数と注文番号まで。** 購入者・受取トークン・金額は残さない。
               監査ログは調べるためのもので、持ち出せる名簿にしない。
          */
          summary: { orderNumber: result.value.orderNumber, issued: result.value.issued },
        });
      }
      return result.value;
    } catch (error) {
      // ⚠️ 例外の本文はログへ。DB へ入れるのは短い符号だけ。
      this.logger.error({ orderId, err: error }, '受取権の発行に失敗しました');
      await this.fail(orderId, 'unexpected_error');
      return null;
    }
  }

  /**
   * 発行が要る注文を拾って回す（時計から呼ぶ）。
   *
   * ⚠️ **1 件の失敗で残りを止めない。** 1 つの壊れた注文が、後ろに並んだ
   * 正常な注文を巻き添えにする。
   */
  async sweep(limit: number = ISSUANCE_BATCH_SIZE): Promise<{
    readonly picked: number;
    readonly issued: number;
    readonly failed: number;
  }> {
    const now = this.config.clock.now();
    const pending = await this.config.repository.listPending(limit, now);

    let issued = 0;
    let failed = 0;
    for (const candidate of pending) {
      const outcome = await this.runForOrder(candidate.orderId);
      if (outcome === null) {
        failed += 1;
      } else {
        issued += outcome.issued;
      }
    }
    return { picked: pending.length, issued, failed };
  }

  /** 受取権の件数と在庫カウンタの食い違いを数える。⚠️ 直さない。 */
  reconcile(): Promise<SupplyReconciliation[]> {
    return this.config.repository.reconcile();
  }

  private async fail(orderId: string, code: string): Promise<void> {
    /*
      ⚠️ **試行回数を数えるのはリポジトリ。** ここで「読んで、足して、渡す」に
         すると、同時に 2 本走ったときに両方が同じ値を読み、数え落とす。
    */
    const retry = await this.config.repository.recordFailure({
      orderId,
      code,
      now: this.config.clock.now(),
    });

    if (retry.exhausted) {
      /*
        ⚠️ **止めたことを記録に残す。** 黙って止めると、購入者の画面が
           「準備中」のまま動かず、運営も気づかない。
      */
      await this.config.audit.record({
        actorAccountId: null,
        action: 'entitlement.issue_gave_up',
        targetType: 'order',
        targetId: orderId,
        summary: { code, attemptCount: retry.attemptCount },
      });
      this.logger.error({ orderId, code }, '受取権の発行を上限まで試して諦めました');
    }
  }
}
