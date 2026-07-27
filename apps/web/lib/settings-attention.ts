import type { DeploymentUpdateState } from "./deployment-update";
import { buildContainerUpgradePrompt } from "./deployment-update";
import { DEFAULT_SETTINGS_TAB, type SettingsTabId } from "./settings-tabs-model";

export type AttentionSeverity = "info" | "warning" | "blocker";
export type AttentionKind = "frozen_drive" | "update_available" | "missing_llm";
export type SettingsAttentionTab = SettingsTabId;

export interface SettingsAttentionItem {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  body: string;
  actionLabel: string;
  /** Settings deep-link path+query (no origin), e.g. `/settings?tab=services`. */
  href: string;
  /** Present only for update_available — full agent deploy prompt. */
  prompt?: string;
}

export interface SettingsAttentionSummary {
  count: number;
  severity: AttentionSeverity | null;
  items: SettingsAttentionItem[];
}

/** Settings deep-link that keeps non-primary workspace (`?w`) like sidebar links. */
export function settingsAttentionHref(
  tab?: SettingsAttentionTab,
  activeStorageId?: string,
): string {
  const params = new URLSearchParams();
  if (tab && tab !== DEFAULT_SETTINGS_TAB) params.set("tab", tab);
  if (activeStorageId) params.set("w", activeStorageId);
  params.sort();
  const query = params.toString();
  return query ? `/settings?${query}` : "/settings";
}

export function buildSettingsAttentionItems(input: {
  demo: boolean;
  /** update_available is instance-level (BUILD_COMMIT vs remote main) — owner-only.
   *  Single-user passes true (implicit owner). frozen_drive/missing_llm stay per-account. */
  isOwner: boolean;
  drives: Array<{
    id: string;
    provider: string;
    label: string | null;
    status: "active" | "frozen";
  }>;
  brandLabel: (provider: string) => string;
  llmConfigured: boolean;
  update: Pick<DeploymentUpdateState, "kind" | "behind" | "currentShort" | "latestShort"> | null;
  /** Public request origin — baked into the update prompt's SSH/health-check steps. */
  origin: string;
  /** Non-primary workspace id — preserved on deep-links so inbox actions don't reset context. */
  activeStorageId?: string;
  settingsHref?: (tab?: SettingsAttentionTab) => string;
}): SettingsAttentionItem[] {
  if (input.demo) return [];

  const href =
    input.settingsHref ??
    ((tab?: SettingsAttentionTab) => settingsAttentionHref(tab, input.activeStorageId));
  const items: SettingsAttentionItem[] = [];

  for (const drive of input.drives) {
    if (drive.status !== "frozen") continue;
    const name = (drive.label?.trim() || input.brandLabel(drive.provider) || "网盘").trim();
    items.push({
      id: `frozen:${drive.id}`,
      kind: "frozen_drive",
      severity: "blocker",
      title: `${name} 已失效`,
      body: "重新扫码或重新绑定即可恢复，不影响已有媒体库。",
      actionLabel: "去处理",
      href: href("drives"),
    });
  }

  if (!input.llmConfigured) {
    items.push({
      id: "missing_llm",
      kind: "missing_llm",
      severity: "warning",
      title: "还没配置 AI 模型",
      body: "填写 Base URL 和模型名后才能自动搜索与获取。",
      actionLabel: "去填写",
      href: href("services"),
    });
  }

  if (
    input.isOwner &&
    input.update &&
    input.update.kind === "container" &&
    input.update.behind === true &&
    input.update.currentShort &&
    input.update.latestShort
  ) {
    items.push({
      // Version-scoped id: when remote main moves to a NEW latestShort this item
      // gets a NEW id, so it reappears even after the user dismissed/saw the old one.
      id: `update:${input.update.latestShort}`,
      kind: "update_available",
      severity: "info",
      title: "有新版本可用",
      body: `当前 ${input.update.currentShort} · 远端 ${input.update.latestShort}。复制指令给本地 Agent 按自检流程升级。`,
      actionLabel: "复制指令",
      href: href(),
      prompt: buildContainerUpgradePrompt({
        currentShort: input.update.currentShort,
        latestShort: input.update.latestShort,
        origin: input.origin,
      }),
    });
  }

  return items;
}

export function summarizeSettingsAttention(items: SettingsAttentionItem[]): SettingsAttentionSummary {
  const severity = items.some((item) => item.severity === "blocker")
    ? "blocker"
    : items.some((item) => item.severity === "warning")
      ? "warning"
      : items.length > 0
        ? "info"
        : null;
  return { count: items.length, severity, items };
}
