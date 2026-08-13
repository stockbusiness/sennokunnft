import { NextResponse } from 'next/server';

/**
 * web プロセス自身のヘルスチェック。
 *
 * ⚠️ ここで API プロセスの状態を確認しない。
 * 依存先の障害で web まで unhealthy になると、
 * 「一部機能は使えないが画面は出る」という縮退運転ができなくなる。
 */
export function GET() {
  return NextResponse.json({ status: 'ok', service: 'web' });
}
