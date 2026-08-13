import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { resolveSiteName, SITE_COPY } from '../src/site';

export const metadata: Metadata = {
  title: SITE_COPY.fallbackSiteName,
  description: SITE_COPY.tagline,
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
