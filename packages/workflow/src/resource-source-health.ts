/**
 * 搜索源健康态。存在的唯一理由：让「源挂了」与「真没有这个资源」在数据上
 * 可区分。在此之前两者都表现为 `candidates: []`，于是 agent 上报
 * reportNoCoverage、用户看到「暂未找到可用资源」—— 把系统故障甩锅给资源。
 * 同一条教义见 acquisition-v2/transfer-block.ts（账号被封锁 vs 链接确实死了）。
 */

/** 单个源的状态。protocol_error 与 unreachable 分开，是因为它们的用户动作不同：
 *  前者「地址填错了/那不是 PanSou」，后者「源挂了/网络不通」。 */
export type SourceStatus = "healthy" | "unreachable" | "protocol_error";

export interface SourceHealth {
  status: SourceStatus;
  /** 源名（pansou / prowlarr / …），用于告知用户是哪个挂了。 */
  source: string;
}

/** 多源合并后的整体健康态。degraded = 部分源答了：拿到的候选可用，但
 *  「没找到」这个结论不成立（证据不完整）。 */
export interface MergedSourceHealth {
  status: "healthy" | "degraded" | "unreachable";
  unhealthySources: string[];
}

/** 协议层失败的哨兵前缀。provider 用它标记「连上了但对方不是 PanSou」。 */
export const PROTOCOL_ERROR_PREFIX = "PANSOU_BAD_RESPONSE";

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ABORT_ERR",
]);

/**
 * 把一个异常归类。**默认 unreachable 而不是 healthy**：宁可多报一次
 * 「源可能有问题」，也不能把未知失败当成「确认没有资源」——后者会让用户
 * 停止排查，正是本次要修的病。
 */
export function classifySourceFailure(error: unknown): Exclude<SourceStatus, "healthy"> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(PROTOCOL_ERROR_PREFIX)) {
    return "protocol_error";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) {
    return "unreachable";
  }
  if (/timed out|timeout|aborted/i.test(message)) {
    return "unreachable";
  }
  return "unreachable";
}

export function isSourceUsable(health: SourceHealth): boolean {
  return health.status === "healthy";
}

export function mergeSourceHealth(healths: readonly SourceHealth[]): MergedSourceHealth {
  if (healths.length === 0) {
    return { status: "healthy", unhealthySources: [] };
  }
  const unhealthy = healths.filter((h) => !isSourceUsable(h));
  if (unhealthy.length === 0) {
    return { status: "healthy", unhealthySources: [] };
  }
  const unhealthySources = unhealthy.map((h) => h.source);
  return {
    status: unhealthy.length === healths.length ? "unreachable" : "degraded",
    unhealthySources,
  };
}
