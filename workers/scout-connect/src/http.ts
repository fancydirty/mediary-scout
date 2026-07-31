export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json(data: unknown, status = 200, opts: { noStore?: boolean } = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(opts.noStore === true ? { "cache-control": "no-store" } : {}),
    },
  });
}

/** Paddle 结账所需的第三方来源。**只给 /buy 用**(htmlPage 的 paddle 选项),
 *  绝不进共享策略:其余页面(含带一次性 token 的开通页)不该为一个页面放宽。
 *
 *  为什么必须显式列出:共享 CSP 的 script-src 只有 'unsafe-inline' 与
 *  Turnstile CDN,注释还写着「本 worker 没有任何同源脚本资源」——/buy 引入
 *  cdn.paddle.com 打破了这个前提。不放行的后果不是降级而是**彻底收不到钱**:
 *  paddle.js 被拒 → window.Paddle undefined → 页面显示「支付组件加载失败」,
 *  Paddle 审核员点开 default payment link 看到的就是这个 → 必被拒。
 *  单元测试测不到(vitest 不执行 CSP),故此处必须真机验证。
 *
 *  frame-src/img-src 同样必需:结账 UI 是 iframe,内含卡组织与支付方式图标;
 *  connect-src 供其调用 Paddle API。img-src 若缺省会回落 default-src 'none',
 *  图标全被封,结账窗看起来像坏了。 */
const PADDLE_CSP_SOURCES = {
  script: "https://cdn.paddle.com",
  // buy.paddle.com / checkout-service.paddle.com 等子域都在结账链路上,
  // 逐个枚举会随 Paddle 改版而漏,故按通配子域放行(仍限定在 paddle.com)。
  frame: "https://*.paddle.com https://cdn.paddle.com",
  connect: "https://*.paddle.com https://cdn.paddle.com",
  img: "https://*.paddle.com https://cdn.paddle.com",
  style: "https://cdn.paddle.com",
} as const;

/**
 * 首页 hero 海报墙的图片来源(TMDB 代理,与主站同一个)。
 * 单独成常量:CSP 里出现的每个外部来源都该有名有姓、可被搜索到。
 */
export const POSTER_IMG_SOURCE = "https://tmdb-proxy.mediaryscout.app";

export function htmlPage(
  body: string,
  opts: { status?: number; noStore?: boolean; paddle?: boolean; posters?: boolean } = {},
): Response {
  const status = opts.status ?? 200;
  // /buy 才放行 Paddle 来源;其余页面维持最严策略。
  const p = opts.paddle === true;
  // 首页 hero 的海报墙走 TMDB 图片代理(跨域)。**只给首页放行这一个来源** ——
  // 默认 img-src 只有 'self' data:,加海报时漏了这条,线上 28 张图全被 CSP
  // 挡成裂图(curl 能拿到,浏览器不行 —— 这类 bug 只有真在浏览器里看才发现)。
  const posters = opts.posters === true;
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline'${p ? ` ${PADDLE_CSP_SOURCES.style}` : ""}`,
    `script-src 'unsafe-inline' https://challenges.cloudflare.com${p ? ` ${PADDLE_CSP_SOURCES.script}` : ""}`,
    `connect-src 'self' https://challenges.cloudflare.com${p ? ` ${PADDLE_CSP_SOURCES.connect}` : ""}`,
    `frame-src https://challenges.cloudflare.com${p ? ` ${PADDLE_CSP_SOURCES.frame}` : ""}`,
    // img-src 对**所有**页面都必需:每页都带 data: URI 的 favicon
    // (theme.ts 的 FAVICON_LINK),而 default-src 'none' 会把它挡掉。
    // 这是本次之前就存在的缺陷,先前只给 /buy 加 img-src 反而让它更显眼。
    // 'self' 供将来的同源图标;data: 不产生网络请求,不放宽攻击面。
    `img-src 'self' data:${p ? ` ${PADDLE_CSP_SOURCES.img}` : ""}${posters ? ` ${POSTER_IMG_SOURCE}` : ""}`,
    "base-uri 'none'",
    "form-action 'self'",
    // 结账 iframe 由 paddle.js 在**本页**创建,不需要放宽 frame-ancestors
    // (那是"谁能嵌入本页"),保持 'none'。
    "frame-ancestors 'none'",
  ].join("; ");
  const headers: Record<string, string> = {
      "content-type": "text/html; charset=utf-8",
      // Pages carry inline style/script only — no first-party asset requests —
      // so a strict CSP is free defense-in-depth for a page that carries a
      // one-time token. The ONE third-party source is conditional: the beta
      // page's Turnstile widget (allowlisted below).
      // connect-src 'self' is load-bearing, not decorative: every page's
      // inline script POSTs same-origin (invite reveal, admin console, beta
      // signup), and connect-src falls back to default-src when absent —
      // 'none' made the browser refuse those fetches outright (verified
      // empirically: "Failed to fetch" without the directive, 200 with it).
      // challenges.cloudflare.com (script/frame/connect) is the beta page's
      // Turnstile widget. On the shared policy for all pages — htmlPage() is
      // shared, per-page CSP would only invite drift.
      // script-src 刻意不含 'self'：本 worker 的每个 <script> 要么内联、要么
      // 是上面那个 Turnstile CDN 地址，没有任何同源脚本资源。加了不解决问题，
      // 只是白白放宽（connect-src 'self' 是另一回事，那条是 fetch 用的）。
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      // frame-ancestors only works as a CSP directive (above); x-frame-options
      // is the legacy header that actually blocks framing in older browsers.
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
  };
  if (opts.noStore) headers["cache-control"] = "no-store";
  return new Response(body, { status, headers });
}

// SECURITY: never leak stack traces or internal error text to the client —
// only an HttpError's own deliberate message is exposed.
export function handleError(e: unknown): Response {
  if (e instanceof HttpError) {
    return json({ error: e.message }, e.status);
  }
  console.error("unhandled route error", e);
  return json({ error: "internal" }, 500);
}
