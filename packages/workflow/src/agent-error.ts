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

// Message substrings that indicate an LLM authentication failure (case-insensitive).
const AUTH_PATTERNS = [
  "unauthorized",
  "401",
  "forbidden",
  "403",
  "invalid api key",
  "invalid_api_key",
  "authentication",
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

/**
 * True if `error` (or anything in its `cause` chain — the AI SDK wraps the real
 * error) is an LLM authentication failure: a 401/403 status code (e.g. an AI-SDK
 * APICallError), or a message matching a known auth pattern. Recursion-bounded.
 */
export function isLlmAuthError(error: unknown, depth = 0): boolean {
  if (error === null || error === undefined || depth > 5) {
    return false;
  }
  const status = statusCodeOf(error);
  if (status === 401 || status === 403) {
    return true;
  }
  const msg = messageOf(error);
  if (AUTH_PATTERNS.some((pattern) => msg.includes(pattern))) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isLlmAuthError(cause, depth + 1);
}

/**
 * Map a captured agent-run error to a USER-FACING message. LLM auth/401 failures
 * become actionable, provider-agnostic guidance; every other error keeps its
 * original message. Does NOT touch the original error — logs keep the raw detail.
 */
export function describeAgentRunError(error: unknown): string {
  if (isLlmAuthError(error)) {
    return LLM_AUTH_GUIDANCE;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Workflow failed";
}
