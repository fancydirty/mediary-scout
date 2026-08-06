import type { ResourceSnapshot } from "./domain.js";
import type { ResourceProvider } from "./ports.js";
import {
  classifySourceFailure,
  mergeSourceHealth,
  type SourceStatus,
} from "./resource-source-health.js";

export interface FallbackResourceProviderOptions {
  /** 用户自建源。健康时永远优先。 */
  primary: { name: string; provider: ResourceProvider };
  /** 官方公共源。只有主源不可用时才动用。 */
  secondary: { name: string; provider: ResourceProvider };
}

/**
 * 优先级 fallback:主源不可用才落到备源。
 *
 * 两条刻意的设计:
 * 1. **只有「不可用」才 fallback,「健康但没结果」不 fallback。** 后者是权威的
 *    「确实没有」,再搜一遍备源只会让每一次未命中都翻倍耗时。
 * 2. **fallback 成功后整体仍标 degraded。** 搜索是成功了,但用户配的源是坏的,
 *    必须让他知道 —— 悄悄靠官方源续命,正是一个配置错误能活六天没人发现的原因。
 *
 * 刻意不做熔断器与 hedged request:本产品的搜索是低频后台任务,熔断器要维护
 * 跨请求状态并调参(阈值/半开/冷却),复杂度远超收益;hedged request 会让每次
 * 搜索都双打两个源,对公共免费源不礼貌。
 */
export class FallbackResourceProvider implements ResourceProvider {
  private readonly primary: FallbackResourceProviderOptions["primary"];
  private readonly secondary: FallbackResourceProviderOptions["secondary"];

  constructor(options: FallbackResourceProviderOptions) {
    this.primary = options.primary;
    this.secondary = options.secondary;
  }

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const primary = await attempt(this.primary.provider, input);
    if (primary.ok && isUsable(primary.snapshot)) {
      return primary.snapshot;
    }
    // 主源的真实病因:抛错时来自 classifySourceFailure,自报不健康时来自它
    // 自己的 status。带着它走,fallback 之后 UI 仍能给出对症的建议。
    const primaryStatus: "unreachable" | "protocol_error" = primary.ok
      ? primary.snapshot.sourceHealth?.status === "protocol_error"
        ? "protocol_error"
        : "unreachable"
      : primary.status;

    const secondary = await attempt(this.secondary.provider, input);
    if (secondary.ok && isUsable(secondary.snapshot)) {
      // 搜索成功了,但主源坏着 —— 用 degraded 把这件事带出去。
      return {
        ...secondary.snapshot,
        sourceHealth: mergeSourceHealth([
          { status: primaryStatus, source: this.primary.name },
          { status: "healthy", source: this.secondary.name },
        ]),
      };
    }

    // 两个都不可用:给出明确的故障快照,而不是一个看起来像「没找到」的空快照。
    const base = secondary.ok ? secondary.snapshot : primary.ok ? primary.snapshot : null;
    return {
      id: base?.id ?? `fallback_unreachable_${input.workflowRunId ?? "adhoc"}`,
      provider: "fallback",
      keyword: input.keyword,
      candidates: [],
      createdAt: base?.createdAt ?? new Date().toISOString(),
      sourceHealth: mergeSourceHealth([
        { status: primaryStatus, source: this.primary.name },
        {
          status: secondary.ok
            ? secondary.snapshot.sourceHealth?.status === "protocol_error"
              ? "protocol_error"
              : "unreachable"
            : secondary.status,
          source: this.secondary.name,
        },
      ]),
    };
  }
}

type Attempt =
  | { ok: true; snapshot: ResourceSnapshot }
  // attempt() 的 catch 只可能从 classifySourceFailure 得到这两种,不会出现
  // degraded —— 类型收紧以免后续误把 degraded 当「异常原因」用。
  | { ok: false; status: "unreachable" | "protocol_error" };

/** 保留失败原因而不是 `catch { return null }`。丢掉它会把主源的
 *  protocol_error 压成 unreachable —— 而这两者存在的全部理由就是给用户
 *  不同的处置建议(「地址填错了」vs「源挂了」)。在一个专门消灭
 *  「静默吞错」的改动里再写一个 bare catch,是自相矛盾的。 */
async function attempt(
  provider: ResourceProvider,
  input: { keyword: string; workflowRunId?: string },
): Promise<Attempt> {
  try {
    return { ok: true, snapshot: await provider.search(input) };
  } catch (error) {
    return { ok: false, status: classifySourceFailure(error) };
  }
}

/** 缺 sourceHealth 的老 provider 视为可用(向后兼容)。degraded 也算可用 ——
 *  证据不完整但确实拿到了东西,不值得为此再打一遍备源。 */
function isUsable(snapshot: ResourceSnapshot): boolean {
  const status = snapshot.sourceHealth?.status ?? "healthy";
  return status === "healthy" || status === "degraded";
}
