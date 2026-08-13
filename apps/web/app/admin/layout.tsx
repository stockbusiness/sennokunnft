import type { ReactNode } from 'react';

/**
 * 管理画面の枠。
 *
 * ⚠️ **画面を隠すことは保護ではない。**
 * ここに認可判定を置いていないのは、置いても意味がないから。
 * 管理APIは直接叩けるので、保護はサーバー側のガードで行う。
 * この画面は「権限のある人が操作するための入口」に過ぎない。
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sengoku-admin">
      <nav className="sengoku-admin__nav" aria-label="管理メニュー">
        <a href="/admin/artworks">作品</a>
        <a href="/admin/listings">販売</a>
        <a href="/">公開ページ</a>
      </nav>
      {children}
    </div>
  );
}
