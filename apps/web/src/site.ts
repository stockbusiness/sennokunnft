/**
 * 画面に表示する文言。
 *
 * ⚠️ 文言をハードコードせずここへ集約している理由:
 *  - 対外的なプロダクト名が未決定（UD-101）
 *  - UI 用語集が未承認（UD-103）
 *
 * どちらも決まり次第、この 1 ファイルの差し替えで反映できるようにしてある。
 */
export const SITE_COPY = {
  /** UD-101 が決まるまでの暫定名。 */
  fallbackSiteName: 'デジタル作品マーケット',
  tagline: 'デジタル作品をお求めいただけます',
  phaseNotice: '現在は開発基盤の構築段階です。作品の販売・お受け取りの機能は準備中です。',
  emptyCatalogTitle: '販売中の作品はまだありません',
  emptyCatalogHint: '販売が始まりましたらこちらに表示されます。',
} as const;

/**
 * 表示に使うサイト名を決める。
 *
 * @param configuredName 環境変数で与えられた名前
 */
export function resolveSiteName(configuredName: string | undefined): string {
  const trimmed = configuredName?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : SITE_COPY.fallbackSiteName;
}
