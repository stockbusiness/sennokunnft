import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type {
  DeliverEntitlementsResponse,
  IssueEntitlementsResponse,
  ReconcileRevocationsResponse,
  ReleaseExpiredResponse,
  SendNotificationsResponse,
} from '@sengoku/contracts';
import {
  AUTO_DELIVERY_BATCH_SIZE,
  ISSUANCE_BATCH_SIZE,
  NOTIFICATION_BATCH_SIZE,
  RELEASE_BATCH_SIZE,
} from '@sengoku/domain';
import type { ClockPort } from '@sengoku/domain';
import { Public } from '../auth/auth.guard';
import type { WalletAutoDeliveryService } from '../claim/auto-delivery.service';
import {
  REVOCATION_RECONCILE_BATCH_SIZE,
  type RevocationReconcileService,
} from '../claim/revocation-reconcile.service';
import type { NotificationSendService } from '../notification/send.service';
import { EntitlementIssuanceService } from './issuance.service';
import { OrderService } from './order.service';

export const INTERNAL_JOB_CONFIG = Symbol('sengoku:internal-job-config');

/**
 * 生死を見張る時計仕掛け（P0-6）。
 *
 * ⚠️ **ここが一覧の正。** 画面側で別に並べると、時計を足したときに
 * 片方だけ古くなり、**足したはずの処理が見張られていない**状態になる。
 */
export const WATCHED_JOB_KEYS = [
  'release-expired-reservations',
  'issue-entitlements',
  'deliver-entitlements',
  'reconcile-revocations',
  'send-notifications',
] as const;

/** 時計仕掛けの結果を記録する口。⚠️ 実装は `@sengoku/database`。 */
export interface JobRunRecorder {
  recordJobRun(input: {
    readonly jobKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly pickedCount?: number | undefined;
    readonly errorCode?: string | undefined;
    readonly now: Date;
  }): Promise<void>;
}

export interface InternalJobConfig {
  /** ⚠️ 未設定なら、このコントローラは登録されない（配線側で切る）。 */
  readonly token: string;
  /**
   * Wallet への自動配送（P0-2）。
   *
   * ⚠️ **`null` は「まだ Wallet へ繋がない」を意味する。** 繋がない配備でも
   * 口だけは生やし、**呼ばれたら 0 件を返す**。口ごと消すと、時計の設定を
   * 配備ごとに変えることになり、繋いだ日に設定漏れで動かない。
   */
  readonly autoDelivery: WalletAutoDeliveryService | null;
  /**
   * 取消の知らせの取りこぼしを埋める処理（M3a）。
   *
   * ⚠️ **`null` は「取消イベントを作らない」を意味する**（生成フラグが無効）。
   * 補完もこのフラグに従う。従わせないと、無効へ戻したのに日次の時計が
   * 作り続ける——「止めたはずのものが別の入口から動く」状態になる。
   */
  readonly revocationReconcile: RevocationReconcileService | null;
  /**
   * 購入者への知らせを送る処理（P0-4）。
   *
   * ⚠️ **`null` は「まだ送らない」を意味する。** 送らない配備でも口だけは
   * 生やし、**呼ばれたら 0 件を返す**。口ごと消すと、時計の設定を配備ごとに
   * 変えることになり、送り始めた日に設定漏れで動かない。
   */
  readonly notificationSend: NotificationSendService | null;
  /**
   * 実行の結果を記録する先（P0-6）。
   *
   * ⚠️ **`null` にしない。** 記録が無いと、運営の画面では「一度も成功して
   * いない」と「そもそも記録していない」が区別できない。
   */
  readonly jobRuns: JobRunRecorder;
  readonly clock: ClockPort;
}

/**
 * 内部ジョブ（指示書 §4.4）。
 *
 * ⚠️ **`@Public()` を付けているが、誰でも呼べるわけではない。** 利用者の
 * ログインでは通さず、配備環境の合言葉だけで通す。ロール判定に載せると、
 * 「運営が呼べる操作」として管理画面に現れてしまう。これは人が押すボタン
 * ではなく、時計が叩く口である。
 *
 * ⚠️ **合言葉が未設定の環境では、この経路ごと生やさない。** 「未設定なら
 * 素通し」にすると、設定を忘れた環境で外から在庫を操作できてしまう。
 */
@Controller('api/v1/internal/jobs')
export class InternalJobsController {
  constructor(
    private readonly orders: OrderService,
    private readonly issuance: EntitlementIssuanceService,
    @Inject(INTERNAL_JOB_CONFIG) private readonly config: InternalJobConfig,
  ) {}

  @Post('release-expired-reservations')
  @Public()
  @HttpCode(HttpStatus.OK)
  async releaseExpiredReservations(
    @Headers('x-internal-job-token') token: string | undefined,
  ): Promise<ReleaseExpiredResponse> {
    this.assertAuthorized(token);
    return this.record(
      'release-expired-reservations',
      async () => {
        const released = await this.orders.releaseExpiredReservations(RELEASE_BATCH_SIZE);
        return {
          releasedCount: released.length,
          // ⚠️ 注文IDまで。購入者・作品名・金額は返さない。
          orderIds: released.map((entry) => entry.orderId),
        };
      },
      (result) => result.releasedCount,
    );
  }

  /**
   * 受取権の発行を掃き出す（P0-1）。
   *
   * ⚠️ **これは取りこぼしの受け皿であって、主たる経路ではない。** ふだんは
   * 決済確定の直後にその場で発行される。ここが拾うのは、その直後に
   * プロセスが落ちた注文と、外部の不調で失敗した注文だけ。
   *
   * ⚠️ **重なって走っても増えない。** 作るのは足りない枚数だけで、
   * `UNIQUE(order_line_id, unit_index)` が最終防壁になっている。
   */
  @Post('issue-entitlements')
  @Public()
  @HttpCode(HttpStatus.OK)
  async issueEntitlements(
    @Headers('x-internal-job-token') token: string | undefined,
  ): Promise<IssueEntitlementsResponse> {
    this.assertAuthorized(token);
    return this.record(
      'issue-entitlements',
      async () => {
        const result = await this.issuance.sweep(ISSUANCE_BATCH_SIZE);
        /*
          ⚠️ **注文番号も購入者も返さない。** これは時計が叩く口で、
             応答は監視の数値として読まれる。人の情報を混ぜない。
        */
        return {
          pickedCount: result.picked,
          issuedCount: result.issued,
          failedCount: result.failed,
        };
      },
      (result) => result.pickedCount,
    );
  }

  /**
   * Wallet への自動配送を掃き出す（P0-2）。
   *
   * ⚠️ **これは「登録が済んだ方から順に届ける」口でもある。** 受取用の
   * ウォレットを買ったあとで登録した方は、共通顧客IDが解決した時点で
   * ここに拾われる——**登録完了の合図を別に作らずに**配送が再開する。
   *
   * ⚠️ **重なって走っても二重に届かない。** 受取の確定は現在の状態を条件に
   * した更新で行うので、勝てるのは 1 本だけ。負けた側は「すでに受け取り済み」
   * として数える。
   */
  @Post('deliver-entitlements')
  @Public()
  @HttpCode(HttpStatus.OK)
  async deliverEntitlements(
    @Headers('x-internal-job-token') token: string | undefined,
  ): Promise<DeliverEntitlementsResponse> {
    this.assertAuthorized(token);
    return this.record(
      'deliver-entitlements',
      async () => {
        const autoDelivery = this.config.autoDelivery;
        if (autoDelivery === null) {
          /*
            Wallet へ繋いでいない配備。⚠️ 黙って 0 を返す（異常ではない）。
            ⚠️ **それでも成功として記録する。** 記録しないと運営の画面には
               「一度も成功していない」と出て、繋いでいないだけなのに
               止まっているように見える。
          */
          return { pickedCount: 0, deliveredCount: 0, skippedCount: 0, failedCount: 0 };
        }
        const result = await autoDelivery.sweep(AUTO_DELIVERY_BATCH_SIZE);
        return {
          pickedCount: result.picked,
          deliveredCount: result.delivered,
          skippedCount: result.skipped,
          failedCount: result.failed,
        };
      },
      (result) => result.pickedCount,
    );
  }

  /**
   * 取消の知らせの取りこぼしを埋める（M3a）。
   *
   * ⚠️ **これは取りこぼしの受け皿であって、主たる経路ではない。** ふだんは
   * 返金と同じトランザクションで積まれる。ここが拾うのは、生成フラグが
   * 無効だったあいだに取り消された分だけ。
   *
   * ⚠️ **重なって走っても増えない。** イベントIDが受取権IDから決まり、
   * 追加は衝突時に何もしないため。
   */
  @Post('reconcile-revocations')
  @Public()
  @HttpCode(HttpStatus.OK)
  async reconcileRevocations(
    @Headers('x-internal-job-token') token: string | undefined,
  ): Promise<ReconcileRevocationsResponse> {
    this.assertAuthorized(token);
    return this.record(
      'reconcile-revocations',
      async () => {
        const reconcile = this.config.revocationReconcile;
        if (reconcile === null) {
          // 取消イベントを作らない配備。⚠️ 黙って 0 を返す（異常ではない）。
          return {
            pickedCount: 0,
            createdCount: 0,
            duplicateCount: 0,
            needsReviewCount: 0,
            conflictCount: 0,
            truncated: false,
          };
        }
        const result = await reconcile.run(REVOCATION_RECONCILE_BATCH_SIZE);
        return {
          pickedCount: result.picked,
          createdCount: result.created,
          duplicateCount: result.duplicate,
          needsReviewCount: result.needsReview,
          conflictCount: result.conflicts,
          truncated: result.truncated,
        };
      },
      (result) => result.pickedCount,
    );
  }

  /**
   * 合言葉を確かめる。
   *
   * ⚠️ **`===` で比べない。** 文字列比較は先頭から一致した長さで所要時間が
   * 変わるため、繰り返し呼んで測ると 1 文字ずつ言い当てられる。
   * ⚠️ 失敗の理由を返さない。「長さが違う」も「値が違う」も同じ 401。
   */
  /**
   * 積まれた知らせを送る（P0-4）。
   *
   * ⚠️ **業務処理の側では送らない。** 注文や返金のトランザクションから
   * 外部へ送ると、相手の応答を待つあいだ行を握り続ける。積むところまでを
   * 業務と同じトランザクションで行い、送るのはここ。
   *
   * ⚠️ **重なって走っても二重に届かない。** 掴むのが排他的で、
   * 送信事業者側の冪等キーも行の識別子から決まるため。
   */
  @Post('send-notifications')
  @Public()
  @HttpCode(HttpStatus.OK)
  async sendNotifications(
    @Headers('x-internal-job-token') token: string | undefined,
  ): Promise<SendNotificationsResponse> {
    this.assertAuthorized(token);
    return this.record(
      'send-notifications',
      async () => {
        const send = this.config.notificationSend;
        if (send === null) {
          // まだ送らない配備。⚠️ 黙って 0 を返す（異常ではない）。
          return { pickedCount: 0, sentCount: 0, skippedCount: 0, failedCount: 0 };
        }
        const result = await send.sweep(NOTIFICATION_BATCH_SIZE);
        /*
          ⚠️ **宛先も注文番号も返さない。** これは時計が叩く口で、
             応答は監視の数値として読まれる。人の情報を混ぜない。
        */
        return {
          pickedCount: result.picked,
          sentCount: result.sent,
          skippedCount: result.skipped,
          failedCount: result.failed,
        };
      },
      (result) => result.pickedCount,
    );
  }

  /**
   * 実行の結果を記録しながら走らせる（P0-6）。
   *
   * ⚠️ **合言葉の検査より後で包む。** 通らなかった呼び出しを失敗として
   * 数えると、設定を間違えた監視ツール 1 つで画面が赤くなり続ける。
   *
   * ⚠️ **記録に失敗しても本来の結果を返す。** 記録は見張るための控えで、
   * それが書けないことを理由に業務の処理を失敗させない。
   */
  private async record<T>(
    jobKey: string,
    run: () => Promise<T>,
    countOf?: (result: T) => number,
  ): Promise<T> {
    const now = this.config.clock.now();
    let result: T;
    try {
      result = await run();
    } catch (error) {
      // ⚠️ 例外の中身をそのまま入れない。分類だけ残す。
      await this.safelyRecord({
        jobKey,
        outcome: 'failed',
        errorCode: error instanceof Error ? error.name : 'unknown',
        now,
      });
      throw error;
    }
    await this.safelyRecord({
      jobKey,
      outcome: 'succeeded',
      pickedCount: countOf === undefined ? undefined : countOf(result),
      now,
    });
    return result;
  }

  private async safelyRecord(input: {
    readonly jobKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly pickedCount?: number | undefined;
    readonly errorCode?: string | undefined;
    readonly now: Date;
  }): Promise<void> {
    try {
      await this.config.jobRuns.recordJobRun(input);
    } catch {
      // ⚠️ 握りつぶす。見張りの控えが書けないことで処理を止めない。
    }
  }

  private assertAuthorized(token: string | undefined): void {
    if (token === undefined) {
      throw new UnauthorizedException();
    }
    const provided = Buffer.from(token, 'utf8');
    const expected = Buffer.from(this.config.token, 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException();
    }
  }
}
