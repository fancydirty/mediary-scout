"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const accountRef = useRef<HTMLDivElement | null>(null);
  const [accountVisible, setAccountVisible] = useState(false);
  const [hash, setHash] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Hash 只能挂载后读 + 订阅变化：SSR 渲染不知道 hash，若用 lazy initializer
    // 从 window.location.hash 初始化会造成 hydration mismatch——一帧回落是
    // hydration-safe 的代价。
    const readHash = () => setHash(window.location.hash || undefined);
    readHash();
    window.addEventListener("hashchange", readHash);
    const node = accountRef.current;
    let observer: MutationObserver | undefined;
    if (node) {
      const check = () => setAccountVisible(node.childElementCount > 0);
      check();
      observer = new MutationObserver(check);
      // 只看直接子元素：account 两个 section 流出即成为 slot 的直接 child，
      // subtree 只会放大无关触发。
      observer.observe(node, { childList: true });
    }
    return () => {
      window.removeEventListener("hashchange", readHash);
      observer?.disconnect();
    };
  }, []);

  const active = resolveSettingsTab(searchParams.get("tab"), accountVisible, hash);

  const select = (tab: SettingsTabId) => {
    // 显式选 tab 即废弃 legacy hash 提示：replaceState 清 URL 片段但不触发
    // hashchange，不清状态的话旧 #password 会把默认 tab 拽回 account。
    setHash(undefined);
    const query = settingsTabQuery(new URLSearchParams(searchParams), tab);
    // 浅路由（官方 Native History API 姿势）：tab 状态只有客户端消费、面板全部
    // 常挂载，用 router.replace 会走一次 RSC 服务器往返且高亮要等提交——高延迟
    // 链路（CF Tunnel）下每次点击都卡。原生 replaceState 与 useSearchParams
    // 保持同步，零网络、即时切换。
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
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
    // Roving tabindex：方向键以「焦点所在 tab」为基准，不是 active——back/forward
    // 或账号 tab 迟到显现时两者会分离，按 active 起跳会从错误位置移动。
    const focusedId = (event.target as HTMLElement).id?.replace("settings-tab-", "");
    const focusedIndex = visibleTabs.findIndex((tab) => tab.id === focusedId);
    const index = focusedIndex >= 0 ? focusedIndex : visibleTabs.findIndex((tab) => tab.id === active);
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
