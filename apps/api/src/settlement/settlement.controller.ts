import { Body, Controller, ForbiddenException, Get, Inject, Put } from '@nestjs/common';
import {
  settlementSettingsResponseSchema,
  updateSettlementSettingsRequestSchema,
  type SettlementSettingsResponse,
  type SettlementSettingsView,
} from '@sengoku/contracts';
import type { Actor } from '@sengoku/auth';
import {
  validateSettlementSettings,
  type AuditLogPort,
  type IntegrationEnvironment,
  type SettlementSettingsRepository,
} from '@sengoku/domain';
import { CurrentActor, RequireAction, RequireFreshAuth } from '../auth/auth.guard';
import { DomainErrorException } from '../common/domain-error.filter';
import { parseOrThrow } from '../common/validation';

/**
 * 注入の合図。
 *
 * ⚠️ **型では注入できない。** `SettlementConfig` は interface なので、
 * 実行時には消える。Nest は型情報で解決するため、合図を明示する。
 */
export const SETTLEMENT_CONFIG = Symbol('sengoku:settlement-config');

export interface SettlementConfig {
  readonly repository: SettlementSettingsRepository;
  /** このプロセスの環境。⚠️ 要求から受け取らない。 */
  readonly appEnvironment: IntegrationEnvironment;
  readonly audit: AuditLogPort;
}

/**
 * 返金と精算の設定（`UD-104` / `UD-119`）。
 *
 * ⚠️ **ここで変えられるのは「これから」だけ。** 過去の注文の返金期限も、
 * 確定した精算の内訳も動かない。焼き付けてあるため
 * （`docs/SETTLEMENT_AND_REFUND.md` §1）。
 *
 * ⚠️ **変更はオーナー限定＋再認証。** 購入者への返金と作家さまへの支払いの
 * **両方**を動かす。運営の 1 人が乗っ取られただけで「返金を受け付けない」
 * 「支払いを止める」に書き換えられる。
 */
@Controller('api/v1/admin/settlement-settings')
export class AdminSettlementController {
  constructor(@Inject(SETTLEMENT_CONFIG) private readonly config: SettlementConfig) {}

  /**
   * いまの設定。
   *
   * ⚠️ **`auditor` にも開く。** 返金の条件が見えないと監査にならない。
   * 秘密ではなく取り決めなので、隠す理由が無い。
   */
  @Get()
  @RequireAction('settlement.view')
  async read(): Promise<SettlementSettingsResponse> {
    const settings = await this.config.repository.find(this.config.appEnvironment);
    // ⚠️ 未設定なら `null`。既定値を返さない。
    return parseOrThrow(settlementSettingsResponseSchema, { settings });
  }

  @Put()
  @RequireAction('settlement.manage')
  @RequireFreshAuth()
  async update(
    @CurrentActor() actor: Actor,
    @Body() rawBody: unknown,
  ): Promise<SettlementSettingsView> {
    const body = parseOrThrow(updateSettlementSettingsRequestSchema, rawBody);

    /*
      ⚠️ **形だけでなく、組み合わせも見る。** 返金期間が精算までの猶予を
         超えると、「支払い済みの注文が返金される」が常態になる。
         作家さまから返してもらう作業が毎月発生する。
    */
    const validated = validateSettlementSettings(body);
    if (!validated.ok) {
      throw new DomainErrorException(validated.error.code);
    }

    const before = await this.config.repository.find(this.config.appEnvironment);
    const saved = await this.config.repository.save(this.config.appEnvironment, validated.value);

    await this.config.audit.record({
      actorAccountId: requireAccountId(actor),
      action: 'settlement.settings_updated',
      targetType: 'settlement_settings',
      targetId: this.config.appEnvironment,
      /*
        ⚠️ **前後を両方残す。** 「14 日から 30 日にした」が分からないと、
           あとで「なぜこの注文は返金できたのか」を説明できない。
           秘密ではないので、値そのものを残してよい。
      */
      summary: {
        before: before === null ? null : { ...before },
        after: { ...saved },
      },
    });

    return saved;
  }
}

function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    // ガードが通しているので通常は来ない。来たら開かない側へ倒す。
    throw new ForbiddenException();
  }
  return actor.accountId;
}
