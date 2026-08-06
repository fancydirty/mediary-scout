import type { AuditEvent } from "../domain.js";

/**
 * 搜索源故障判定 —— `transfer-block.ts` 的搜索层孪生兄弟。
 *
 * 那个文件的教义（原话）：把账号级封锁报成「no_coverage / 暂未找到资源」是拿资源
 * 给系统问题背锅（**别甩锅**）。这里是同一件事发生在更早的一层：搜索源连不上时，
 * 一个候选都取不回来，集数算术于是判定 `no_coverage`，用户读到「暂未找到可用
 * 资源」—— 真实案例里这样持续了 6 天，作者本人都被误导了两小时。
 *
 * 判定不靠猜：sandbox 在拒绝上报时写下结构化审计事件
 * （`no_coverage_refused_source_unhealthy`，见 sandbox.reportNoCoverage），
 * 这里只做读取与措辞。与 `classifyTransferBlock` 从 `transferAttempts` 分类
 * 是同一形制，好让后来的读者只看到一种模式而不是两种。
 */

/** sandbox 拒绝无覆盖上报时写下的审计事件类型。 */
const REFUSED_EVENT = "no_coverage_refused_source_unhealthy";
/** 搜索期间源不健康的审计事件类型（agent 可能压根没走到上报那一步）。 */
const UNHEALTHY_EVENT = "search_source_unhealthy";

export interface SearchSourceFault {
  /** 面向用户的一句话，直接进通知。 */
  reason: string;
  /** 哪些源出了问题，用于文案点名。 */
  sources: string[];
  /** 合并后的状态串（unreachable / protocol_error / 混合）。 */
  status: string;
}

/**
 * 从本次运行的审计事件里判定「这轮没覆盖是因为搜索源故障」。
 *
 * 返回 null 表示没有源故障证据 —— 此时「暂未找到资源」是诚实的结论，必须原样保留。
 * 这是本模块最重要的边界：过度判定会让产品再也无法如实报告「确实没有」，
 * 那比它要修的 bug 更糟。
 */
export function classifySearchSourceFault(
  auditEvents: readonly AuditEvent[] | undefined,
): SearchSourceFault | null {
  if (!auditEvents || auditEvents.length === 0) {
    return null;
  }
  const relevant = auditEvents.filter(
    (event) => event.type === REFUSED_EVENT || event.type === UNHEALTHY_EVENT,
  );
  if (relevant.length === 0) {
    return null;
  }
  // 只有「拒绝上报」才代表整轮证据全不健康。单条 search_source_unhealthy 可能
  // 只是某一次搜索赶上抖动，之后又搜到了东西 —— 那种情况下报源故障是过度判定。
  const refused = relevant.find((event) => event.type === REFUSED_EVENT);
  if (!refused) {
    return null;
  }
  const sources = stringArray(refused.data?.["unhealthySources"]);
  const status = typeof refused.data?.["status"] === "string" ? refused.data["status"] : "unknown";
  const named = sources.length > 0 ? sources.join("、") : "搜索源";
  // protocol_error 与单纯连不上要给不同建议:前者是「地址指向的东西不是 PanSou」,
  // 用户要去改配置;后者是「源挂了/网络不通」,等恢复或换源。
  const isProtocol = status.includes("protocol_error") && !status.includes("unreachable");
  const reason = isProtocol
    ? `${named} 返回的不是 PanSou 接口格式（地址可能指向了别的服务），本轮没能取回任何候选。请检查搜索源地址后重试。`
    : `${named} 本轮连不上，没能取回任何候选。已按「搜索源不可用」收尾，资源留待源恢复后自动重试。`;
  return { reason, sources, status };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
