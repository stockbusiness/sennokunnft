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
  phaseNotice: 'ただいま作品のご紹介のみ公開しています。お申し込み機能は準備中です。',
  emptyCatalogTitle: '販売中の作品はまだありません',
  emptyCatalogHint: '販売が始まりましたらこちらに表示されます。',
  catalogUnavailableTitle: 'ただいま作品を表示できません',
  catalogUnavailableHint: 'しばらくしてからもう一度お試しください。',
  notFoundTitle: 'お探しの作品は見つかりませんでした',
  notFoundHint: '販売が終了しているか、URL が変更された可能性があります。',
  backToCatalog: '作品一覧へ戻る',
  purchaseComingSoon: 'お申し込み機能は準備中です。',
  catalogTitle: '作品一覧',
  supplyLabel: 'お求めいただける数',
  priceLabel: '価格',
  perOrderLabel: 'お一人あたり',
  priceUnset: '価格は準備中です',
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
