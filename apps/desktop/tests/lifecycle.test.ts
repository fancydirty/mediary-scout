import { describe, it, expect } from "vitest";
import { onWindowClose, trayMenuState, type TrayItem } from "../src/lifecycle.js";

describe("onWindowClose", () => {
  it("hides the window (prevents close) during normal use", () => {
    expect(onWindowClose({ isQuitting: false })).toEqual({ preventDefault: true, hideWindow: true });
  });
  it("allows the real close when the app is quitting", () => {
    expect(onWindowClose({ isQuitting: true })).toEqual({ preventDefault: false, hideWindow: false });
  });
});

describe("trayMenuState", () => {
  const ids = (items: TrayItem[]) => items.map((i) => i.id);

  it("exposes open / status / openAtLogin / quit items", () => {
    const state = trayMenuState({ openAtLogin: true, serverReady: true });
    expect(ids(state.items)).toEqual(["open", "status", "openAtLogin", "quit"]);
  });
  it("reflects the login-item checkbox", () => {
    expect(trayMenuState({ openAtLogin: true, serverReady: true }).items.find((i) => i.id === "openAtLogin")?.checked).toBe(true);
    expect(trayMenuState({ openAtLogin: false, serverReady: true }).items.find((i) => i.id === "openAtLogin")?.checked).toBe(false);
  });
  it("shows a running/stopped status label that is disabled (informational)", () => {
    const running = trayMenuState({ openAtLogin: false, serverReady: true }).items.find((i) => i.id === "status");
    const stopped = trayMenuState({ openAtLogin: false, serverReady: false }).items.find((i) => i.id === "status");
    expect(running?.enabled).toBe(false);
    expect(stopped?.enabled).toBe(false);
    expect(running?.label).not.toBe(stopped?.label); // different text for the two states
  });
  it("openAtLogin is a checkbox, others are normal", () => {
    const state = trayMenuState({ openAtLogin: false, serverReady: true });
    expect(state.items.find((i) => i.id === "openAtLogin")?.type).toBe("checkbox");
    expect(state.items.find((i) => i.id === "open")?.type).toBe("normal");
  });
});
