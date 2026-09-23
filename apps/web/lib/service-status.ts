// apps/web/lib/service-status.ts
import { DEFAULT_PANSOU_BASE_URL, normalizePanSouBaseUrl } from "./pansou-chain";

/**
 * 设置 → 资源与服务 每个「服务块」头部的状态胶囊。输入是各服务的**生效配置**：
 * 调用方用 runtime 同一套解析器读（DB 优先、再 env），所以胶囊说的就是真正在跑的
 * 那一份 —— 仍然不探活、不轮询、不编造。纯函数，node 环境可测。
 *
 * tone 语义（CSS 里对应 .service-pill.is-<tone>）：
 *   on      已配置 / 生效中 / 已接入 —— 用户想要的状态
 *   neutral 默认可用态或纯信息（代理兜底、内置实例、模型名、仅磁力盘、来自环境变量）
 *   warn    需要用户处理（配置不全、待测试、连不上）
 *   off     未配置 / 未接入 / 已关闭
 */
export type ServicePillTone = "on" | "neutral" | "warn" | "off";

export interface ServicePill {
  label: string;
  tone: ServicePillTone;
}

const nonBlank = (value: string): boolean => value.trim().length > 0;

/** True when the effective value is present but its account-scoped DB override is blank. */
export function isEnvBackedValue(dbValue: string | null | undefined, effectiveValue: string | undefined): boolean {
  return !dbValue?.trim() && Boolean(effectiveValue?.trim());
}

/** 生效值里有一层是 env 补上的（DB 那格留空）：输入框是空的，服务却在用这个值 ——
 *  标出来源，免得用户以为没配、或者找不到它从哪来。 */
const ENV_SOURCE_PILL: ServicePill = { label: "来自环境变量", tone: "neutral" };

/** 主模型：baseURL / modelId 是 resolveAgentModelConfig 的生效值（DB → AGENT_MODEL_* →
 *  XIAOMI_MIMO_*）；fromEnv = 其中非空的一项是 env 补的（DB 那格留空）。
 *  Key 不参与判定 —— 本地模型 Key 可留空（与面板导语一致）。 */
export function llmPills(input: { baseURL: string; modelId: string; fromEnv: boolean }): ServicePill[] {
  const hasUrl = nonBlank(input.baseURL);
  const hasModel = nonBlank(input.modelId);
  const source = input.fromEnv ? [ENV_SOURCE_PILL] : [];
  if (hasUrl && hasModel) return [{ label: `已配置 · ${input.modelId.trim()}`, tone: "on" }, ...source];
  if (hasUrl || hasModel) return [{ label: "配置不全", tone: "warn" }, ...source];
  return [{ label: "未配置", tone: "off" }];
}

/** Jev：apiKeySet 看 getJevConfig 的生效 key（DB → env JEV_API_KEY）；fromEnv = 这把 key
 *  是 env 补的（DB 留空），此时 来自环境变量 排在最后。`active` 由调用方用
 *  isJevPrefilterActive 算好传入（单一事实源）。模型名只在有 key 且非空时追加；
 *  清除配置后即使残留也不显示。 */
export function jevPills(input: {
  apiKeySet: boolean;
  healthy: boolean;
  active: boolean;
  model: string | null;
  fromEnv: boolean;
}): ServicePill[] {
  const pills: ServicePill[] = [];
  if (input.active) pills.push({ label: "生效中", tone: "on" });
  else if (input.apiKeySet && input.healthy) pills.push({ label: "已关闭", tone: "off" });
  else if (input.apiKeySet) pills.push({ label: "待测试", tone: "warn" });
  else pills.push({ label: "未配置", tone: "off" });
  if (input.apiKeySet && input.model && nonBlank(input.model)) {
    pills.push({ label: input.model.trim(), tone: "neutral" });
  }
  if (input.apiKeySet && input.fromEnv) pills.push(ENV_SOURCE_PILL);
  return pills;
}

/** TMDB：与 getTmdbAccesses 同序 —— DB 里用户自己的 Key（userKeySet）→ env
 *  TMDB_READ_TOKEN（envKeySet）→ 作者代理。env 那层同样直连，只是值不在输入框里。 */
export function tmdbPills(input: { userKeySet: boolean; envKeySet: boolean }): ServicePill[] {
  if (input.userKeySet) return [{ label: "直连 · 自己的 Key", tone: "on" }];
  if (input.envKeySet) return [{ label: "直连 · 自己的 Key", tone: "on" }, ENV_SOURCE_PILL];
  return [{ label: "代理兜底", tone: "neutral" }];
}

/** compose 自带的 PanSou 服务名：docker-compose.yml 注入 `PANSOU_BASE_URL: http://pansou`。 */
const BUNDLED_PANSOU_HOSTNAME = "pansou";

function isBundledPanSou(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === BUNDLED_PANSOU_HOSTNAME;
  } catch {
    return false; // 解析不了的地址不可能是自带容器
  }
}

/** PanSou：dbBaseURL / envBaseURL 是 resolveUserPanSouBaseUrl 的两层生效输入（DB 优先、
 *  再 env PANSOU_BASE_URL；两层都空时 runtime 用作者的公共默认实例）。env 指向 compose
 *  自带的 `pansou` 容器 = 内置实例；指向别处 = 自定义实例 · 来自环境变量。
 *  `health` 是 pansou_last_probe 的原值（"ok" / "unhealthy" / "" / null）。只有
 *  unhealthy 才追加告警 —— 与设置页注意事项 search_source_unreachable 同源。 */
export function pansouPills(input: {
  dbBaseURL: string;
  envBaseURL: string;
  health: string | null;
}): ServicePill[] {
  const pills: ServicePill[] = [];
  const dbBaseURL = normalizePanSouBaseUrl(input.dbBaseURL);
  const envBaseURL = normalizePanSouBaseUrl(input.envBaseURL);
  const dbIsPublic = dbBaseURL === DEFAULT_PANSOU_BASE_URL;
  const envIsPublic = !dbBaseURL && envBaseURL === DEFAULT_PANSOU_BASE_URL;
  if (dbIsPublic || envIsPublic || (!dbBaseURL && !envBaseURL)) {
    pills.push({ label: "公共默认实例", tone: "neutral" });
    if (envIsPublic) pills.push(ENV_SOURCE_PILL);
  } else if (dbBaseURL) {
    pills.push({ label: "自定义实例", tone: "on" });
  } else if (isBundledPanSou(envBaseURL)) {
    pills.push({ label: "内置实例", tone: "neutral" });
  } else {
    pills.push({ label: "自定义实例", tone: "on" }, ENV_SOURCE_PILL);
  }
  if (input.health === "unhealthy") pills.push({ label: "连不上", tone: "warn" });
  return pills;
}

/** Prowlarr：baseURL / apiKeySet 是 getProwlarrConfig 的生效值（DB → env PROWLARR_*）；
 *  fromEnv = 其中非空的一项是 env 补的。恒带「仅磁力盘」且排最后 —— 它只对支持磁力的盘
 *  生效（品牌列表见 brandsSupportingProwlarr，写在一句话里，不重复进胶囊）。 */
export function prowlarrPills(input: { baseURL: string; apiKeySet: boolean; fromEnv: boolean }): ServicePill[] {
  const hasUrl = nonBlank(input.baseURL);
  const first: ServicePill =
    hasUrl && input.apiKeySet
      ? { label: "已接入", tone: "on" }
      : hasUrl || input.apiKeySet
        ? { label: "配置不全", tone: "warn" }
        : { label: "未接入", tone: "off" };
  const source = input.fromEnv && (hasUrl || input.apiKeySet) ? [ENV_SOURCE_PILL] : [];
  return [first, ...source, { label: "仅磁力盘", tone: "neutral" }];
}

/** assrt：只有 DB 一层（getAssrtToken 不读 env），DB 里有没有 token 就是生效值。 */
export function assrtPills(input: { tokenSet: boolean }): ServicePill[] {
  return input.tokenSet ? [{ label: "已配置", tone: "on" }] : [{ label: "未配置", tone: "off" }];
}
