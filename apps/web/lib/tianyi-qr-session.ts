/**
 * Runtime validation for the 天翼 QR session that round-trips through the browser
 * between /api/tianyi/qrcode/{status,confirm}. The session's `cookies` jar is
 * assembled into an outbound `Cookie` header by TianyiQrLoginClient, so a malformed
 * client body (CR/LF/`;` in a cookie, an oversized jar) must be rejected at the
 * route boundary — header-injection and payload-amplification are real regardless
 * of the self-hosted auth in front. Pure + unit-tested; the routes 400 on failure.
 */

/** RFC 6265 cookie-name = token (no controls, separators, whitespace, `=`, or `;`). */
const COOKIE_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Caps chosen so a real 天翼 jar (a handful of cookies, each well under 1KB, a few
// hundred bytes serialized) always passes, while an amplified jar cannot: the
// SERIALIZED total is the real guard (client joins the jar into one Cookie header),
// with per-cookie + count caps as cheap early rejects.
const MAX_COOKIES = 32;
const MAX_COOKIE_NAME_LEN = 256;
const MAX_COOKIE_VALUE_LEN = 4096;
/** Cap on the whole `k=v; k=v` header the client builds (blocks DoS amplification). */
const MAX_SERIALIZED_COOKIE_LEN = 16384;
const MAX_STRING_FIELD_LEN = 4096;
const MAX_REDIRECT_URL_LEN = 2048;
/** Non-empty string fields pollStatus/exchangeSession actually send (form/headers).
 *  Validating all of them turns a malformed body into a 400, not a misleading 502. */
const REQUIRED_STRING_FIELDS = [
  "uuid",
  "encryuuid",
  "paramId",
  "reqId",
  "lt",
  "appId",
  "clientType",
  "returnUrl",
] as const;

/** A cookie value must carry no control chars (CR/LF etc.) or `;` — either would
 *  corrupt the joined Cookie header. Char-code scan avoids a control-char regex. */
function cookieValueHasIllegalChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x3b /* ; */) {
      return true;
    }
  }
  return false;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateTianyiQrSession(session: unknown): ValidationResult {
  if (typeof session !== "object" || session === null || Array.isArray(session)) {
    return { ok: false, error: "session must be an object" };
  }
  const s = session as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = s[field];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_FIELD_LEN) {
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
  let serializedLength = 0;
  for (const pair of cookies) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      return { ok: false, error: "session.cookies must be [name, value] string pairs" };
    }
    const [name, value] = pair;
    if (name.length === 0 || name.length > MAX_COOKIE_NAME_LEN || !COOKIE_NAME_TOKEN.test(name)) {
      return { ok: false, error: "cookie name must be a non-empty RFC6265 token (no space/=/;/controls)" };
    }
    if (value.length > MAX_COOKIE_VALUE_LEN || cookieValueHasIllegalChar(value)) {
      return { ok: false, error: "cookie value too long or contains illegal characters (CR/LF/;)" };
    }
    serializedLength += name.length + value.length + 3; // "name=value; "
  }
  if (serializedLength > MAX_SERIALIZED_COOKIE_LEN) {
    return { ok: false, error: "session.cookies serialized header too large" };
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
