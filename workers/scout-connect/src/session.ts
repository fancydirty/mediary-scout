import { signToken, verifyToken } from "./signed-token.js";

/**
 * 登录态 Cookie。值就是一个 purpose="login" 的 signed-token,subject=accountId。
 * 复用 signed-token 的 HMAC + 过期,不落库(与魔法链接同一套机制)。
 */

export const SESSION_COOKIE = "mc_session";

export interface BuildSessionOptions {
  secret: string;
  ttlMs: number;
  now?: number;
}

/** 生成 Set-Cookie 头。HttpOnly + Secure + SameSite=Lax:
 *  远程门禁靠这个 cookie,必须挡住 XSS 读取(HttpOnly)与跨站携带(Lax)。 */
export async function buildSessionCookie(
  accountId: string,
  opts: BuildSessionOptions,
): Promise<string> {
  const token = await signToken(
    { purpose: "login", subject: accountId },
    { key: opts.secret, ttlMs: opts.ttlMs, now: opts.now },
  );
  const maxAgeSec = Math.floor(opts.ttlMs / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** 从一个 Set-Cookie 字符串里取出 cookie 值(测试与内部用)。 */
export function sessionCookieValue(setCookie: string): string {
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
  return m?.[1] ?? "";
}

export interface ParseSessionOptions {
  secret: string;
  now?: number;
}

export type SessionResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "absent" | "invalid" };

export async function parseSessionCookie(
  cookieHeader: string | null,
  opts: ParseSessionOptions,
): Promise<SessionResult> {
  if (cookieHeader === null) return { ok: false, reason: "absent" };
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader);
  if (m === null) return { ok: false, reason: "absent" };
  const result = await verifyToken(m[1]!, {
    key: opts.secret,
    now: opts.now,
    expectPurpose: "login",
  });
  if (!result.ok) return { ok: false, reason: "invalid" };
  return { ok: true, accountId: result.subject };
}
