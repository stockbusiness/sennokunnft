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
  ReleaseExpiredResponse,
} from '@sengoku/contracts';
import { AUTO_DELIVERY_BATCH_SIZE, ISSUANCE_BATCH_SIZE, RELEASE_BATCH_SIZE } from '@sengoku/domain';
import { Public } from '../auth/auth.guard';
import type { WalletAutoDeliveryService } from '../claim/auto-delivery.service';
import { EntitlementIssuanceService } from './issuance.service';
import { OrderService } from './order.service';

export const INTERNAL_JOB_CONFIG = Symbol('sengoku:internal-job-config');

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
    const released = await this.orders.releaseExpiredReservations(RELEASE_BATCH_SIZE);
    return {
      releasedCount: released.length,
      // ⚠️ 注文IDまで。購入者・作品名・金額は返さない。
      orderIds: released.map((entry) => entry.orderId),
    };
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
    if (this.config.autoDelivery === null) {
      // Wallet へ繋いでいない配備。⚠️ 黙って 0 を返す（異常ではない）。
      return { pickedCount: 0, deliveredCount: 0, skippedCount: 0, failedCount: 0 };
    }
    const result = await this.config.autoDelivery.sweep(AUTO_DELIVERY_BATCH_SIZE);
    return {
      pickedCount: result.picked,
      deliveredCount: result.delivered,
      skippedCount: result.skipped,
      failedCount: result.failed,
    };
  }

  /**
   * 合言葉を確かめる。
   *
   * ⚠️ **`===` で比べない。** 文字列比較は先頭から一致した長さで所要時間が
   * 変わるため、繰り返し呼んで測ると 1 文字ずつ言い当てられる。
   * ⚠️ 失敗の理由を返さない。「長さが違う」も「値が違う」も同じ 401。
   */
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
