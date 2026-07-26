/** 设置页 tab 的纯模型：id/标签/解析/URL 写回。UI 无关，node 环境可测。 */

export const SETTINGS_TABS = [
  { id: "drives", label: "网盘" },
  { id: "services", label: "资源与服务" },
  { id: "preferences", label: "获取偏好" },
  { id: "patrol", label: "巡检与通知" },
  { id: "account", label: "账号" },
  { id: "remote", label: "远程访问" },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = "drives";

const TAB_IDS = new Set<string>(SETTINGS_TABS.map((tab) => tab.id));

/**
 * Tabs whose visibility is NOT derivable client-side and is instead observed
 * from whether their slot actually streamed content (server-rendered `null`
 * → hide). See the MutationObserver in `settings-tabs.tsx` for why the flag
 * cannot simply be read from env at build time.
 *
 * Both members render `null` for the same class of reason (not the站主 /
 * feature off), so they share one mechanism — but their visibility is
 * INDEPENDENT: 多用户关时 account 隐藏而 remote 仍可显示。
 */
export const OBSERVED_SETTINGS_TABS = ["account", "remote"] as const;

export type ObservedSettingsTabId = (typeof OBSERVED_SETTINGS_TABS)[number];

/** 受观察 tab 的可见性映射。缺省 = 不可见（fail-closed，与 tablist 保持一致）。 */
export type SettingsTabVisibility = Partial<Record<ObservedSettingsTabId, boolean>>;

/** legacy 深链锚点（account-identity 菜单）→ 账号 tab。 */
const ACCOUNT_HASHES = new Set(["#password", "#accounts"]);

/**
 * @param visible 受观察 tab 的可见性。为兼容旧调用点，传布尔时只表示
 *   「账号 tab 可见」——它绝不顺带放开 remote，否则任一受观察 tab 的深链
 *   就能借另一个 tab 的可见性绕过 fail-closed。
 */
export function resolveSettingsTab(
  param: string | null | undefined,
  visible: SettingsTabVisibility | boolean,
  hash?: string,
): SettingsTabId {
  const visibility: SettingsTabVisibility =
    typeof visible === "boolean" ? { account: visible } : visible;
  const candidate =
    param && TAB_IDS.has(param)
      ? (param as SettingsTabId)
      : !param && hash && ACCOUNT_HASHES.has(hash)
        ? "account"
        : DEFAULT_SETTINGS_TAB;
  if (isObservedTab(candidate) && visibility[candidate] !== true) return DEFAULT_SETTINGS_TAB;
  return candidate;
}

function isObservedTab(tab: SettingsTabId): tab is ObservedSettingsTabId {
  return (OBSERVED_SETTINGS_TABS as readonly SettingsTabId[]).includes(tab);
}

/** 写回 URL query：保留其他参数（?w 工作区）；默认 tab 不留 tab 参数。 */
export function settingsTabQuery(current: URLSearchParams, tab: SettingsTabId): string {
  const next = new URLSearchParams(current);
  if (tab === DEFAULT_SETTINGS_TAB) next.delete("tab");
  else next.set("tab", tab);
  next.sort();
  return next.toString();
}
