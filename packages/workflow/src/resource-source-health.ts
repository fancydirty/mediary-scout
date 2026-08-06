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
 *  「没找到」这个结论不成立（证据不完整）。
 *
 *  `protocol_error` 必须能穿透合并层而不被压成 `unreachable`：这两者存在的
 *  全部理由就是用户的处置动作不同（「地址填错了/那不是 PanSou」 vs
 *  「源挂了/网络不通」）。压平之后会告诉一个填错地址的用户「你的源挂了」，
 *  把他引向错误的排查方向 —— 那正是本次要消灭的那类误导。 */
export interface MergedSourceHealth {
  status: "healthy" | "degraded" | "unreachable" | "protocol_error";
  unhealthySources: string[];
}

/** 协议层失败的哨兵前缀。仅作为跨进程/跨包的兜底识别手段——同进程内请抛
 *  `PanSouProtocolError`，靠 instanceof 判定，避免改一句错误文案就把
 *  protocol_error 静默降级成 unreachable（用户会因此拿到错误的排查建议）。 */
export const PROTOCOL_ERROR_PREFIX = "PANSOU_BAD_RESPONSE";

/** 「连上了，但对方不是 PanSou」。与仓库既有的 Pan115AuthError / QuarkAuthError
 *  等同一形制。消息仍带 PROTOCOL_ERROR_PREFIX，使字符串兜底路径继续成立。 */
export class PanSouProtocolError extends Error {
  constructor(detail: string) {
    super(`${PROTOCOL_ERROR_PREFIX}: ${detail}`);
    this.name = "PanSouProtocolError";
  }
}

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
  // instanceof 优先:同进程内这是类型安全的判定。字符串前缀留作兜底,
  // 覆盖跨包/跨进程(错误经序列化后 instanceof 失效)的情形。
  if (error instanceof PanSouProtocolError) {
    return "protocol_error";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(PROTOCOL_ERROR_PREFIX)) {
    return "protocol_error";
  }
  // 下面两个分支当前同值(都 unreachable),保留不是冗余而是分类学:它们记录了
  // 已经考虑过的失败条件。后续若要按错误类型分化重试/退避策略(ETIMEDOUT 值得
  // 重试、ECONNREFUSED 基本不值得),分叉点就在这里 —— 届时不必重新调研这份清单。
  // undici/Node fetch 把真实 socket 错误包在 cause 里:外层只是扁平的
  // "fetch failed",code 在 cause 上。不解包的话 UNREACHABLE_CODES 在生产里
  // 几乎永远匹配不上(结论仍对,但这份清单就成了摆设)。
  if (hasRecognisedUnreachableCode(error)) {
    return "unreachable";
  }
  return "unreachable";
}

/** 该错误是否被 UNREACHABLE_CODES 清单**识别**（而非只是落到兜底分支）。
 *  导出它的理由：`classifySourceFailure` 的兜底也返回 unreachable，因此仅断言
 *  返回值无法区分「清单命中」与「兜底」——一个去掉 cause 解包的改动会让清单在
 *  生产中形同虚设，而测试照样绿。这个谓词让那件事变得可断言。 */
export function hasRecognisedUnreachableCode(error: unknown): boolean {
  const code = errorCode(error) ?? errorCode((error as { cause?: unknown } | null)?.cause);
  return code !== undefined && UNREACHABLE_CODES.has(code);
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
  if (unhealthy.length !== healths.length) {
    // 还有源在答:候选可用,但「没找到」不成立。此时具体是哪种失败不重要 ——
    // 用户的当务之急是知道证据不完整,而不是去修某一个源。
    return { status: "degraded", unhealthySources };
  }
  // 全挂。若所有失败同因,把这个因保留下来,好给出对症的处置建议;
  // 混合失败则退回 unreachable(没有单一的建议可给)。
  const everyStatus = new Set(unhealthy.map((h) => h.status));
  return {
    status: everyStatus.size === 1 && everyStatus.has("protocol_error") ? "protocol_error" : "unreachable",
    unhealthySources,
  };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
