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

/**
 * 首页 hero 海报墙的图片来源(TMDB 代理,与主站同一个)。
 * 单独成常量:CSP 里出现的每个外部来源都该有名有姓、可被搜索到。
 */
export const POSTER_IMG_SOURCE = "https://tmdb-proxy.mediaryscout.app";

export function htmlPage(
  body: string,
  opts: {
    status?: number;
    noStore?: boolean;
    posters?: boolean;
    alipayForm?: true | "sandbox";
  } = {},
): Response {
  const status = opts.status ?? 200;
  // 首页 hero 的海报墙走 TMDB 图片代理(跨域)。**只给首页放行这一个来源** ——
  // 默认 img-src 只有 'self' data:,加海报时漏了这条,线上 28 张图全被 CSP
  // 挡成裂图(curl 能拿到,浏览器不行 —— 这类 bug 只有真在浏览器里看才发现)。
  const posters = opts.posters === true;
  // Only the one-time same-origin checkout hop may submit a form to Alipay.
  // Chromium applies form-action across redirects. Both official gateways issue a
  // redirect through unitradeprod to excashier, so the full owned chain must be allowed.
  // The tier-selection and return pages use same-origin fetch only.
  const alipayForm = opts.alipayForm;
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline' https://challenges.cloudflare.com",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    // img-src 对**所有**页面都必需:每页都带 data: URI 的 favicon
    // (theme.ts 的 FAVICON_LINK),而 default-src 'none' 会把它挡掉。
    // 这是本次之前就存在的缺陷,先前只给 /buy 加 img-src 反而让它更显眼。
    // 'self' 供将来的同源图标;data: 不产生网络请求,不放宽攻击面。
    `img-src 'self' data:${posters ? ` ${POSTER_IMG_SOURCE}` : ""}`,
    "base-uri 'none'",
    alipayForm === "sandbox"
      ? "form-action https://openapi-sandbox.dl.alipaydev.com https://unitradeprod-sandbox.dl.alipaydev.com https://excashier-sandbox.dl.alipaydev.com"
      : alipayForm
        ? "form-action https://openapi.alipay.com https://unitradeprod.alipay.com https://excashier.alipay.com"
        : "form-action 'self'",
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
      // HSTS(SEO/安全审计 P0):真实公网复验发现 http://mediaryconnect.app/
      // 直接 200 明文响应 —— Google 会把 http:// 与 https:// 当两套地址
      // (重复内容 + 规范分裂),用户也会明文打开登录页。
      //
      // 生效边界(别高估它):浏览器**必须先通过 HTTPS 收到过这个头**才会缓存
      // 并强制后续请求走 HTTPS —— 首次就用 http:// 访问的请求依然是明文命中。
      // 要挡住首次明文,还需在 Cloudflare 开 Always Use HTTPS(见 SEO 台账待办)。
      //
      // 参数选择:max-age 两年是我们自己的保守选择,不是任何规范的门槛。
      // (hstspreload.org 的预加载门槛是 max-age ≥ 31536000 即 1 年 +
      //  includeSubDomains + preload 三者齐备。)
      // 刻意不加 preload —— 进预加载列表**不可逆**,等站点稳定运营后再单独决定。
      "strict-transport-security": "max-age=63072000; includeSubDomains",
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
