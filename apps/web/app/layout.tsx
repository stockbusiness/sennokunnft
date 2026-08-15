import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { SiteFooter, SiteHeader } from '@sengoku/ui';
import './globals.css';
import { getWebEnv } from '../src/env';
import { resolveSiteName, SITE_COPY } from '../src/site';

/**
 * ⚠️ **サイト名は 1 か所からしか取らない。**
 *
 * 以前はタブ名とフッタだけ `site.ts` の暫定名を直に読み、見出しは
 * 環境変数から読んでいた。環境変数側にも暫定名の既定値が置かれていたため、
 * **同じ画面に 2 つの製品名が同時に出ていた**。落ちも警告も出ないので、
 * 見た人が「どちらが正しいのか」と迷うまで誰も気づけない。
 *
 * 名前が要る場所はすべて `resolveSiteName` を通す。`UD-101` が決まったら、
 * `site.ts` の 1 行か `NEXT_PUBLIC_SITE_NAME` の設定だけで全体が揃う。
 */
function siteName(): string {
  return resolveSiteName(getWebEnv().NEXT_PUBLIC_SITE_NAME);
}

export function generateMetadata(): Metadata {
  return { title: siteName(), description: SITE_COPY.tagline };
}

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
  const name = siteName();
  return (
    <html lang="ja">
      <body>
        <a href="#main" className="sengoku-skip-link">
          本文へ移動
        </a>
        {/*
          ⚠️ 行き先の無い項目を並べない。
          「このサイトについて」「お問い合わせ」「特定商取引法に基づく表記」は
          用意でき次第ここへ足す。押せるのに何も無いページへ着くと、
          利用者は自分の操作を疑う。
        */}
        <SiteHeader siteName={name} />
        <main id="main">{children}</main>
        <SiteFooter siteName={name} />
      </body>
    </html>
  );
}
