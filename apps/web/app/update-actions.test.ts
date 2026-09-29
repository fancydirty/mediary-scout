import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("../lib/settings-attention-server", () => ({ resolveCurrentIsOwner: vi.fn(async () => true) }));
vi.mock("../lib/update-view-server", () => ({ loadUpdateView: vi.fn() }));
vi.mock("../lib/updater-client", () => ({ requestUpdate: vi.fn() }));
vi.mock("../lib/release-feed-server", () => ({ invalidateReleaseFeedCache: vi.fn() }));
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("../lib/workflow-runtime", () => ({
  AUTO_UPDATE_ENABLED_SETTING_KEY: "auto_update_enabled",
  AUTO_UPDATE_TIME_SETTING_KEY: "auto_update_time",
  AUTO_UPDATE_FAIL_STREAK_SETTING_KEY: "auto_update_fail_streak",
  getWorkflowRepository: () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => void settings.set(key, value),
  }),
}));

import { isDemoMode } from "../lib/demo-mode";
import { invalidateReleaseFeedCache } from "../lib/release-feed-server";
import { resolveCurrentIsOwner } from "../lib/settings-attention-server";
import { loadUpdateView } from "../lib/update-view-server";
import { requestUpdate } from "../lib/updater-client";
import { checkForUpdatesAction, saveAutoUpdateAction, startUpdateAction } from "./update-actions";

describe("startUpdateAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  it("forwards only the tag the current view offers", async () => {
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    vi.mocked(requestUpdate).mockResolvedValue({ ok: true });
    expect(await startUpdateAction("v2026.09.28")).toEqual({
      ok: false,
      message: "这个版本不是可更新的新版本，刷新页面再试。",
      reason: "stale",
    });
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(await startUpdateAction("v2026.10.02")).toEqual({ ok: true, message: "已开始更新。" });
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledWith("v2026.10.02");
  });

  it("marks the demo and non-owner refusals as denied", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect(await startUpdateAction("v2026.10.02")).toEqual({
      ok: false,
      message: "没有权限。",
      reason: "denied",
    });
    expect(loadUpdateView).not.toHaveBeenCalled();
    expect(resolveCurrentIsOwner).not.toHaveBeenCalled();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    expect(await startUpdateAction("v2026.10.02")).toEqual({
      ok: false,
      message: "没有权限。",
      reason: "denied",
    });
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("passes the updater's own reason through with its text", async () => {
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    for (const [reason, message] of [
      ["busy", "已经在更新了。"],
      ["no_updater", "一键更新需要先完成一次手动升级（见下方命令）。"],
      ["needs_recovery", "上次更新回退没成功，请先在部署目录运行 ./scripts/deploy.sh 恢复，再更新。"],
      ["serving_unknown", "部署目录被人手动换过版本。请在部署目录运行 ./scripts/deploy.sh，跑起来之后就能更新。"],
      ["bad_tag", "这个版本不是可更新的新版本，刷新页面再试。"],
      ["unreachable", "连不上更新助手，稍后再试。"],
    ] as const) {
      vi.mocked(requestUpdate).mockResolvedValue({ ok: false, reason });
      expect(await startUpdateAction("v2026.10.02")).toEqual({ ok: false, message, reason });
    }
  });
});

describe("startUpdateAction and the auto-update failure count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    settings.set("auto_update_fail_streak", JSON.stringify({ tag: "v2026.10.02", count: 2, at: "x" }));
  });

  it("a click that starts an update lets auto-update try again", async () => {
    vi.mocked(requestUpdate).mockResolvedValue({ ok: true });
    await startUpdateAction("v2026.10.02");
    expect(settings.get("auto_update_fail_streak")).toBe("");
  });

  it("a click that did not start anything keeps the count", async () => {
    vi.mocked(requestUpdate).mockResolvedValue({ ok: false, reason: "busy" });
    await startUpdateAction("v2026.10.02");
    await startUpdateAction("v2026.09.28"); // stale tag: never reaches the updater
    expect(JSON.parse(settings.get("auto_update_fail_streak") ?? "")).toMatchObject({ count: 2 });
  });
});

describe("saveAutoUpdateAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  it("saves the switch and the hour", async () => {
    expect(await saveAutoUpdateAction(true, "03:00")).toEqual({ ok: true, message: "已保存。" });
    expect(settings.get("auto_update_enabled")).toBe("1");
    expect(settings.get("auto_update_time")).toBe("03:00");
    expect(await saveAutoUpdateAction(false, "23:00")).toEqual({ ok: true, message: "已保存。" });
    expect(settings.get("auto_update_enabled")).toBe("0");
    expect(settings.get("auto_update_time")).toBe("23:00");
    expect((await saveAutoUpdateAction(true, "00:00")).ok).toBe(true);
  });

  it("takes whole hours only", async () => {
    for (const time of ["04:30", "24:00", "4:00", "04:00 ", "", "04", "ab:cd"]) {
      expect(await saveAutoUpdateAction(true, time)).toEqual({ ok: false, message: "时间只能选整点。" });
    }
    expect(settings.size).toBe(0);
  });

  it("refuses the demo and non-owners without writing anything", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect(await saveAutoUpdateAction(true, "04:00")).toEqual({ ok: false, message: "没有权限。" });
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    expect(await saveAutoUpdateAction(true, "04:00")).toEqual({ ok: false, message: "没有权限。" });
    expect(settings.size).toBe(0);
  });
});

describe("checkForUpdatesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  it("drops the cached release list at most once a minute", async () => {
    const now = vi.spyOn(Date, "now");
    let clock = 1_700_000_000_000;
    now.mockImplementation(() => clock);
    await checkForUpdatesAction();
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(2);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    clock += 61_000;
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});
