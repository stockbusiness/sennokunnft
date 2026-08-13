/**
 * ログ出力時の秘匿値マスキング。
 *
 * ✅ 要件「ログへトークン、秘密鍵、個人情報を出さない」を、
 * 規律ではなく**仕組み**で守るための機構（SECURITY_DESIGN.md §4）。
 *
 * 方針:
 *  - キー名のパターン一致で判定する（値の中身は見ない）
 *  - 入れ子・配列も再帰的に処理する
 *  - **常時有効**。環境によって緩めない（設定ミスで本番に適用される事故を防ぐ）
 */
export const REDACTED = '[REDACTED]';

/**
 * 秘匿すべきキー名のパターン。部分一致・大文字小文字を無視して判定する。
 *
 * 過剰に隠すことによる調査性の低下より、漏洩の方が損害が大きいため、
 * 迷った場合は隠す側に倒している。
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  // 資格情報・秘密
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'accesskey',
  'privatekey',
  'private_key',
  'credential',
  'authorization',
  'cookie',
  'session',
  'signature',
  'mnemonic',
  'seedphrase',
  // 受取権（Claim）
  'claimtoken',
  'claim_token',
  // 個人情報
  'email',
  'phone',
  'tel',
  'address',
  'postalcode',
  'zip',
  'birth',
  'card',
  'cardnumber',
  'cvv',
  'iban',
  // 接続情報（資格情報を含みうる）
  'databaseurl',
  'database_url',
  'connectionstring',
];

/** 深すぎる構造を延々と辿らないための上限。循環参照の保険も兼ねる。 */
const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) =>
    normalized.includes(pattern.replace(/[-_]/g, '')),
  );
}

/**
 * 値を再帰的に走査し、秘匿すべきキーの値を伏せる。
 *
 * 入力は変更しない（新しいオブジェクトを返す）。
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    // スタックトレースには内部パスが含まれるため、名前とメッセージのみ残す。
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return result;
}
