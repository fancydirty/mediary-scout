const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Cloudflare tunnel id in canonical form (trimmed, lower-case UUID), or null. */
export function normalizeTunnelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

/**
 * The tunnel a cloudflared token belongs to. The token is base64 of {"a": account tag,
 * "t": tunnel id, "s": secret}; only the id is read. Null when it does not look like one.
 */
export function tunnelIdFromToken(token: string | null | undefined): string | null {
  const raw = token?.trim();
  if (!raw || !/^[A-Za-z0-9+/=_-]+$/.test(raw)) return null;
  try {
    const json = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return null;
    const id = (value as { t?: unknown }).t;
    return normalizeTunnelId(id);
  } catch {
    return null;
  }
}
