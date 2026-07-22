import type { DeploymentUpdateState } from "./deployment-update";
import { buildContainerUpgradePrompt } from "./deployment-update";

export type AttentionSeverity = "warning" | "blocker";
export type AttentionKind = "frozen_drive" | "update_available" | "missing_llm";

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

export function buildSettingsAttentionItems(input: {
  demo: boolean;
  drives: Array<{
    id: string;
    provider: string;
    label: string | null;
    status: "active" | "frozen";
  }>;
  brandLabel: (provider: string) => string;
  llmConfigured: boolean;
  update: Pick<DeploymentUpdateState, "kind" | "behind" | "currentShort" | "latestShort"> | null;
  settingsHref?: (tab?: "drives" | "services" | "preferences" | "patrol" | "account") => string;
}): SettingsAttentionItem[] {
  if (input.demo) return [];

  const href = input.settingsHref ?? defaultSettingsHref;
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
      severity: "blocker",
      title: "还没配置 AI 模型",
      body: "填写 Base URL 和模型名后才能自动搜索与获取。",
      actionLabel: "去填写",
      href: href("services"),
    });
  }

  if (
    input.update &&
    input.update.kind === "container" &&
    input.update.behind === true &&
    input.update.currentShort &&
    input.update.latestShort
  ) {
    items.push({
      id: "update_available",
      kind: "update_available",
      severity: "warning",
      title: "有新版本可用",
      body: `当前 ${input.update.currentShort} · 远端 ${input.update.latestShort}。复制指令给本地 Agent 按自检流程升级。`,
      actionLabel: "复制指令",
      href: href(),
      prompt: buildContainerUpgradePrompt({
        currentShort: input.update.currentShort,
        latestShort: input.update.latestShort,
      }),
    });
  }

  return items;
}

export function summarizeSettingsAttention(items: SettingsAttentionItem[]): SettingsAttentionSummary {
  const severity = items.some((item) => item.severity === "blocker")
    ? "blocker"
    : items.length > 0
      ? "warning"
      : null;
  return { count: items.length, severity, items };
}

function defaultSettingsHref(tab?: "drives" | "services" | "preferences" | "patrol" | "account"): string {
  if (!tab || tab === "drives") return "/settings";
  return `/settings?tab=${tab}`;
}
