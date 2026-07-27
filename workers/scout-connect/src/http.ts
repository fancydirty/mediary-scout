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

export function htmlPage(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
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
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      // frame-ancestors only works as a CSP directive (above); x-frame-options
      // is the legacy header that actually blocks framing in older browsers.
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
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
