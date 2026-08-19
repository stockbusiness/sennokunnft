import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { PaymentCredentialListResponse } from '@sengoku/contracts';
import {
  activatePaymentCredentialRequestSchema,
  registerPaymentCredentialRequestSchema,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction, RequireFreshAuth } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { PaymentCredentialService } from './payment-credential.service';

/**
 * 決済資格情報の世代（`UD-118`）。
 *
 * ⚠️ **登録・有効化・受付切替・退役はオーナー限定＋再認証。** 入金先が
 * 変わる操作なので、運営の 1 人が乗っ取られただけで売上の振込先を
 * 差し替えられる形にしない。判定はガードが済ませており、ここで再判定しない。
 *
 * ⚠️ **接続確認には再認証を求めない。** 何も変えない操作で、むしろ
 * 何度でも試せるほうがよい。
 *
 * ⚠️ **登録済みの鍵を返す経路を作らない。** 取得系が返すのは状態と
 * アカウント識別子までで、鍵の値・先頭・末尾は返さない。
 */
@Controller('api/v1/admin/payment-credentials')
export class PaymentCredentialController {
  constructor(private readonly credentials: PaymentCredentialService) {}

  @Get()
  @RequireAction('payment_credential.view')
  list(): Promise<PaymentCredentialListResponse> {
    return this.credentials.list();
  }

  @Post()
  @RequireAction('payment_credential.manage')
  @RequireFreshAuth()
  register(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<PaymentCredentialListResponse> {
    return this.credentials.register(
      actor,
      parseOrThrow(registerPaymentCredentialRequestSchema, body),
    );
  }

  /**
   * 接続確認。
   *
   * ⚠️ **有効化の前に必ず通す。** 鍵の打ち間違いをここで止める。
   */
  @Post(':id/check')
  @RequireAction('payment_credential.manage')
  check(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ): Promise<PaymentCredentialListResponse> {
    return this.credentials.check(actor, id);
  }

  @Post(':id/activate')
  @RequireAction('payment_credential.manage')
  @RequireFreshAuth()
  activate(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentCredentialListResponse> {
    return this.credentials.activate(
      actor,
      id,
      parseOrThrow(activatePaymentCredentialRequestSchema, body),
    );
  }

  /**
   * 新規受付を止める。
   *
   * ⚠️ **退役ではない。** 返金と照会はこの世代の鍵で続く。
   */
  @Post(':id/stop-accepting')
  @RequireAction('payment_credential.manage')
  @RequireFreshAuth()
  stopAccepting(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentCredentialListResponse> {
    const request = parseOrThrow(activatePaymentCredentialRequestSchema, body);
    return this.credentials.setAccepting(actor, id, false, request.confirmation ?? null);
  }

  /** 切り戻し。⚠️ 受付世代が別にあると DB の部分UNIQUE が弾く。 */
  @Post(':id/resume-accepting')
  @RequireAction('payment_credential.manage')
  @RequireFreshAuth()
  resumeAccepting(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentCredentialListResponse> {
    const request = parseOrThrow(activatePaymentCredentialRequestSchema, body);
    return this.credentials.setAccepting(actor, id, true, request.confirmation ?? null);
  }

  /**
   * 退役させる。
   *
   * ⚠️ **削除ではない。** 鍵は残る。署名検証の対象から外れる候補になるだけ。
   */
  @Post(':id/retire')
  @RequireAction('payment_credential.manage')
  @RequireFreshAuth()
  retire(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentCredentialListResponse> {
    const request = parseOrThrow(activatePaymentCredentialRequestSchema, body);
    return this.credentials.retire(actor, id, request.confirmation ?? null);
  }
}
