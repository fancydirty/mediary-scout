/**
 * Runtime validation for the 天翼 QR session that round-trips through the browser
 * between /api/tianyi/qrcode/{status,confirm}. The session's `cookies` jar is
 * assembled into an outbound `Cookie` header by TianyiQrLoginClient, so a malformed
 * client body (CR/LF/`;` in a cookie, an oversized jar) must be rejected at the
 * route boundary — header-injection and payload-amplification are real regardless
 * of the self-hosted auth in front. Pure + unit-tested; the routes 400 on failure.
 */

/** Cookie name/value must not carry HTTP header separators/injectors. */
const HEADER_UNSAFE = /[\r\n]/;
const MAX_COOKIES = 64;
const MAX_FIELD_LEN = 8192;
const MAX_REDIRECT_URL_LEN = 2048;
/** Non-empty string fields the poll/exchange actually send. */
const REQUIRED_STRING_FIELDS = ["uuid", "paramId", "reqId", "lt"] as const;

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateTianyiQrSession(session: unknown): ValidationResult {
  if (typeof session !== "object" || session === null || Array.isArray(session)) {
    return { ok: false, error: "session must be an object" };
  }
  const s = session as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = s[field];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LEN) {
      return { ok: false, error: `session.${field} must be a non-empty string` };
    }
  }
  const cookies = s["cookies"];
  if (!Array.isArray(cookies)) {
    return { ok: false, error: "session.cookies must be an array" };
  }
  if (cookies.length > MAX_COOKIES) {
    return { ok: false, error: "session.cookies has too many entries" };
  }
  for (const pair of cookies) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      return { ok: false, error: "session.cookies must be [name, value] string pairs" };
    }
    const [name, value] = pair;
    if (name.length > MAX_FIELD_LEN || value.length > MAX_FIELD_LEN) {
      return { ok: false, error: "cookie name/value too long" };
    }
    if (HEADER_UNSAFE.test(name) || HEADER_UNSAFE.test(value) || name.includes(";") || value.includes(";")) {
      return { ok: false, error: "cookie name/value contains illegal characters (CR/LF/;)" };
    }
  }
  return { ok: true };
}

/**
 * `redirectUrl` becomes a query PARAM value on a request to the fixed host
 * api.cloud.189.cn (the server never fetches it), so this is not an SSRF vector —
 * validating https + a length cap is sufficient. A strict host allowlist is
 * deliberately NOT enforced: the exact set of 天翼 login-redirect hosts isn't fully
 * enumerated and over-restricting would break a valid login for bounded upside.
 */
export function validateTianyiRedirectUrl(redirectUrl: unknown): ValidationResult {
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) {
    return { ok: false, error: "redirectUrl must be a non-empty string" };
  }
  if (redirectUrl.length > MAX_REDIRECT_URL_LEN) {
    return { ok: false, error: "redirectUrl too long" };
  }
  if (!redirectUrl.startsWith("https://")) {
    return { ok: false, error: "redirectUrl must be https" };
  }
  return { ok: true };
}
