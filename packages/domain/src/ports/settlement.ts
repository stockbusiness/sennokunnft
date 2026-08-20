import type { IntegrationEnvironment } from '../integration/service';
import type { SettlementSettings } from '../settlement/settings';

/**
 * 返金と精算の設定を読み書きする口（`UD-104` / `UD-119`）。
 *
 * ⚠️ **読むのは「新しく記録を作るとき」だけ。** 過去の記録を判定し直す
 * ときに読んではいけない。読むと、設定を変えた瞬間に過去の判定が変わる
 * （`docs/SETTLEMENT_AND_REFUND.md` §1）。
 *
 * ⚠️ **未設定なら `null` を返す。既定値を作らない。** ここで気を利かせて
 * 14 日を返すと、決めていないまま売れてしまう。手数料率（`UD-109`）と
 * 同じ向き。
 */
export interface SettlementSettingsRepository {
  find(environment: IntegrationEnvironment): Promise<SettlementSettings | null>;

  /**
   * 設定を書き換える。
   *
   * ⚠️ **オーナー限定＋監査に残す**（呼び出し側の責務）。返金期間と
   * 締めは、作家さまへの支払いと購入者への返金の両方を動かす。
   */
  save(
    environment: IntegrationEnvironment,
    settings: SettlementSettings,
  ): Promise<SettlementSettings>;
}
