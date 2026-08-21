import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { CustomerDetailResponse, CustomerSearchResponse } from '@sengoku/contracts';
import {
  addAccountNoteRequestSchema,
  customerSearchRequestSchema,
  openEmailChangeRequestSchema,
  settleEmailChangeRequestSchema,
  verifyIdentityRequestSchema,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import { CurrentActor, RequireAction } from '../auth/auth.guard';
import { parseOrThrow } from '../common/validation';
import { CustomerSupportService } from './customer.service';

/**
 * 顧客サポート（実運営 指示書 P1-1）。
 *
 * ⚠️ **付け替えの口をここに生やさない。** 注文・受取権・ウォレットの
 * 持ち主を人が変えられる経路は、この controller に存在しない。
 *
 * ⚠️ **救済は既存の口を使う。** Claim の再発行は `/api/v1/admin/claims/...`、
 * ウォレットへの再配送は `/api/v1/admin/operations/accounts/:id/redeliver`。
 * ここで作り直すと、規則が 2 か所に散る。
 */
@Controller('api/v1/admin/customers')
export class CustomerController {
  constructor(private readonly customers: CustomerSupportService) {}

  /**
   * 顧客を探す。
   *
   * ⚠️ **`GET` にしない。** 手がかりに平文のアドレスを含むので、
   * URL に載せると、アクセスログと履歴と Referer に残る。
   */
  @Post('search')
  @RequireAction('customer.view')
  search(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<CustomerSearchResponse> {
    return this.customers.search(parseOrThrow(customerSearchRequestSchema, body), actor);
  }

  @Get(':accountId')
  @RequireAction('customer.view')
  detail(@Param('accountId') accountId: string): Promise<CustomerDetailResponse> {
    return this.customers.detail(accountId);
  }

  /** 申し送りを書く。⚠️ 追記のみ。直す口も消す口も無い。 */
  @Post(':accountId/notes')
  @RequireAction('customer.note')
  async addNote(
    @CurrentActor() actor: Actor,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<{ readonly ok: true }> {
    const parsed = parseOrThrow(addAccountNoteRequestSchema, body);
    await this.customers.addNote(accountId, parsed.body, actor);
    return { ok: true };
  }

  /**
   * ご連絡先の変更を申し出として受ける。
   *
   * ⚠️ **この操作でアドレスは変わらない。** 変えるのは認証基盤側で人が行う。
   */
  @Post(':accountId/email-changes')
  @RequireAction('customer.email_change')
  async openEmailChange(
    @CurrentActor() actor: Actor,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<{ readonly id: string }> {
    const parsed = parseOrThrow(openEmailChangeRequestSchema, body);
    const id = await this.customers.openEmailChange(accountId, parsed.newEmail, actor);
    return { id };
  }

  /** 本人確認を記録する。⚠️ 「誰が」が必ず残る。 */
  @Post('email-changes/:id/verify')
  @RequireAction('customer.email_change')
  async verify(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ readonly ok: true }> {
    const parsed = parseOrThrow(verifyIdentityRequestSchema, body);
    await this.customers.verifyIdentity(id, parsed.method, parsed.note, actor);
    return { ok: true };
  }

  /** 決着させる。⚠️ **本人確認を飛ばして「済」にはできない。** */
  @Post('email-changes/:id/settle')
  @RequireAction('customer.email_change')
  async settle(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ readonly ok: true }> {
    const parsed = parseOrThrow(settleEmailChangeRequestSchema, body);
    await this.customers.settleEmailChange(id, parsed.status, parsed.note, actor);
    return { ok: true };
  }

  /*
    ⚠️ **ここに置かないもの（指示書 §11 の明示的な禁止）:**
      - 注文の持ち主を変える口
      - 受取権の持ち主を変える口
      - ウォレットの持ち主を変える口
      - 重複アカウントを統合する口
    本人確認をしていない付け替えは、他人の持ち物を渡すことと同じである。
    重複は**候補の表示まで**で、判断も統合も人の手による別の手続きとする。
  */

  /** 見つからない検索の手がかりを弾く。⚠️ `Query` は使わない（上の注記）。 */
  @Get()
  @RequireAction('customer.view')
  index(@Query() _query: unknown): { readonly hint: string } {
    /*
      ⚠️ **条件無しの一覧を作らない。** 顧客をただ眺められる画面は業務に
         要らないうえに、漏れたときの被害がいちばん大きい。
    */
    return { hint: '検索の手がかりを指定してください（POST /search）。' };
  }
}
