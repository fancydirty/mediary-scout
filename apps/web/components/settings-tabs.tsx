"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  SETTINGS_TABS,
  resolveSettingsTab,
  settingsTabQuery,
  type SettingsTabId,
} from "../lib/settings-tabs-model";

/**
 * 设置页 tab 壳：五个 slot 常挂载（Suspense 流式照旧），按当前 tab 显隐。
 * - tab 状态 = ?tab=（router.replace 软导航，保留 ?w）。
 * - 「账号」tab 可见性不读服务端 flag（cacheComponents 会把 build 时的 env 值
 *   烤进静态壳，docker 镜像 build/run 环境不同——PasswordChangeSection 同款教训）：
 *   观察 account slot 是否真的流出了内容（多用户关时两个 section 都渲染 null）。
 */
export function SettingsTabs(props: {
  drives: ReactNode;
  services: ReactNode;
  preferences: ReactNode;
  patrol: ReactNode;
  account: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const accountRef = useRef<HTMLDivElement | null>(null);
  const [accountVisible, setAccountVisible] = useState(false);
  const [hash, setHash] = useState<string | undefined>(undefined);

  useEffect(() => {
    setHash(window.location.hash || undefined);
    const node = accountRef.current;
    if (!node) return;
    const check = () => setAccountVisible(node.childElementCount > 0);
    check();
    const observer = new MutationObserver(check);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const active = resolveSettingsTab(searchParams.get("tab"), accountVisible, hash);

  const select = (tab: SettingsTabId) => {
    const query = settingsTabQuery(new URLSearchParams(searchParams), tab);
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const panels: Array<{ id: SettingsTabId; content: ReactNode }> = [
    { id: "drives", content: props.drives },
    { id: "services", content: props.services },
    { id: "preferences", content: props.preferences },
    { id: "patrol", content: props.patrol },
    { id: "account", content: props.account },
  ];

  // WAI-ARIA tabs pattern: same-page state, not page navigation — so
  // tablist/tab/tabpanel + aria-selected (not aria-current), arrows move tabs.
  const visibleTabs = SETTINGS_TABS.filter((tab) => tab.id !== "account" || accountVisible);
  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = visibleTabs.findIndex((tab) => tab.id === active);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = visibleTabs[(index + step + visibleTabs.length) % visibleTabs.length]!;
    select(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

  return (
    <>
      <div className="settings-tabs" role="tablist" aria-label="设置分区" onKeyDown={onTablistKeyDown}>
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            id={`settings-tab-${tab.id}`}
            type="button"
            role="tab"
            className={`settings-tab${active === tab.id ? " is-active" : ""}`}
            aria-selected={active === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => select(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {panels.map((panel) => (
        <div
          key={panel.id}
          id={`settings-panel-${panel.id}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${panel.id}`}
          ref={panel.id === "account" ? accountRef : undefined}
          hidden={active !== panel.id}
        >
          {panel.content}
        </div>
      ))}
    </>
  );
}
