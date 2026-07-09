/** 设置页 tab 的纯模型：id/标签/解析/URL 写回。UI 无关，node 环境可测。 */

export const SETTINGS_TABS = [
  { id: "drives", label: "网盘" },
  { id: "services", label: "资源与服务" },
  { id: "preferences", label: "获取偏好" },
  { id: "patrol", label: "巡检与通知" },
  { id: "account", label: "账号" },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = "drives";

const TAB_IDS = new Set<string>(SETTINGS_TABS.map((tab) => tab.id));

/** legacy 深链锚点（account-identity 菜单）→ 账号 tab。 */
const ACCOUNT_HASHES = new Set(["#password", "#accounts"]);

export function resolveSettingsTab(
  param: string | null | undefined,
  accountTabVisible: boolean,
  hash?: string,
): SettingsTabId {
  const candidate =
    param && TAB_IDS.has(param)
      ? (param as SettingsTabId)
      : !param && hash && ACCOUNT_HASHES.has(hash)
        ? "account"
        : DEFAULT_SETTINGS_TAB;
  if (candidate === "account" && !accountTabVisible) return DEFAULT_SETTINGS_TAB;
  return candidate;
}

/** 写回 URL query：保留其他参数（?w 工作区）；默认 tab 不留 tab 参数。 */
export function settingsTabQuery(current: URLSearchParams, tab: SettingsTabId): string {
  const next = new URLSearchParams(current);
  if (tab === DEFAULT_SETTINGS_TAB) next.delete("tab");
  else next.set("tab", tab);
  next.sort();
  return next.toString();
}
