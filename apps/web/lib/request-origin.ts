/**
 * Public origin of the current request, for server-side text that must reference
 * the instance from OUTSIDE (e.g. the cold-agent upgrade prompt's health re-check).
 *
 * Trusts the first `x-forwarded-proto` / `x-forwarded-host` hop (same rule as
 * `isCookieSecure`: Cloudflare Tunnel / reverse proxies terminate TLS and forward
 * the client-facing values; `request.nextUrl` would give the INTERNAL origin).
 * Anything unrecognized falls back to the plain-http Host header, then to the
 * compose default — a wrong origin in the prompt is annoying, an injected one
 * (`Host: http://evil.com`) is dangerous, so host values are validated.
 */
export const DEFAULT_LOCAL_ORIGIN = "http://localhost:3300";

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:(\d{1,5}))?$/i;

export function resolveRequestOrigin(headers: {
  get(name: string): string | null;
}): string {
  const protoRaw = headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase()
    .replace(/:$/, "");
  const proto = protoRaw === "https" ? "https" : "http";
  const hostRaw = (
    headers.get("x-forwarded-host")?.split(",")[0] ?? headers.get("host")
  )?.trim();
  const match = hostRaw ? HOST_RE.exec(hostRaw) : null;
  if (match) {
    // 端口还得落在合法区间：\d{1,5} 本身放行 :0 和 :99999，那种 origin 会被
    // 原样写进升级提示词，让冷启动的 agent 去连一个不存在的地址。
    const port = match[3];
    if (port !== undefined) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_LOCAL_ORIGIN;
    }
    return `${proto}://${hostRaw}`;
  }
  return DEFAULT_LOCAL_ORIGIN;
}
