import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { isDemoMode } from "../lib/demo-mode";

export const metadata: Metadata = {
  title: "巡影 · Mediary Scout",
  description: "自建网盘的媒体获取 agent —— 搜索、转存、验证、追踪补缺。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. 沉浸式翻译) inject
    // attributes like data-immersive-translate-page-theme onto <html> before
    // React hydrates, which would otherwise flag a false hydration mismatch.
    // This suppresses ONLY this element's own attribute diff (one level) — real
    // mismatches in the tree below still surface.
    <html lang="zh-CN" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {isDemoMode() ? (
          <div className="demo-banner">
            🔭 只读演示 · 数据为示例 · 不执行真实获取 ·{" "}
            {/* 回链主站:demo 站已被 Google 索引却零回链,权重完全没回流。
                锚文本用「官网」是刻意的 —— 两站都叫 Mediary Scout,这个词
                帮搜索引擎判断哪个域名是主实体,消除实体混淆。 */}
            <a href="https://mediaryscout.app">Mediary Scout 官网</a> ·{" "}
            <a href="https://github.com/fancydirty/mediary-scout" target="_blank" rel="noreferrer">
              想真用 → GitHub 自部署
            </a>
          </div>
        ) : null}
        {children}
        {/* Vercel Web Analytics — DEMO deploy only: gated on isDemoMode() so a
            self-hosted instance never loads the Vercel insights script (no 404 /
            no third-party beacon off-Vercel). */}
        {isDemoMode() ? <Analytics /> : null}
      </body>
    </html>
  );
}
