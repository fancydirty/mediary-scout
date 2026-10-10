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
  // 匹配。这些 token（"429"/"too many requests"/"rate limit"）是 HTTP 状态码
  // 及其标准短语，只出现在 LLM/HTTP 传输层的报错消息中。残剩的误报面（业务
  // 错误文本碰巧带独立的三位 5xx token，如「第 503 集」）代价有界：多吃最多
  // 3 次 1/5/15min 退避重排后仍会终止失败，不会把失败藏成永久重试。
  //
  // 5xx 的 message 侧不走这里的子串枚举，由下面的词边界正则统一提取（见
  // messageHasTransient5xx）。
  "429",
  "too many requests",
  "rate limit",
];

// 5xx 的 message 侧：提取「独立的三位 5xx token」（两侧词边界），501 同样
// 排除（与数值分支同一刀口）。替换掉原来枚举的 "500"/"502"/"503"/"504" 四个
// 子串 —— Cloudflare 网关常见的 520/521/522/523/524 对那份枚举不可见，message
// 只带 "HTTP 520" 的错误就不退避了。词边界保证 "fileId 50345"/"任务 5030 号"
// 这类长数字不误伤；业务文本里恰好独立的「503」（如「第 503 集」）仍会命中
// —— 维持既有「有界代价 ≤3 次退避」的论证，不为此加码。
const TRANSIENT_5XX_TOKEN = /\b5\d{2}\b/g;

function messageHasTransient5xx(message: string): boolean {
  const tokens = message.match(TRANSIENT_5XX_TOKEN);
  return tokens !== null && tokens.some((token) => token !== "501");
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  return "";
}

/**
 * 提取错误节点上携带的 HTTP 状态码：AI SDK 的 APICallError 放在数值字段
 * `statusCode` 上，部分 fetch 封装用同义字段 `responseStatus` —— 两个都认，
 * `statusCode` 优先。只认 number（字符串形态的 "503" 由文本模式覆盖）。
 * 无则 null。
 *
 * 共享给两处按状态码分类的判定器 —— 本文件的退避闸门和 agent-error.ts 的
 * 免费档 headline 桶 —— 保证口径不漂移（Copilot r3 C：`{responseStatus:503}`
 * 退避重试耗尽后，headline 分类器因只读 statusCode 把它读成 generic 网络标题
 * 而不是 Kilo 指引）。
 */
export function extractHttpStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") {
    return null;
  }
  const { statusCode, responseStatus } = error as { statusCode?: unknown; responseStatus?: unknown };
  if (typeof statusCode === "number") {
    return statusCode;
  }
  if (typeof responseStatus === "number") {
    return responseStatus;
  }
  return null;
}

/**
 * 数值判定比文本扫描稳：AI SDK 的 APICallError 把状态码放在数值字段上，
 * message 可能完全不含数字（如 `{statusCode: 503, message: "Request failed"}`）
 * —— 只扫文本就漏退避。只认 429 与 5xx（4xx 里只有 429 是「等一下再试」，
 * 404/401 重试也不会好）；501 刻意排除 —— Not Implemented 是服务端配置/实现
 * 问题，重试大概率原样再犯，不属于「等高峰过去就好」的波动（数值与文本两侧
 * 同一刀口，同一个 501 不会因为长在不同字段上就命运不同）。数值相等不会像
 * 子串那样被业务文本（「第 503 集」）误触发。
 */
function isTransientHttpStatus(code: number | null): boolean {
  return code !== null && (code === 429 || (code >= 500 && code <= 599 && code !== 501));
}

/** 一个 cause 链节点上是否带瞬时的 HTTP 状态码字段（APICallError.statusCode /
 *  fetch 封装的 responseStatus）。 */
function carriesTransientHttpStatus(error: unknown): boolean {
  return isTransientHttpStatus(extractHttpStatus(error));
}

export function isTransientAcquisitionError(error: unknown, depth = 0): boolean {
  if (error === null || error === undefined || depth > 5) {
    return false;
  }
  if (carriesTransientHttpStatus(error)) {
    return true;
  }
  const msg = messageOf(error);
  if (TRANSIENT_PATTERNS.some((pattern) => msg.includes(pattern))) {
    return true;
  }
  if (messageHasTransient5xx(msg)) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isTransientAcquisitionError(cause, depth + 1);
}
