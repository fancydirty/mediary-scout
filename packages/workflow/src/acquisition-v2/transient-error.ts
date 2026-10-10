/**
 * Conservative classifier: TRUE only for clear connectivity/transport failures
 * (DNS, TLS, socket, timeout, fetch-layer) and HTTP-level backpressure
 * (429 rate limit / 5xx service fluctuation — the free-pool Kilo spikes).
 * Everything else — "no coverage", validation, agent give-up, 404/model-not-found
 * — is FALSE so it terminates as `failed` and is NOT auto-requeued (we never
 * re-spam the queue for a genuine no-resource result, and a retired model stays
 * retired no matter how many times we retry). Recurses through the `cause`
 * chain (AI SDK / fetch wrap the real error).
 */
const TRANSIENT_PATTERNS = [
  "econnreset",
  "etimedout",
  "econnrefused",
  "enotfound",
  "eai_again",
  "epipe",
  "socket disconnected",
  "socket hang up",
  "fetch failed",
  "network socket",
  "cannot connect to api",
  "secure tls connection",
  "timeout",
  "network error",
  // ---- HTTP 限流 / 服务端波动（免费池 Kilo 高峰 429/5xx，2026-10）----
  //
  // 保守性论证：messageOf 只看 error 对象的 name+message（或裸抛的 string），
  // 分类输入是传输层抛出的错误，不是候选标题/剧情简介那类业务文本 —— 候选
  // 内容活在 tool result 和 DB 字段里，不会被 isTransientAcquisitionError 拿来
  // 匹配。这些 token（"429"/"too many requests"/"rate limit"/"500"-"504"）
  // 是 HTTP 状态码及其标准短语，只出现在 LLM/HTTP 传输层的报错消息中
  // （501 没收：Not Implemented 是服务端配置/实现问题，重试大概率原样再犯，
  // 不属于「等高峰过去就好」的波动）。残剩的误报面（业务错误文本碰巧带
  // "429"/"500"-"504" 子串，如「第 503 集」）代价有界：多吃最多 3 次
  // 1/5/15min 退避重排后仍会终止失败，不会把失败藏成永久重试。
  //
  // 注意区分：isTransientAcquisitionError 对网盘限流（如「转存失败: Too Many
  // Requests」）同样返回 true —— 那是刻意的，网盘限流也该退避重试；「这段错
  // 是不是 LLM 的」那一问由 agent-error.ts 的 brand 短路分类器负责，与本文件
  // 的「该不该重试」职责正交。
  "429",
  "too many requests",
  "rate limit",
  "500",
  "502",
  "503",
  "504",
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

export function isTransientAcquisitionError(error: unknown, depth = 0): boolean {
  if (error === null || error === undefined || depth > 5) {
    return false;
  }
  const msg = messageOf(error);
  if (TRANSIENT_PATTERNS.some((pattern) => msg.includes(pattern))) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isTransientAcquisitionError(cause, depth + 1);
}
