import { describe, it, expect } from "vitest";
import { shouldShowConnectNotice } from "./connect-notice";
import type { ConnectNoticeConditions } from "./connect-notice";

describe("shouldShowConnectNotice", () => {
  const baseConditions: ConnectNoticeConditions = {
    isDemo: false,
    accountId: "acc_123",
    dismissedAt: null,
    hasTunnelToken: false,
  };

  it("shows when all conditions are met", () => {
    expect(shouldShowConnectNotice(baseConditions)).toBe(true);
  });

  it("hides in demo mode", () => {
    expect(shouldShowConnectNotice({ ...baseConditions, isDemo: true })).toBe(false);
  });

  it("hides when not logged in", () => {
    expect(shouldShowConnectNotice({ ...baseConditions, accountId: null })).toBe(false);
  });

  it("hides when already dismissed", () => {
    expect(shouldShowConnectNotice({ ...baseConditions, dismissedAt: "2026-08-01T12:00:00Z" })).toBe(
      false
    );
  });

  it("hides when tunnel token exists", () => {
    expect(shouldShowConnectNotice({ ...baseConditions, hasTunnelToken: true })).toBe(false);
  });

  it("hides when multiple conditions fail", () => {
    expect(
      shouldShowConnectNotice({
        isDemo: true,
        accountId: null,
        dismissedAt: "2026-08-01T12:00:00Z",
        hasTunnelToken: true,
      })
    ).toBe(false);
  });
});
