import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  resolveSettingsTab,
  settingsTabQuery,
} from "./settings-tabs-model";

describe("resolveSettingsTab", () => {
  it("已知 tab 原样返回", () => {
    expect(resolveSettingsTab("patrol", false)).toBe("patrol");
    expect(resolveSettingsTab("services", false)).toBe("services");
  });

  it("未知/缺失 → 默认 drives", () => {
    expect(resolveSettingsTab(null, false)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab(undefined, false)).toBe("drives");
    expect(resolveSettingsTab("nonsense", false)).toBe("drives");
  });

  it("account 仅在账号 tab 可见时可达，否则回落默认", () => {
    expect(resolveSettingsTab("account", true)).toBe("account");
    expect(resolveSettingsTab("account", false)).toBe("drives");
  });

  it("legacy 锚点 hash 映射到 account（tab 参数缺失时）", () => {
    expect(resolveSettingsTab(null, true, "#password")).toBe("account");
    expect(resolveSettingsTab(null, true, "#accounts")).toBe("account");
    expect(resolveSettingsTab(null, false, "#password")).toBe("drives");
    // 显式 tab 参数优先于 hash
    expect(resolveSettingsTab("patrol", true, "#password")).toBe("patrol");
  });
});

describe("settingsTabQuery", () => {
  it("写 tab 且保留既有参数（w 工作区）", () => {
    expect(settingsTabQuery(new URLSearchParams("w=abc"), "patrol")).toBe("tab=patrol&w=abc");
  });
  it("默认 tab 时删掉 tab 参数保持 URL 干净", () => {
    expect(settingsTabQuery(new URLSearchParams("tab=patrol&w=abc"), "drives")).toBe("w=abc");
  });
});

describe("SETTINGS_TABS", () => {
  it("五个 tab、顺序与标签固定", () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual(["drives", "services", "preferences", "patrol", "account"]);
    expect(SETTINGS_TABS.map((tab) => tab.label)).toEqual(["网盘", "资源与服务", "获取偏好", "巡检与通知", "账号"]);
  });
});
