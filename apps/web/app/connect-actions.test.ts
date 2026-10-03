import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  demo: false,
  desktop: false,
  owner: true,
  password: true as boolean | "unknown",
  credential: "ic_secret",
  email: "owner@example.com",
  pending: null as unknown,
  stored: [] as Array<[string, string]>,
  cleared: [] as string[],
  headers: new Headers({ host: "scout.local:3000", "x-forwarded-proto": "https" }),
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => state.headers) }));
vi.mock("../lib/demo-mode", () => ({
  assertNotDemo: vi.fn(() => {
    if (state.demo) throw new Error("demo");
  }),
}));
vi.mock("../lib/workflow-runtime", () => ({
  hasLoginPassword: vi.fn(async () => state.password),
  isMultiUserEnabled: vi.fn(() => false),
  resolveIsDesktop: vi.fn(() => state.desktop),
}));
vi.mock("../lib/settings-attention-server", () => ({ resolveCurrentIsOwner: vi.fn(async () => state.owner) }));
vi.mock("../lib/remote-access", () => ({
  scoutConnectBaseUrl: vi.fn(() => "https://connect.example"),
}));
vi.mock("../lib/connect-client", () => ({
  startInstanceLink: vi.fn(async () => ({ ok: true, pollSecret: "poll", verifyCode: "ABCD", expiresAt: "2026-10-03T00:00:00Z" })),
  pollInstanceLink: vi.fn(async () => ({ ok: true, status: "approved", credential: "ic_new", email: "owner@example.com" })),
  revokeInstanceLink: vi.fn(async () => ({ ok: true })),
  getConnectAccount: vi.fn(async () => ({ ok: true, email: "owner@example.com", active: true, expiresAt: null, endpoint: null, checkoutOpen: true, tiers: [] })),
  createConnectCheckout: vi.fn(async () => ({ ok: true, checkoutUrl: "https://pay.example/order", orderId: "ord_1" })),
  getConnectOrderStatus: vi.fn(async () => ({ ok: true, status: "fulfilled" })),
  checkConnectSlug: vi.fn(async () => ({ ok: true, available: true, suggestions: [] })),
  provisionConnectSlug: vi.fn(async () => ({ ok: true, hostname: "owner.mediaryconnect.app" })),
  issueClaimCode: vi.fn(async () => ({ ok: true, code: "claim-code", expiresAt: "2026-10-03T00:10:00Z" })),
  exchangeClaimCode: vi.fn(async () => ({ ok: true, hostname: "owner.mediaryconnect.app", token: "tunnel-token" })),
}));
vi.mock("../lib/updater-client", () => ({ startTunnel: vi.fn(async () => ({ ok: true })) }));
vi.mock("../lib/connect-link-store", () => ({
  getConnectInstanceCredential: vi.fn(async () => state.credential),
  setConnectInstanceCredential: vi.fn(async (v: string) => { state.credential = v; state.stored.push(["credential", v]); }),
  clearConnectInstanceCredential: vi.fn(async () => { state.credential = null as never; state.cleared.push("credential"); }),
  getConnectAccountEmail: vi.fn(async () => state.email),
  setConnectAccountEmail: vi.fn(async (v: string) => { state.email = v; state.stored.push(["email", v]); }),
  clearConnectAccountEmail: vi.fn(async () => { state.email = null as never; state.cleared.push("email"); }),
  getConnectLinkPending: vi.fn(async () => state.pending),
  setConnectLinkPending: vi.fn(async (v: unknown) => { state.pending = v; state.stored.push(["pending", JSON.stringify(v)]); }),
  clearConnectLinkPending: vi.fn(async () => { state.pending = null; state.cleared.push("pending"); }),
  setConnectTunnelToken: vi.fn(async (v: string) => { state.stored.push(["tunnel", v]); }),
  setConnectHostname: vi.fn(async (v: string) => { state.stored.push(["hostname", v]); }),
  getConnectTunnelToken: vi.fn(async () => null),
}));

import { createConnectCheckout } from "../lib/connect-client";
import { startTunnel } from "../lib/updater-client";
import { connectBindAction, connectCheckoutAction, connectPollLinkAction, connectUnlinkAction } from "./connect-actions";

beforeEach(() => {
  state.demo = false;
  state.desktop = false;
  state.owner = true;
  state.password = true;
  state.credential = "ic_secret";
  state.email = "owner@example.com";
  state.pending = null;
  state.stored = [];
  state.cleared = [];
  state.headers = new Headers({ host: "scout.local:3000", "x-forwarded-proto": "https" });
  vi.clearAllMocks();
});

describe("connect actions common guards", () => {
  it("refuses demo, desktop, and non-owner calls before network or storage", async () => {
    state.demo = true;
    expect((await connectCheckoutAction("year")).ok).toBe(false);
    state.demo = false;
    state.desktop = true;
    expect((await connectCheckoutAction("year")).ok).toBe(false);
    state.desktop = false;
    state.owner = false;
    expect((await connectCheckoutAction("year")).ok).toBe(false);
    expect(createConnectCheckout).not.toHaveBeenCalled();
  });
});

describe("connectCheckoutAction", () => {
  it("builds a same-instance returnUrl from a valid host", async () => {
    const result = await connectCheckoutAction("year");
    expect(result).toEqual({ ok: true, checkoutUrl: "https://pay.example/order", orderId: "ord_1" });
    expect(createConnectCheckout).toHaveBeenCalledWith("ic_secret", "year", "https://scout.local:3000/settings?tab=remote");
  });

  it("omits returnUrl when the host header is not a host", async () => {
    state.headers = new Headers({ host: "not a host", "x-forwarded-proto": "https" });
    await connectCheckoutAction("year");
    expect(createConnectCheckout).toHaveBeenCalledWith("ic_secret", "year", undefined);
  });
});

describe("connectPollLinkAction", () => {
  it("clears the pending link and stores a credential after approval", async () => {
    state.pending = { pollSecret: "poll", verifyCode: "ABCD", expiresAt: "2026-10-03T00:00:00Z", email: "owner@example.com" };
    expect(await connectPollLinkAction()).toEqual({ state: "linked" });
    expect(state.stored).toContainEqual(["credential", "ic_new"]);
    expect(state.cleared).toContain("pending");
  });
});

describe("connectBindAction", () => {
  it("requires a password when the tri-state result is false or unknown", async () => {
    state.password = false;
    expect(await connectBindAction()).toEqual({ ok: false, reason: "password_required" });
    state.password = "unknown";
    expect(await connectBindAction()).toEqual({ ok: false, reason: "password_required" });
  });

  it("stores exchanged credentials before starting the updater", async () => {
    expect(await connectBindAction()).toEqual({ ok: true });
    expect(state.stored.findIndex(([key]) => key === "tunnel")).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(startTunnel).mock.invocationCallOrder[0]).toBeGreaterThan(
      state.stored.findIndex(([key]) => key === "hostname"),
    );
  });

  it("returns a fallback command when the updater is absent", async () => {
    vi.mocked(startTunnel).mockResolvedValue({ ok: false, reason: "no_updater" });
    expect(await connectBindAction()).toEqual({
      ok: false,
      reason: "no_updater",
      command: "curl -fsSL https://connect.example/connect.sh | sh -s -- claim-code",
    });
  });

  it("uses actionable Chinese messages for invalid and compose failures", async () => {
    vi.mocked(startTunnel).mockResolvedValue({ ok: false, reason: "invalid_input" });
    expect(await connectBindAction()).toEqual({
      ok: false,
      reason: "invalid_input",
      message: "接入凭据格式不对，请点「重新接入」再试。",
    });
    vi.mocked(startTunnel).mockResolvedValue({ ok: false, reason: "compose_failed" });
    expect(await connectBindAction()).toEqual({
      ok: false,
      reason: "compose_failed",
      message: "隧道没有启动成功，请稍后点「重新接入」再试。",
    });
  });
});

describe("connectUnlinkAction", () => {
  it("clears the credential even when revoke fails", async () => {
    await connectUnlinkAction();
    expect(state.cleared).toEqual(expect.arrayContaining(["credential", "email", "pending"]));
  });
});
