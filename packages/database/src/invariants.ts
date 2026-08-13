/**
 * 冪等性・排他制御を担保する SQL と制約の一覧。
 *
 * これらを**コードのコメントではなくエクスポートされた定数**として置いているのは、
 * 「なぜこの書き方でなければならないか」を実装から切り離さないため。
 * Phase 4 / 5 の実装はここを参照する。
 *
 * 根拠: DATABASE_DESIGN.md §4、LAZY_MINT_FLOW.md §3.4-3.5
 */

/**
 * 受取権の Claim（INV-E1）。
 *
 * ⚠️ 「SELECT して status を確認してから UPDATE」にしてはならない。
 * 読み取りと書き込みの間に別トランザクションが割り込み、
 * 同時 Claim が両方成功しうる。
 *
 * **更新行数が 1 のときのみ成功**とすることで、同時実行でも 1 回しか通らない。
 */
export const ENTITLEMENT_CLAIM_SQL = `
UPDATE entitlements
   SET status = 'claimed',
       claimed_by_account_id = $1,
       claimed_at = now(),
       updated_at = now()
 WHERE id = $2
   AND status = 'issued'
   AND (expires_at IS NULL OR expires_at > now())
`.trim();

/**
 * 発行ジョブの排他取得（INV-M1）。
 *
 * `FOR UPDATE SKIP LOCKED` により、複数ワーカーが同時に走っても
 * 同じ行を掴まない。ロック待ちで詰まることもない。
 */
export const MINT_JOB_ACQUIRE_SQL = `
UPDATE mint_jobs
   SET status = 'processing',
       locked_at = now(),
       attempt_count = attempt_count + 1,
       updated_at = now()
 WHERE id IN (
   SELECT id
     FROM mint_jobs
    WHERE status = 'queued'
      AND next_attempt_at <= now()
    ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
    LIMIT $1
 )
RETURNING *
`.trim();

export interface IdempotencyConstraint {
  readonly table: string;
  readonly constraint: string;
  /** この制約がなければ起きる事故。 */
  readonly prevents: string;
}

/**
 * 冪等性を担保する DB 制約の一覧（DATABASE_DESIGN.md §4）。
 *
 * アプリの if 文ではなく制約で守る理由: 競合状態ではアプリのチェックは破れるが、
 * DB の制約は破れないため。
 */
export const IDEMPOTENCY_CONSTRAINTS: readonly IdempotencyConstraint[] = [
  {
    table: 'webhook_events',
    constraint: 'UNIQUE (provider, event_id)',
    prevents: '同一Webhookの二重処理',
  },
  {
    table: 'orders',
    constraint: 'UNIQUE (account_id, idempotency_key)',
    prevents: '二重注文',
  },
  {
    table: 'entitlements',
    constraint: 'UNIQUE (artwork_id, serial_no)',
    prevents: 'シリアル番号の重複発行',
  },
  {
    table: 'mint_jobs',
    constraint: 'UNIQUE (entitlement_id)',
    prevents: '1受取権に対する複数の発行ジョブ',
  },
  {
    table: 'mint_jobs',
    constraint: 'UNIQUE (idempotency_key)',
    prevents: '外部Mint APIへの重複依頼',
  },
  {
    table: 'nft_tokens',
    constraint: 'UNIQUE (entitlement_id)',
    prevents: '1受取権からの複数Mint（必須要件）',
  },
  {
    table: 'nft_tokens',
    constraint: 'UNIQUE (chain_ref, contract_ref, token_ref)',
    prevents: '同一トークンの二重登録',
  },
  {
    table: 'artworks',
    constraint: 'CHECK (reserved_count + issued_count <= max_supply)',
    prevents: 'オーバーセル',
  },
];
