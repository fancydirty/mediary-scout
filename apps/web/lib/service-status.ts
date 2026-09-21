// apps/web/lib/service-status.ts
/**
 * 设置 → 资源与服务 每个「服务块」头部的状态胶囊，全部从页面已经读到的持久化
 * 数据推导 —— 不探活、不轮询、不编造。纯函数，node 环境可测。
 *
 * tone 语义（CSS 里对应 .service-pill.is-<tone>）：
 *   on      已配置 / 生效中 / 已接入 —— 用户想要的状态
 *   neutral 默认可用态或纯信息（代理兜底、内置实例、模型名、仅磁力盘）
 *   warn    需要用户处理（配置不全、待测试、连不上）
 *   off     未配置 / 未接入 / 已关闭
 */
export type ServicePillTone = "on" | "neutral" | "warn" | "off";

export interface ServicePill {
  label: string;
  tone: ServicePillTone;
}

const nonBlank = (value: string): boolean => value.trim().length > 0;

/** 主模型：Key 不参与判定 —— 本地模型 Key 可留空（与面板导语一致）。 */
export function llmPills(input: { baseURL: string; modelId: string }): ServicePill[] {
  const hasUrl = nonBlank(input.baseURL);
  const hasModel = nonBlank(input.modelId);
  if (hasUrl && hasModel) return [{ label: `已配置 · ${input.modelId.trim()}`, tone: "on" }];
  if (hasUrl || hasModel) return [{ label: "配置不全", tone: "warn" }];
  return [{ label: "未配置", tone: "off" }];
}

/** Jev：`active` 由调用方用 isJevPrefilterActive 算好传入（单一事实源）。
 *  模型名只在有 key 且非空时追加；清除配置后即使残留也不显示。 */
export function jevPills(input: {
  apiKeySet: boolean;
  healthy: boolean;
  active: boolean;
  model: string | null;
}): ServicePill[] {
  const pills: ServicePill[] = [];
  if (input.active) pills.push({ label: "生效中", tone: "on" });
  else if (input.apiKeySet && input.healthy) pills.push({ label: "已关闭", tone: "off" });
  else if (input.apiKeySet) pills.push({ label: "待测试", tone: "warn" });
  else pills.push({ label: "未配置", tone: "off" });
  if (input.apiKeySet && input.model && nonBlank(input.model)) {
    pills.push({ label: input.model.trim(), tone: "neutral" });
  }
  return pills;
}

export function tmdbPills(input: { apiKeySet: boolean }): ServicePill[] {
  return input.apiKeySet
    ? [{ label: "直连 · 自己的 Key", tone: "on" }]
    : [{ label: "代理兜底", tone: "neutral" }];
}

/** PanSou：`health` 是 pansou_last_probe 的原值（"ok" / "unhealthy" / "" / null）。
 *  只有 unhealthy 才追加告警 —— 与设置页注意事项 search_source_unreachable 同源。 */
export function pansouPills(input: {
  baseURL: string;
  isDesktop: boolean;
  health: string | null;
}): ServicePill[] {
  const pills: ServicePill[] = [];
  if (nonBlank(input.baseURL)) pills.push({ label: "自定义实例", tone: "on" });
  else if (input.isDesktop) pills.push({ label: "公共默认实例", tone: "neutral" });
  else pills.push({ label: "内置实例", tone: "neutral" });
  if (input.health === "unhealthy") pills.push({ label: "连不上", tone: "warn" });
  return pills;
}

/** Prowlarr：恒带「仅磁力盘」—— 它只对支持磁力的盘生效（品牌列表见
 *  brandsSupportingProwlarr，写在一句话里，不重复进胶囊）。 */
export function prowlarrPills(input: { baseURL: string; apiKeySet: boolean }): ServicePill[] {
  const hasUrl = nonBlank(input.baseURL);
  const first: ServicePill =
    hasUrl && input.apiKeySet
      ? { label: "已接入", tone: "on" }
      : hasUrl || input.apiKeySet
        ? { label: "配置不全", tone: "warn" }
        : { label: "未接入", tone: "off" };
  return [first, { label: "仅磁力盘", tone: "neutral" }];
}

export function assrtPills(input: { tokenSet: boolean }): ServicePill[] {
  return input.tokenSet ? [{ label: "已配置", tone: "on" }] : [{ label: "未配置", tone: "off" }];
}
