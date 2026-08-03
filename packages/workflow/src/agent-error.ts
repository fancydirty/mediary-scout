/**
 * User-facing error mapping for the acquisition agent's LLM layer.
 *
 * The live acquisition agent is truly BYO (issue #49): it drives an
 * OpenAI-compatible model the self-hoster configures (Settings → AI 模型 / env).
 * There is no built-in author endpoint, so a real auth failure at runtime is a
 * problem with the user's OWN key/permissions — which previously surfaced verbatim
 * as a raw HTTP 401 ("Unauthorized") in the failure notification with zero
 * guidance.
 *
 * `describeAgentRunError` maps an LLM auth/401 failure onto an actionable,
 * provider-agnostic Chinese message; every other error passes through unchanged so
 * "no coverage" / transfer failures read exactly as before. It does NOT touch the
 * original error — logs keep the raw detail.
 */

/** The actionable, model-agnostic message shown when the agent's LLM call fails auth. */
export const LLM_AUTH_GUIDANCE =
  "AI 模型鉴权失败(401):请到 设置 → AI 模型 检查 API Key 是否有效、模型是否有权限(任意 OpenAI 兼容服务,自带 key)。";

/**
 * Shown when the agent's LLM calls exhaust the AI SDK's retries on 429.
 *
 * issue #229 的真实现场:用户看到「Failed after 3 attempts. Last error: Too Many
 * Requests」,而且**多个网盘任务同时报同一句** —— 因为 429 不是网盘返回的,是它们
 * 共同上游(agent 调用的 LLM)返回的。AI SDK 把 429 当可重试错误(默认 maxRetries:
 * 2 → 共 3 次尝试),全失败后抛 RetryError,那句英文就是它的 message。
 *
 * 原样透传的代价:用户以为网盘坏了或本程序坏了(他因此提了 issue),而真正该做的是
 * 换一个额度充足的模型渠道或稍后重试。所以这条指引必须明确「与网盘和本程序无关」。
 */
export const LLM_RATE_LIMIT_GUIDANCE =
  "AI 模型被限流(429):你配置的模型渠道正在限流或额度已用尽 —— 与网盘和本程序无关。请稍后重试,或到 设置 → AI 模型 换一个额度充足的渠道(免费额度的模型很容易触发)。";

// LLM-SPECIFIC auth markers (case-insensitive). Deliberately NOT the bare numeric
// "401"/"403" substrings — those over-match netdisk (brand) auth errors whose
// messages carry the status number (e.g. "GUANGYA_AUTH_FAILED: 401 after refresh")
// and would be misreported as an AI-模型 problem (Copilot #51 C3). These words are
// what an OpenAI-compatible endpoint actually returns on a key/permission failure.
const LLM_AUTH_PATTERNS = [
  "unauthorized",
  "forbidden",
  "invalid api key",
  "invalid_api_key",
  "incorrect api key",
  "authentication",
];

// LLM rate-limit markers (case-insensitive). Same discipline as LLM_AUTH_PATTERNS:
// no bare "429" substring — a netdisk message can carry that number and would be
// misreported as an AI-模型 problem. These are what OpenAI-compatible endpoints
// (and the AI SDK's RetryError wrapper) actually say when throttled.
const LLM_RATE_LIMIT_PATTERNS = [
  "too many requests",
  "rate limit",
  "rate_limit",
  "quota exceeded",
  "resource_exhausted",
  "requests per minute",
  "insufficient_quota",
];

// Netdisk (storage brand) auth errors are a TOKEN problem with the user's drive,
// not the AI model. They are thrown as Pan115AuthError / QuarkAuthError /
// GuangYaAuthError / TianyiAuthError / Pan123AuthError with these message prefixes
// (and class names). If any of these markers is present anywhere in the error (or
// its cause chain), it is NEVER an LLM-auth error — even if it carries a 401/403
// statusCode or the word in its text.
// Netdisk-side markers that must SHORT-CIRCUIT the LLM rate-limit mapping.
//
// 两类:
//  1. 中文限流提示(115「请求过于频繁」/夸克「访问频繁」)——网盘侧限流;
//  2. **转存/网盘动作前缀**——探针实测:网盘网关也会返回英文「Too Many Requests」
//     (例如 "转存失败: Too Many Requests"),只匹配英文 429 文案会把它误判成
//     「换 LLM 渠道」,把用户引向完全错误的方向(与 BRAND_AUTH_MARKERS 同款教训)。
const BRAND_RATE_LIMIT_MARKERS = [
  "频繁",
  "访问过快",
  "操作过于频繁",
  "转存",
  "transfer_failed",
  "transfer failed",
  "分享",
  "share link",
];

const BRAND_AUTH_MARKERS = [
  "guangya",
  "quark",
  "pan115",
  "tianyi",
  "pan123",
  "pan115autherror",
  "quarkautherror",
  "guangyaautherror",
  "tianyiautherror",
  "pan123autherror",
];

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  return "";
}

function statusCodeOf(error: unknown): number | undefined {
  if (error !== null && typeof error === "object") {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") {
      return code;
    }
  }
  return undefined;
}

/** True if this error (one node, name+message) is a netdisk brand auth error —
 *  which must NEVER be reported as an AI-模型 auth failure. */
function isBrandAuthError(error: unknown): boolean {
  const msg = messageOf(error);
  return BRAND_AUTH_MARKERS.some((marker) => msg.includes(marker));
}

/**
 * True if `error` (or anything in its `cause` chain — the AI SDK wraps the real
 * error) is an LLM authentication failure: an AI-SDK APICallError with a 401/403
 * statusCode, OR a message matching an LLM-specific auth marker. A netdisk (brand)
 * auth error short-circuits to false — even with a 401 statusCode — so a drive
 * token problem is never mislabeled an AI-模型 problem. Recursion-bounded.
 */
export function isLlmAuthError(error: unknown, depth = 0): boolean {
  if (error === null || error === undefined || depth > 5) {
    return false;
  }
  // A brand auth error anywhere short-circuits: NOT an LLM-auth error.
  if (isBrandAuthError(error)) {
    return false;
  }
  const status = statusCodeOf(error);
  if (status === 401 || status === 403) {
    return true;
  }
  const msg = messageOf(error);
  if (LLM_AUTH_PATTERNS.some((pattern) => msg.includes(pattern))) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isLlmAuthError(cause, depth + 1);
}

/** True if this error is a netdisk brand error (auth OR rate limit) — those must
 *  never be reported as an AI-模型 problem. */
function isBrandError(error: unknown): boolean {
  const msg = messageOf(error);
  return (
    BRAND_AUTH_MARKERS.some((marker) => msg.includes(marker)) ||
    BRAND_RATE_LIMIT_MARKERS.some((marker) => msg.includes(marker))
  );
}

/**
 * True if `error` (or anything in its `cause` chain — the AI SDK wraps the real
 * error) is an LLM rate-limit failure: a 429 statusCode, or a message matching a
 * throttling marker (including the AI SDK's own "Failed after N attempts. Last
 * error: Too Many Requests"). A netdisk (brand) error short-circuits to false —
 * even with a 429 statusCode — so a drive throttle is never mislabeled an
 * AI-模型 problem. Recursion-bounded.
 */
export function isLlmRateLimitError(error: unknown, depth = 0): boolean {
  if (error === null || error === undefined || depth > 5) {
    return false;
  }
  // A netdisk error anywhere short-circuits: NOT an LLM rate-limit error.
  if (isBrandError(error)) {
    return false;
  }
  if (statusCodeOf(error) === 429) {
    return true;
  }
  const msg = messageOf(error);
  if (LLM_RATE_LIMIT_PATTERNS.some((pattern) => msg.includes(pattern))) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isLlmRateLimitError(cause, depth + 1);
}

/**
 * Map a captured agent-run error to a USER-FACING message. LLM auth/401 and
 * rate-limit/429 failures become actionable, provider-agnostic guidance; every
 * other error keeps its original message. Does NOT touch the original error —
 * logs keep the raw detail.
 */
export function describeAgentRunError(error: unknown): string {
  if (isLlmAuthError(error)) {
    return LLM_AUTH_GUIDANCE;
  }
  if (isLlmRateLimitError(error)) {
    return LLM_RATE_LIMIT_GUIDANCE;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Workflow failed";
}

/** Max length of the error summary appended to a retry notification. Long enough
 *  to carry a provider message ("夸克登录超时"/"分享已取消"/"访问频繁"…), short
 *  enough for a push/card line. */
const NOTIFY_SUMMARY_MAX = 140;

/**
 * A SHORT, SECRET-SAFE one-line summary of an error message, for surfacing the
 * real cause in a *retry* notification (previously hidden behind "网络波动").
 *
 * Notifications are user-visible (in-app card + Bark/Server酱/企微 push), and a
 * raw drive error can carry a cookie/token/query-credential. This collapses
 * whitespace, redacts obvious secret material, then truncates — so the user sees
 * WHY it is retrying without us leaking their credentials into a push channel.
 *
 * Order matters: redact BEFORE truncating (never truncate a secret in half and
 * leak the prefix). The raw error is untouched — logs + auditEvents keep full
 * detail for our own diagnosis.
 */
export function summarizeErrorForNotification(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  // URL userinfo credentials: scheme://user:pass@host → scheme://***@host
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***@");
  // key/token/cookie/password style assignments: name=<value> → name=***
  // (covers cookie=, token=, api_key=, access_token=, pwd=, stoken=, __puus=, sid=…)
  s = s.replace(
    /([A-Za-z_][A-Za-z0-9_-]*(?:key|token|cookie|secret|pass(?:word|wd)?|sign|stoken|puus|sid))\s*[=:]\s*[^\s,;&"']{6,}/gi,
    "$1=***",
  );
  // Bare long opaque secrets (>=32 chars of base64url/hex-ish, no spaces) → ***
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, "***");
  if (s.length > NOTIFY_SUMMARY_MAX) {
    s = `${s.slice(0, NOTIFY_SUMMARY_MAX - 1)}…`;
  }
  return s;
}
