import { describe, expect, it } from 'vitest';
import {
  CHECK_FRESHNESS_MS,
  activateSecret,
  disableIntegration,
  discardPendingSecret,
  enableIntegration,
  integrationScope,
  isCheckFresh,
  updateSettings,
  type IntegrationSecret,
  type IntegrationSettings,
} from '../src/index';

/**
 * 外部連携の設定と資格情報（管理画面・外部連携 指示書 §4・§7・§9）。
 *
 * ⚠️ **この試験の主題は「有効にできないこと」。**
 * 有効にした瞬間から本物の送信が始まる。通らない設定で有効化できる穴だけが
 * 事故になるので、「できた」より「できなかった」を厚く見る。
 */

const NOW = new Date('2026-08-18T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - CHECK_FRESHNESS_MS - 1000);

function settings(overrides: Partial<IntegrationSettings> = {}): IntegrationSettings {
  return {
    id: 'setting-1',
    service: 'ovew_wallet',
    environment: 'production',
    endpointUrl: 'https://wallet.example.com/api',
    apiVersion: 'v1.1',
    timeoutMs: 10_000,
    maxAttempts: 5,
    enabled: false,
    rowVersion: 1,
    ...overrides,
  };
}

function secret(overrides: Partial<IntegrationSecret> = {}): IntegrationSecret {
  return {
    id: 'secret-1',
    service: 'ovew_wallet',
    environment: 'production',
    purpose: 'hmac_secret',
    keyVersion: 'v1',
    lastFour: '7K9P',
    status: 'pending',
    activatedAt: null,
    retiredAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('設定の書き換え', () => {
  it('https 以外の接続先を受け付けない', () => {
    // 平文で送ると、経路上で資格情報を抜かれる。
    const result = updateSettings(settings(), { endpointUrl: 'http://wallet.example.com' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTEGRATION_ENDPOINT_INSECURE');
  });

  it('接続先の値を例外の詳細へ載せない', () => {
    // ホスト名が混ざる。
    const result = updateSettings(settings(), { endpointUrl: 'http://secret-host.internal' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain('secret-host');
  });

  it('接続先を変えたことを呼び出し側へ伝える', () => {
    // 別の相手に対する成功をそのまま使わせないため。
    const result = updateSettings(settings(), { endpointUrl: 'https://other.example.com' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpointChanged).toBe(true);
  });

  it('接続先を変えていなければ、そう伝える', () => {
    const result = updateSettings(settings(), { timeoutMs: 20_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpointChanged).toBe(false);
  });

  it('時間の指定が範囲外なら受け付けない', () => {
    expect(updateSettings(settings(), { timeoutMs: 0 }).ok).toBe(false);
    expect(updateSettings(settings(), { timeoutMs: 120_000 }).ok).toBe(false);
    expect(updateSettings(settings(), { timeoutMs: 1.5 }).ok).toBe(false);
  });

  it('再送回数が範囲外なら受け付けない', () => {
    expect(updateSettings(settings(), { maxAttempts: 0 }).ok).toBe(false);
    expect(updateSettings(settings(), { maxAttempts: 100 }).ok).toBe(false);
  });

  it('指定しなかった項目は変わらない', () => {
    const result = updateSettings(settings(), { timeoutMs: 20_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settings.endpointUrl).toBe('https://wallet.example.com/api');
    expect(result.value.settings.maxAttempts).toBe(5);
  });
});

describe('連携を有効にする', () => {
  const base = {
    settings: settings(),
    hasActiveSecret: true,
    lastCheck: { succeeded: true, executedAt: FRESH },
    freshnessMs: CHECK_FRESHNESS_MS,
    now: NOW,
  };

  it('条件がそろえば有効にできる', () => {
    const result = enableIntegration(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enabled).toBe(true);
  });

  it('接続テストをしていなければ有効にできない', () => {
    const result = enableIntegration({ ...base, lastCheck: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTEGRATION_CHECK_REQUIRED');
  });

  it('接続テストが失敗していれば有効にできない', () => {
    const result = enableIntegration({
      ...base,
      lastCheck: { succeeded: false, executedAt: FRESH },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTEGRATION_CHECK_REQUIRED');
  });

  it('古い成功では有効にできない', () => {
    // 設定を直したあとに、直す前の成功で通してしまわないため。
    const result = enableIntegration({
      ...base,
      lastCheck: { succeeded: true, executedAt: STALE },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTEGRATION_CHECK_STALE');
  });

  it('有効な資格情報が無ければ有効にできない', () => {
    const result = enableIntegration({ ...base, hasActiveSecret: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTEGRATION_SECRET_MISSING');
  });

  it('接続先が未設定なら有効にできない', () => {
    const result = enableIntegration({ ...base, settings: settings({ endpointUrl: null }) });
    expect(result.ok).toBe(false);
  });

  it('staging でも条件を緩めない', () => {
    // 緩めると、staging で通した手順が production で通らず、回避される。
    const result = enableIntegration({
      ...base,
      settings: settings({ environment: 'staging' }),
      lastCheck: null,
    });
    expect(result.ok).toBe(false);
  });

  it('止めるほうには条件を付けない', () => {
    // 事故を止める操作なので、いつでも通らなければならない。
    expect(disableIntegration(settings({ enabled: true })).enabled).toBe(false);
    expect(disableIntegration(settings({ endpointUrl: null, enabled: true })).enabled).toBe(false);
  });
});

describe('資格情報の交換', () => {
  const base = {
    secret: secret(),
    current: null,
    lastCheck: { succeeded: true, executedAt: FRESH },
    freshnessMs: CHECK_FRESHNESS_MS,
    now: NOW,
  };

  it('接続テストに通った待機中のものを有効にできる', () => {
    const result = activateSecret(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.activated.status).toBe('active');
    expect(result.value.activated.activatedAt).toEqual(NOW);
    expect(result.value.retired).toBeNull();
  });

  it('入れ替えると、古いほうが退役する', () => {
    const result = activateSecret({
      ...base,
      current: secret({ id: 'secret-0', status: 'active', activatedAt: FRESH }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.retired?.id).toBe('secret-0');
    expect(result.value.retired?.status).toBe('retired');
  });

  it('接続テストをしていなければ有効にできない', () => {
    // 通らない鍵に差し替えると、元の鍵は再表示できないため戻せない。
    const result = activateSecret({ ...base, lastCheck: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTEGRATION_CHECK_REQUIRED');
  });

  it('古い成功では有効にできない', () => {
    const result = activateSecret({ ...base, lastCheck: { succeeded: true, executedAt: STALE } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTEGRATION_CHECK_STALE');
  });

  it('すでに有効なものを重ねて有効にできない', () => {
    const result = activateSecret({
      ...base,
      secret: secret({ status: 'active', activatedAt: FRESH }),
    });
    expect(result.ok).toBe(false);
  });

  it('退役済みのものを呼び戻せない', () => {
    const result = activateSecret({
      ...base,
      secret: secret({ status: 'retired', retiredAt: FRESH }),
    });
    expect(result.ok).toBe(false);
  });

  it('別の用途の鍵を巻き込んで退役させない', () => {
    const result = activateSecret({
      ...base,
      current: secret({ id: 'other', purpose: 'api_key', status: 'active', activatedAt: FRESH }),
    });
    expect(result.ok).toBe(false);
  });

  it('待機中のものは捨てられる', () => {
    const result = discardPendingSecret(secret(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('retired');
  });

  it('いま有効なものは、この操作では捨てられない', () => {
    // 外すのは、新しいものを有効にする操作の裏側でしか起きない。
    const result = discardPendingSecret(secret({ status: 'active', activatedAt: FRESH }), NOW);
    expect(result.ok).toBe(false);
  });
});

describe('接続テストの新しさ', () => {
  it('成功して 30 分以内なら有効', () => {
    expect(isCheckFresh({ succeeded: true, executedAt: FRESH }, CHECK_FRESHNESS_MS, NOW)).toBe(
      true,
    );
  });

  it('ちょうど 30 分は有効、超えたら無効', () => {
    const exact = new Date(NOW.getTime() - CHECK_FRESHNESS_MS);
    const over = new Date(NOW.getTime() - CHECK_FRESHNESS_MS - 1);
    expect(isCheckFresh({ succeeded: true, executedAt: exact }, CHECK_FRESHNESS_MS, NOW)).toBe(
      true,
    );
    expect(isCheckFresh({ succeeded: true, executedAt: over }, CHECK_FRESHNESS_MS, NOW)).toBe(
      false,
    );
  });

  it('失敗と未実施は有効にならない', () => {
    expect(isCheckFresh({ succeeded: false, executedAt: FRESH }, CHECK_FRESHNESS_MS, NOW)).toBe(
      false,
    );
    expect(isCheckFresh(null, CHECK_FRESHNESS_MS, NOW)).toBe(false);
  });
});

describe('結び付け情報', () => {
  it('サービスと環境の組で決まる', () => {
    expect(integrationScope('ovew_wallet', 'production')).toBe('ovew_wallet:production');
    expect(integrationScope('ovew_wallet', 'staging')).not.toBe(
      integrationScope('ovew_wallet', 'production'),
    );
  });
});
