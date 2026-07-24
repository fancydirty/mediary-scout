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
      // Pages are fully self-contained (inline style/script only), so a strict
      // CSP is free defense-in-depth for a page that carries a one-time token.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
