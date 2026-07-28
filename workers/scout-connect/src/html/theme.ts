// 深色 + 品牌绿设计系统——beta-page 是视觉源头,这里把它抽成登录/控制台/
// 合规页共用的令牌与零件,让四张页面读起来是同一个产品家族(mediaryscout.app)。
//
// 只导出「片段」(CSS 变量块、logo、brand bar、favicon link),不导出整页模板:
// 每张页面的骨架差异大,强行统一反而僵硬。共享的是令牌与像素级的品牌一致性。

/** HTML 属性/文本转义。四张页面共用一份,避免各自重抄跑偏。 */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

// 光圈标记——与 apps/web/app/icon.svg、beta-page、mediaryscout.app 导航同一枚,
// 内联以保持页面自包含(零外部请求,CSP 友好)。favicon 直接复用它。
export const LOGO_SVG =
  '<svg width="28" height="28" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mediary Scout"><circle cx="16" cy="16" r="16" fill="#1ED760"/><g transform="translate(4,4)" fill="none" stroke="#0B3B1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="m16.62 12-5.74 9.94"/></g></svg>';

/** favicon 用的独立 SVG(带 xmlns,可作为 /favicon.svg 独立文档返回)。
 *  apex 与 beta 之前都 404,现在四张页面 <link rel=icon> 都指向它。 */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#1ED760"/><g transform="translate(4,4)" fill="none" stroke="#0B3B1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="m16.62 12-5.74 9.94"/></g></svg>';

/** 每张页面 <head> 里放的 favicon 链接。data: URI 内联,免一次请求也免路由。 */
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

/** 设计令牌——beta-page 的 :root 原样抽出,四张页面共享同一套深色绿。 */
export const THEME_TOKENS =
  ':root{--bg-base:#121212;--bg-surface:#181818;--bg-raised:#1f1f1f;--bg-card:#252525;--accent:#1ed760;--accent-press:#169c46;--text:#fff;--text-muted:#b3b3b3;--text-zh:#9a9a9a;--border:#4d4d4d;--border-outline:#7c7c7c;--err:#f3727f;--hairline:linear-gradient(90deg,transparent,#2c2c2c 25%,#2c2c2c 75%,transparent);--font:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,SFMono-Regular,monospace;color-scheme:dark}';

/** body 基底 + 顶部径向绿光,与 beta-page 的 #hero 渐变一致。 */
export const THEME_BASE =
  '*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:var(--font);color:var(--text);line-height:1.65;background:var(--bg-base)}body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(120% 90% at 50% -20%,rgba(30,215,96,.18),rgba(30,215,96,.04) 42%,var(--bg-base) 75%)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}';

/** 品牌条:光圈标记 + 字标 + CONNECT 药丸。四张页面顶部一致。 */
export const BRAND_BAR = `<header class="brand">${LOGO_SVG}<span class="wordmark">Mediary Scout</span><span class="connect-tag">CONNECT</span></header>`;

/** 品牌条 + 页脚链接的共享 CSS(令牌之外,零件级复用)。 */
export const BRAND_CSS =
  '.brand{display:flex;align-items:center;gap:10px;padding:0 0 4px}.brand svg{display:block;flex:none}.wordmark{font-weight:700;font-size:15px;letter-spacing:.01em}.connect-tag{font-family:var(--mono);font-size:10.5px;letter-spacing:1px;color:var(--accent);border:1px solid rgba(30,215,96,.35);border-radius:999px;padding:3px 9px}';
