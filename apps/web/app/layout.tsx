import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { resolveSiteName, SITE_COPY } from '../src/site';

export const metadata: Metadata = {
  title: SITE_COPY.fallbackSiteName,
  description: SITE_COPY.tagline,
};

/**
 * スマートフォンでの表示設定。
 *
 * `maximumScale` を制限しないのは、文字を大きくして読む利用者の
 * 拡大操作を妨げないため（40代以上を主な想定利用者としている）。
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <a href="#main" className="sengoku-skip-link">
          本文へ移動
        </a>
        <main id="main">{children}</main>
        <footer>
          <small>{resolveSiteName(undefined)}</small>
        </footer>
      </body>
    </html>
  );
}
