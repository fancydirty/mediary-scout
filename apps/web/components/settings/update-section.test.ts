import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UpdateView } from "../../lib/update-state";
import type { UpdaterStatus } from "../../lib/updater-client";
import { nextPollStep } from "./update-actions";
import { ReleaseBlock, UpdateTab } from "./update-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

describe("ReleaseBlock", () => {
  it("gives every note a unique key, even when two notes share the same text", () => {
    const block = ReleaseBlock({
      release: {
        tag: "v2026.10.02",
        date: "2026-10-02",
        commit: "c".repeat(40),
        isCurrent: false,
        notes: [
          { kind: "fix", text: "修复 123 云盘的问题" },
          { kind: "fix", text: "修复 123 云盘的问题" },
        ],
      },
    });
    const list = (block.props as { children: ReactElement[] }).children.find(
      (child) => isValidElement(child) && child.type === "ul",
    ) as ReactElement<{ children: ReactElement[] }>;
    const keys = list.props.children.map((item) => item.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

const view = (overrides: Partial<UpdateView>): UpdateView => ({
  current: { label: "v2026.09.28", tag: "v2026.09.28" },
  available: null,
  status: "latest",
  releases: [],
  updater: null,
  updaterInstalled: false,
  download: null,
  ...overrides,
});
const newer = { tag: "v2026.10.02", date: "2026-10-02", commit: "c".repeat(40), notes: [] };
const DMG = "https://github.com/fancydirty/mediary-scout/releases/download/v2026.10.02/a.dmg";
const render = (props: { view: UpdateView; desktop: boolean; autoUpdate?: { enabled: boolean; time: string } }) =>
  renderToStaticMarkup(createElement(UpdateTab, { autoUpdate: { enabled: false, time: "04:00" }, ...props }));

describe("UpdateTab on desktop", () => {
  it("offers a one-click download of this platform's installer, and says how to install it", () => {
    const html = render({ desktop: true, view: view({ available: newer, status: "available", download: { url: DMG, file: "dmg" } }) });
    expect(html).toContain(`href="${DMG}"`);
    expect(html).toContain("下载新版本");
    expect(html).toContain("先从菜单栏图标退出巡影，再把新版拖进「应用程序」替换");
  });

  it("says what the Windows installer does", () => {
    const html = render({
      desktop: true,
      view: view({ available: newer, status: "available", download: { url: DMG.replace(".dmg", ".exe"), file: "exe" } }),
    });
    expect(html).toContain("下载后运行安装包，它会先关掉正在运行的巡影再安装");
  });

  it("shows nothing extra when already on the newest release", () => {
    const html = render({ desktop: true, view: view({}) });
    expect(html).not.toContain("下载新版本");
    expect(html).not.toContain("releases/latest");
  });

  it("points to the release page when it cannot tell", () => {
    expect(render({ desktop: true, view: view({ status: "offline" }) })).toContain("releases/latest");
    expect(render({ desktop: true, view: view({ status: "unknown" }) })).toContain("releases/latest");
  });

  it("never shows the desktop download on a Docker instance", () => {
    const html = render({ desktop: false, view: view({ available: newer, status: "available" }) });
    expect(html).not.toContain("下载新版本");
    expect(html).not.toContain("releases/latest");
  });
});

const FINISHED = "2026-10-02T20:00:00.000Z";
// The button itself; the auto-update note also names 「立即更新」.
const UPDATE_BUTTON = ">立即更新</button>";

function updater(overrides: Partial<UpdaterStatus>): UpdaterStatus {
  return {
    phase: "idle",
    targetTag: null,
    fromCommit: null,
    startedAt: null,
    finishedAt: null,
    message: "",
    logTail: "",
    ...overrides,
  };
}

function shanghai(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

describe("UpdateTab one-click update", () => {
  it("shows progress while an update is active even when no newer release is offered", () => {
    const html = render({
      desktop: false,
      view: view({
        available: null,
        status: "latest",
        updater: updater({ phase: "verifying", message: "正在检查新版本是否正常。" }),
      }),
    });
    expect(html).toContain("正在检查新版本是否正常。");
    expect(html).toContain("update-bar");
    expect(html).not.toContain(UPDATE_BUTTON);
    expect(html).not.toContain("检查更新");
  });

  it("offers 立即更新 only on Docker, with an updater and a newer release, and not while one is running", () => {
    const ready = view({ available: newer, status: "available", updater: updater({ phase: "idle" }) });
    expect(render({ desktop: false, view: ready })).toContain(UPDATE_BUTTON);
    const building = render({
      desktop: false,
      view: view({
        available: newer,
        status: "available",
        updater: updater({ phase: "building", message: "正在构建新版本，构建期间一切照常。" }),
      }),
    });
    expect(building).toContain("正在构建新版本，构建期间一切照常。");
    expect(building).not.toContain(UPDATE_BUTTON);
    expect(render({ desktop: false, view: view({ updater: updater({ phase: "idle" }) }) })).not.toContain(UPDATE_BUTTON);
    expect(render({ desktop: true, view: { ...ready, download: { url: DMG, file: "dmg" } } })).not.toContain(UPDATE_BUTTON);
  });

  it("says the updater is not answering, without the migration command, when it is installed", () => {
    const html = render({ view: view({ available: newer, status: "available", updaterInstalled: true }), desktop: false });
    expect(html).toContain("更新助手暂时没有回应，稍后刷新再试。");
    expect(html).not.toContain("一键更新需要先完成一次手动升级");
    expect(html).not.toContain("./scripts/deploy.sh");
    expect(html).not.toContain(UPDATE_BUTTON);
  });

  it("tells a Docker instance with no updater to run deploy.sh once", () => {
    const html = render({ desktop: false, view: view({ available: newer, status: "available" }) });
    expect(html).toContain("一键更新需要先完成一次手动升级。在部署目录运行：");
    expect(html).toContain("./scripts/deploy.sh");
    expect(html).toContain("复制");
    expect(html).not.toContain("git pull");
    expect(html).not.toContain(UPDATE_BUTTON);
  });

  it("does not offer 立即更新 after a failed rollback, only the recovery message", () => {
    const html = render({
      desktop: false,
      view: view({
        available: newer,
        status: "available",
        updaterInstalled: true,
        updater: updater({
          phase: "failed",
          message: "新版本没通过自检，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。",
          needsManualRecovery: true,
          finishedAt: FINISHED,
        }),
      }),
    });
    expect(html).not.toContain(UPDATE_BUTTON);
    expect(html).toContain("自动回退也没成功");
  });

  it("does not offer 立即更新 while the deploy folder was changed by hand, only the reason", () => {
    const html = render({
      desktop: false,
      view: view({
        available: newer,
        status: "available",
        updaterInstalled: true,
        updater: updater({
          phase: "failed",
          message: "更新被中断了，之后部署目录被人手动换过版本，更新助手没有再改动它。请在部署目录运行 ./scripts/deploy.sh，跑起来之后就能再更新。",
          servingUnknown: true,
          finishedAt: FINISHED,
        }),
      }),
    });
    expect(html).not.toContain(UPDATE_BUTTON);
    expect(html).toContain("被人手动换过版本");
  });

  it("shows an amber failure line and the log tail", () => {
    for (const phase of ["rolled_back", "failed"] as const) {
      const html = render({
        desktop: false,
        view: view({
          updater: updater({ phase, message: "失败说明", logTail: "line-from-log", finishedAt: FINISHED }),
        }),
      });
      expect(html).toContain("update-warn");
      expect(html).toContain("失败说明");
      expect(html).toContain("查看详情");
      expect(html).toContain("line-from-log");
    }
  });

  it("shows when the last update finished and how it ended", () => {
    const done = render({
      desktop: false,
      view: view({ updater: updater({ phase: "done", finishedAt: FINISHED, message: "更新完成。" }) }),
    });
    expect(done).toContain(`上次更新：${shanghai(FINISHED)} · 成功`);
    const rolled = render({
      desktop: false,
      view: view({ updater: updater({ phase: "rolled_back", finishedAt: FINISHED, message: "已回滚" }) }),
    });
    expect(rolled).toContain(`上次更新：${shanghai(FINISHED)} · 已回滚`);
    const failed = render({
      desktop: false,
      view: view({ updater: updater({ phase: "failed", finishedAt: FINISHED, message: "没成功" }) }),
    });
    expect(failed).toContain(`上次更新：${shanghai(FINISHED)} · 没成功`);
  });

  it("offers 检查更新 on Docker when already up to date", () => {
    const html = render({ desktop: false, view: view({}) });
    expect(html).toContain("已是最新");
    expect(html).toContain("检查更新");
    expect(html).not.toContain(UPDATE_BUTTON);
    expect(html).not.toContain("./scripts/deploy.sh");
  });

  it("leaves the desktop branch without the Docker update controls", () => {
    const html = render({
      desktop: true,
      view: view({
        available: newer,
        status: "available",
        download: { url: DMG, file: "dmg" },
        updater: updater({ phase: "idle", finishedAt: FINISHED }),
      }),
    });
    expect(html).toContain("下载新版本");
    expect(html).toContain("先从菜单栏图标退出巡影，再把新版拖进「应用程序」替换");
    expect(html).not.toContain(UPDATE_BUTTON);
    expect(html).not.toContain("检查更新");
    expect(html).not.toContain("./scripts/deploy.sh");
    expect(html).not.toContain("上次更新");
  });
});

describe("nextPollStep", () => {
  const status = (phase: UpdaterStatus["phase"]): UpdaterStatus => ({
    phase,
    targetTag: "v2026.10.02",
    fromCommit: null,
    startedAt: null,
    finishedAt: null,
    message: "",
    logTail: "",
  });
  it("keeps waiting when the updater does not answer, instead of dropping the progress", () => {
    expect(nextPollStep(null, false)).toBe("wait");
    expect(nextPollStep(null, true)).toBe("wait");
  });
  it("reloads once the update is over, or once the page came back after being down", () => {
    expect(nextPollStep(status("done"), false)).toBe("reload");
    expect(nextPollStep(status("rolled_back"), false)).toBe("reload");
    expect(nextPollStep(status("verifying"), true)).toBe("reload");
  });
  it("shows the new step while the update runs", () => {
    expect(nextPollStep(status("building"), false)).toBe("show");
  });
});

describe("UpdateTab auto-update switch", () => {
  const withUpdater = view({ updater: updater({ phase: "idle" }), updaterInstalled: true });

  it("shows the switch and the hour on Docker when the updater is installed", () => {
    const html = render({ desktop: false, view: withUpdater, autoUpdate: { enabled: true, time: "13:00" } });
    expect(html).toContain("每天自动更新");
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/);
    expect(html).toContain('<option value="00:00">00:00</option>');
    expect(html).toContain('<option value="13:00" selected="">13:00</option>');
    expect(html).toContain('<option value="23:00">23:00</option>');
    expect(html).toContain("有获取任务在进行时会等它结束");
    expect(html).toContain("连续两次");
  });

  it("shows it switched off, at the saved hour", () => {
    const html = render({ desktop: false, view: withUpdater, autoUpdate: { enabled: false, time: "04:00" } });
    expect(html).toContain('role="switch"');
    expect(html).not.toMatch(/role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/);
    expect(html).toContain('<option value="04:00" selected="">04:00</option>');
  });

  it("shows it even while an update is running or after a failed one", () => {
    for (const phase of ["building", "failed", "rolled_back", "done"] as const) {
      const html = render({ desktop: false, view: view({ updater: updater({ phase }), updaterInstalled: true }) });
      expect(html).toContain("每天自动更新");
    }
  });

  it("is not there on desktop, without an updater, or in the old-compose migration state", () => {
    expect(render({ desktop: true, view: withUpdater })).not.toContain("每天自动更新");
    expect(render({ desktop: false, view: view({}) })).not.toContain("每天自动更新");
    expect(render({ desktop: false, view: view({ available: newer, status: "available" }) })).not.toContain("每天自动更新");
  });

  it("is there when the updater is installed but did not answer just now", () => {
    const html = render({ desktop: false, view: view({ available: newer, status: "available", updaterInstalled: true }) });
    expect(html).toContain("每天自动更新");
  });
});
