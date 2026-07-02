import { describe, expect, it } from "vitest";
import { driveConnectionBadge } from "./settings-badge";

// Issue #93: the 网盘连接 section header badge read ONLY the 115 status, so a
// user whose only drive is 光鸭/夸克 saw a permanent misleading 未连接 while the
// per-drive rows below were correct. The badge must derive from ALL drives.
describe("driveConnectionBadge", () => {
  it("shows 已连接 with the drive count when any non-frozen drive exists (non-115 included)", () => {
    expect(
      driveConnectionBadge({ envConnected: false, drives: [{ status: "active" }] }),
    ).toEqual({ tone: "green", label: "已连接 1 块盘" });
    expect(
      driveConnectionBadge({
        envConnected: false,
        drives: [{ status: "active" }, { status: "active" }, { status: "frozen" }],
      }),
    ).toEqual({ tone: "green", label: "已连接 2 块盘" });
  });

  it("all drives frozen → amber 全部掉线 (rows below carry the detail)", () => {
    expect(
      driveConnectionBadge({ envConnected: false, drives: [{ status: "frozen" }] }),
    ).toEqual({ tone: "amber", label: "已连接但掉线" });
  });

  it("no drives but legacy .env 115 cookie → 已连接（.env）", () => {
    expect(driveConnectionBadge({ envConnected: true, drives: [] })).toEqual({
      tone: "green",
      label: "已连接（.env）",
    });
  });

  it("nothing connected → 未连接", () => {
    expect(driveConnectionBadge({ envConnected: false, drives: [] })).toEqual({
      tone: "amber",
      label: "未连接",
    });
  });
});
