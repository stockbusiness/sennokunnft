import { Body, Controller, Get, Post } from '@nestjs/common';
import type {
  AttestationListResponse,
  MailCheckResponse,
  ProductionReadinessResponse,
} from '@sengoku/contracts';
import { recordAttestationRequestSchema } from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction, RequireFreshAuth } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { MailCheckService } from './mail-check.service';
import { ProductionReadinessService } from './readiness.service';

/**
 * 本番販売ガード（実運営 指示書 P0-7）。
 *
 * ⚠️ **画面を隠すことは保護ではない。** 条件未達で支払い口を作らせない
 * 判定は、この画面ではなく支払い口を作る側（`CheckoutService`）が行う。
 * ここは「いま何が足りないか」を見せ、証跡を残すための入口である。
 */
@Controller('api/v1/admin/production')
export class ProductionController {
  constructor(
    private readonly readiness: ProductionReadinessService,
    private readonly mail: MailCheckService,
  ) {}

  /** 10 条件の充足状況。⚠️ 鍵は返さない（有無と確認の結果まで）。 */
  @Get('readiness')
  @RequireAction('production.view')
  status(): Promise<ProductionReadinessResponse> {
    return this.readiness.status();
  }

  /** 押された記録の一覧。⚠️ 消せないので、やり直した回数も読める。 */
  @Get('attestations')
  @RequireAction('production.view')
  list(): Promise<AttestationListResponse> {
    return this.readiness.listAttestations();
  }

  /**
   * 証跡を残す。
   *
   * ⚠️ **オーナーだけ**（`OWNER_ONLY_ACTIONS`）。押した記録が 10 条件の
   * うち 2 つを埋める。運営の 1 人が乗っ取られただけで本番販売が
   * 始められる状態にしない。
   *
   * ⚠️ **最近ログインし直していることを求める。** 開きっぱなしの画面を
   * 借りて押される事故を減らす（`UD-118` と同じ扱い）。
   */
  @Post('attestations')
  @RequireAction('production.attest')
  @RequireFreshAuth()
  attest(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ readonly id: string }> {
    return this.readiness.attest(actor, parseOrThrow(recordAttestationRequestSchema, body));
  }

  /**
   * メールの試し送り。
   *
   * ⚠️ **宛先を受け取らない。** 押した本人の業務用アドレスへ送る。
   * 受け取る形にすると、この口が「任意の相手へメールを送れる口」になる。
   */
  @Post('mail-check')
  @RequireAction('production.mail_check')
  mailCheck(@CurrentActor() actor: Actor): Promise<MailCheckResponse> {
    return this.mail.run(actor);
  }
}
