import { sha256Hex } from "./crypto-token.js";
import { parseSessionCookie } from "./session.js";

/** The narrow DB surface needed by bearer authentication. */
export interface AccountAuthDb {
  getActiveInstanceCredentialBySha(sha: string): Promise<ActiveInstanceCredential | null>;
  touchInstanceCredential(id: string, nowIso: string): Promise<void>;
}

export interface ActiveInstanceCredential {
  id: string;
  account_id: string;
  revoked_at?: string | null;
}

export interface AccountAuthDeps {
  db: AccountAuthDb;
  sessionSecret: string;
  now: () => string;
}

export type ResolvedAccount =
  | { ok: true; accountId: string; via: "bearer" | "cookie" }
  | { ok: false };

/**
 * Resolve the account attached to a request.
 *
 * A present Authorization header is authoritative: malformed, unknown, or
 * revoked bearer credentials never fall back to an ambient session cookie.
 * Cookie parsing remains the existing signed login-token path when no header
 * is present. Updating credential usage is deliberately best effort so a
 * telemetry write cannot turn an otherwise valid request into a failure.
 */
/** The instance credential in an `Authorization` value, or null. The scheme is case-insensitive. */
export function instanceCredentialFromAuthorization(value: string): string | null {
  const match = /^bearer\s+(\S+)$/i.exec(value.trim());
  const credential = match?.[1] ?? "";
  return /^ic_[A-Za-z0-9_-]{43,}$/.test(credential) ? credential : null;
}

export async function resolveAccount(
  request: Request,
  deps: AccountAuthDeps,
): Promise<ResolvedAccount> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const credential = instanceCredentialFromAuthorization(authorization);
    if (credential === null) return { ok: false };
    const credentialSha = await sha256Hex(credential);
    const row = await deps.db.getActiveInstanceCredentialBySha(credentialSha);
    if (row === null || row.revoked_at != null) return { ok: false };
    try {
      await deps.db.touchInstanceCredential(row.id, deps.now());
    } catch {
      // Usage timestamps are observability only; preserve the authenticated
      // request if the best-effort write is unavailable.
    }
    return { ok: true, accountId: row.account_id, via: "bearer" };
  }

  const nowMs = Date.parse(deps.now());
  if (!Number.isFinite(nowMs)) throw new Error("server time unavailable");
  const session = await parseSessionCookie(request.headers.get("cookie"), {
    secret: deps.sessionSecret,
    now: nowMs,
  });
  return session.ok
    ? { ok: true, accountId: session.accountId, via: "cookie" }
    : { ok: false };
}
