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
  /** First sight of the CURRENT occurrence (per-account state_since). Set by
   *  applySettingsAttentionState; absent on items straight from the builder. */
  createdAt?: string;
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

/* ---------- per-account seen / dismissed / state_since (badge clears + memory) ----------
 *
 * Three account_settings keys (per-account, NO global fallback):
 *  - attention_seen_at:     ISO time the user last opened Settings. Badge count
 *                           = visible items whose createdAt is AFTER it.
 *  - attention_dismissed:   {itemId: isoTime} per-item dismissals. A dismissal
 *                           applies only to the occurrence it was recorded on…
 *  - attention_state_since: {itemId: isoTime} first sight of the CURRENT
 *                           occurrence. Maintained at read time: an id missing
 *                           from the current items has its entry DROPPED, so a
 *                           re-freeze / re-unconfigure / new version starts a
 *                           fresh occurrence with a fresh createdAt — which is
 *                           what makes an old dismissal stop applying (its
 *                           timestamp is older than the new occurrence) and what
 *                           makes the badge return after being seen.
 * update_available's createdAt semantics: first time ANY read (badge poll or
 * settings render) observed `update:<latestShort>` for this account. */
export const ATTENTION_SEEN_AT_KEY = "attention_seen_at";
export const ATTENTION_DISMISSED_KEY = "attention_dismissed";
export const ATTENTION_STATE_SINCE_KEY = "attention_state_since";

const ATTENTION_ID_RE = /^(missing_llm|frozen:[A-Za-z0-9_-]{1,64}|update:[0-9a-f]{7,40})$/;

/** Dismiss endpoint allow-list: only the three id shapes the builder can emit. */
export function isAttentionItemId(id: string): boolean {
  return ATTENTION_ID_RE.test(id);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MAX_TIME_MAP_ENTRIES = 200;

/** Parse a `{id: isoTime}` JSON map, dropping junk entries (hand-edited DB,
 *  older buggy writers) instead of poisoning every read. */
export function parseAttentionTimeMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.length > 128) continue;
    if (typeof value !== "string" || !ISO_DATE_RE.test(value) || !Number.isFinite(Date.parse(value))) {
      continue;
    }
    map[key] = value;
    if (Object.keys(map).length >= MAX_TIME_MAP_ENTRIES) break;
  }
  return map;
}

export interface AppliedSettingsAttentionState {
  /** Visible (non-dismissed) items, each with createdAt set. Inbox renders these. */
  items: SettingsAttentionItem[];
  /** Badge count: visible items created AFTER seenAt (null seenAt = all visible). */
  count: number;
  /** Worst severity among the COUNTED items; null when count is 0. */
  severity: AttentionSeverity | null;
  nextStateSince: Record<string, string>;
  stateSinceChanged: boolean;
}

export function applySettingsAttentionState(input: {
  items: SettingsAttentionItem[];
  stateSince: Record<string, string>;
  dismissed: Record<string, string>;
  seenAt: string | null;
  now: string;
}): AppliedSettingsAttentionState {
  // Maintain state_since: stamp first sight of new occurrences, drop ended ones.
  const nextStateSince: Record<string, string> = {};
  let stateSinceChanged = false;
  for (const item of input.items) {
    const existing = input.stateSince[item.id];
    if (existing) {
      nextStateSince[item.id] = existing;
    } else {
      nextStateSince[item.id] = input.now;
      stateSinceChanged = true;
    }
  }
  for (const key of Object.keys(input.stateSince)) {
    if (!(key in nextStateSince)) stateSinceChanged = true;
  }

  const visible: SettingsAttentionItem[] = [];
  for (const item of input.items) {
    const createdAt = nextStateSince[item.id]!;
    const dismissedAt = input.dismissed[item.id];
    // A dismissal suppresses only the occurrence it was recorded on: when the
    // state ended and restarted, createdAt is NEWER than dismissedAt and the
    // stale dismissal entry (deliberately never cleaned eagerly) no longer applies.
    if (dismissedAt && dismissedAt >= createdAt) continue;
    visible.push({ ...item, createdAt });
  }

  const counted = visible.filter(
    (item) => input.seenAt === null || item.createdAt! > input.seenAt,
  );
  const severity = counted.some((item) => item.severity === "blocker")
    ? "blocker"
    : counted.some((item) => item.severity === "warning")
      ? "warning"
      : counted.length > 0
        ? "info"
        : null;
  return { items: visible, count: counted.length, severity, nextStateSince, stateSinceChanged };
}
