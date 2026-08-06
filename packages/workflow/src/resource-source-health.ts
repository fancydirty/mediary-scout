/**
 * 搜索源健康态。存在的唯一理由：让「源挂了」与「真没有这个资源」在数据上
 * 可区分。在此之前两者都表现为 `candidates: []`，于是 agent 上报
 * reportNoCoverage、用户看到「暂未找到可用资源」—— 把系统故障甩锅给资源。
 * 同一条教义见 acquisition-v2/transfer-block.ts（账号被封锁 vs 链接确实死了）。
 */

/** 单个源的状态。protocol_error 与 unreachable 分开，是因为它们的用户动作不同：
 *  前者「地址填错了/那不是 PanSou」，后者「源挂了/网络不通」。
 *
 *  degraded 的存在是为了让「部分证据」的信号能穿过复合层:一个成员(比如
 *  FallbackResourceProvider 回落官方源后)自报 degraded,意味着它**答了话、给了
 *  候选**、但证据不完整。折成 healthy 会让不完整证据看起来像完整证据(把本 PR
 *  要消灭的「静默误导」从另一端放回来);折成 unreachable 又会与「它确实给了
 *  候选」自相矛盾。所以合并层必须**透传** degraded,而不是折向任何一端。 */
export type SourceStatus = "healthy" | "degraded" | "unreachable" | "protocol_error";

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

/** 「按 PanSou 协议应答了,但报了错」—— 比如限流/参数错(code != 0)。这与
 *  `PanSouProtocolError` 相反:后者表示「地址指向的东西不是 PanSou」,前者表示
 *  「源是 PanSou,只是此刻临时出错」。分类上归 unreachable(临时故障,等恢复/重试),
 *  绝不能归 protocol_error —— 否则会告诉一个源其实没配错的用户「地址填错了」,
 *  把他引向错误的排查方向。 */
export class PanSouRequestError extends Error {
  constructor(detail: string) {
    super(`PANSOU_REQUEST_ERROR: ${detail}`);
    this.name = "PanSouRequestError";
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
export function classifySourceFailure(error: unknown): "unreachable" | "protocol_error" {
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
  return health.status === "healthy" || health.status === "degraded";
}

/**
 * 合并态是否算「可用证据」——即基于它下「没有资源」的结论是否站得住。
 *
 * degraded 算可用：至少一个源答了，拿到的候选是真的。有意不把 degraded 归为
 * 不可用 —— 否则任何一个次要索引挂掉就再也报不出真实的「没有资源」，过于激进。
 * healthy 走 isSourceUsable，不在这里重述分类学。
 *
 * 调用方需要「缺字段=healthy」的向后兼容时，自己传 undefined 进来即可。
 * fallback-provider.ts 有一个同口径的本地谓词（它吃的是域快照，不是 V2 快照）。
 */
export function isMergedSourceEvidenceUsable(health: MergedSourceHealth | undefined): boolean {
  if (!health) return true;
  if (health.status === "degraded") return true;
  return isSourceUsable({ status: health.status, source: health.unhealthySources.join("、") });
}

export function mergeSourceHealth(healths: readonly SourceHealth[]): MergedSourceHealth {
  if (healths.length === 0) {
    return { status: "healthy", unhealthySources: [] };
  }
  // 两个集合要分开:
  //  - `unusable` = 完全不可用的源(unreachable/protocol_error),决定「是否全挂」。
  //  - `unhealthySources` = 所有「不是完全健康」的源,决定「点名谁」。degraded 的
  //    源(比如回落官方源后)必须也能被点名,否则全 degraded 时报 [] → 上层只能
  //    显示「未知」。
  const unusable = healths.filter((h) => !isSourceUsable(h));
  const unhealthySources = healths.filter((h) => h.status !== "healthy").map((h) => h.source);
  // 任何源自报 degraded(比如回落官方源后)都说明整体证据不完整 —— 即使没有源
  // 完全挂掉。此时必须带 degraded 信号,否则「部分证据」看起来像「完整证据」。
  const anyDegraded = healths.some((h) => h.status === "degraded");
  if (unusable.length === 0 && anyDegraded) {
    return { status: "degraded", unhealthySources };
  }
  if (unusable.length === 0) {
    return { status: "healthy", unhealthySources };
  }
  if (unusable.length !== healths.length) {
    // 还有源在答:候选可用,但「没找到」不成立。此时具体是哪种失败不重要 ——
    // 用户的当务之急是知道证据不完整,而不是去修某一个源。
    return { status: "degraded", unhealthySources };
  }
  // 全挂。若所有失败同因,把这个因保留下来,好给出对症的处置建议;
  // 混合失败则退回 unreachable(没有单一的建议可给)。
  const everyStatus = new Set(unusable.map((h) => h.status));
  return {
    status: everyStatus.size === 1 && everyStatus.has("protocol_error") ? "protocol_error" : "unreachable",
    unhealthySources,
  };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
