import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  demo: false,
  desktop: false,
  owner: true,
  password: true as boolean | "unknown",
  credential: "ic_secret",
  email: "owner@example.com",
  pending: null as unknown,
  order: "ord_1" as string | null,
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
  setConnectBinding: vi.fn(async (v: { token: string; hostname: string; boundAt: string }) => {
    state.stored.push(["tunnel", v.token], ["hostname", v.hostname], ["boundAt", v.boundAt]);
  }),
  getConnectTunnelToken: vi.fn(async () => null),
  getConnectPendingOrder: vi.fn(async () => state.order),
  setConnectPendingOrder: vi.fn(async (v: string) => { state.order = v; state.stored.push(["order", v]); }),
  clearConnectPendingOrder: vi.fn(async () => { state.order = null; state.cleared.push("order"); }),
}));

import { createConnectCheckout, exchangeClaimCode, getConnectAccount, getConnectOrderStatus, issueClaimCode, revokeInstanceLink } from "../lib/connect-client";
import { scoutConnectBaseUrl } from "../lib/remote-access";
import { startTunnel } from "../lib/updater-client";
import { getConnectLinkPending, setConnectBinding } from "../lib/connect-link-store";
import { connectAccountAction, connectBindAction, connectCheckoutAction, connectOrderStatusAction, connectPollLinkAction, connectUnlinkAction } from "./connect-actions";

beforeEach(() => {
  state.demo = false;
  state.desktop = false;
  state.owner = true;
  state.password = true;
  state.credential = "ic_secret";
  state.email = "owner@example.com";
  state.pending = null;
  state.order = "ord_1";
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

  it("uses the first forwarded host and proto behind a reverse proxy", async () => {
    state.headers = new Headers({
      host: "web:3000",
      "x-forwarded-host": "media.example.com, proxy.internal",
      "x-forwarded-proto": "https, http",
    });
    await connectCheckoutAction("year");
    expect(createConnectCheckout).toHaveBeenCalledWith("ic_secret", "year", "https://media.example.com/settings?tab=remote");
  });

  it("omits returnUrl when the host header is not a host", async () => {
    state.headers = new Headers({ host: "not a host", "x-forwarded-proto": "https" });
    await connectCheckoutAction("year");
    expect(createConnectCheckout).toHaveBeenCalledWith("ic_secret", "year", undefined);
  });
});

describe("connectPollLinkAction", () => {
  it("drops a stale answer when another tab started a newer link meanwhile", async () => {
    const older = { pollSecret: "poll-old", verifyCode: "AAAA", expiresAt: "2026-10-03T00:00:00Z", email: "old@example.com" };
    const newer = { pollSecret: "poll-new", verifyCode: "BBBB", expiresAt: "2026-10-03T00:00:00Z", email: "new@example.com" };
    vi.mocked(getConnectLinkPending).mockResolvedValueOnce(older).mockResolvedValueOnce(newer);
    expect(await connectPollLinkAction()).toEqual({ state: "pending" });
    expect(state.stored.filter(([key]) => key === "credential")).toEqual([]);
    expect(state.cleared).not.toContain("pending");
  });

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

  it("stores the tunnel token and hostname only after the updater started cloudflared", async () => {
    expect(await connectBindAction()).toEqual({ ok: true });
    expect(state.stored).toContainEqual(["tunnel", "tunnel-token"]);
    expect(state.stored).toContainEqual(["hostname", "owner.mediaryconnect.app"]);
    expect(vi.mocked(setConnectBinding).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(startTunnel).mock.invocationCallOrder[0]!,
    );
    const boundAt = state.stored.find(([key]) => key === "boundAt")?.[1];
    expect(Number.isFinite(Date.parse(boundAt ?? ""))).toBe(true);
  });

  it.each(["no_updater", "busy", "pull_failed", "compose_failed", "invalid_input"] as const)(
    "stores no tunnel state when the updater answers %s, so the page does not claim it is on",
    async (reason) => {
      vi.mocked(startTunnel).mockResolvedValue({ ok: false, reason });
      expect((await connectBindAction()).ok).toBe(false);
      expect(state.stored.filter(([key]) => key === "tunnel" || key === "hostname")).toEqual([]);
    },
  );

  it("never builds a fallback command from a claim code with shell syntax in it", async () => {
    vi.mocked(startTunnel).mockResolvedValue({ ok: false, reason: "no_updater" });
    vi.mocked(issueClaimCode).mockResolvedValueOnce({ ok: true, code: "claim.x; rm -rf ~", expires_at: "2026-10-03T00:10:00Z" });
    const result = await connectBindAction();
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("command");
    expect(vi.mocked(exchangeClaimCode)).not.toHaveBeenCalled();
  });

  it("puts only the origin of the Connect address into the fallback command", async () => {
    vi.mocked(startTunnel).mockResolvedValue({ ok: false, reason: "no_updater" });
    vi.mocked(scoutConnectBaseUrl).mockReturnValueOnce("https://connect.example/some/path?x=1");
    expect(await connectBindAction()).toEqual({
      ok: false,
      reason: "no_updater",
      command: "curl -fsSL https://connect.example/connect.sh | sh -s -- claim-code",
    });
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
  it("clears the local link and any order it was waiting on after Connect revoked the credential", async () => {
    expect(await connectUnlinkAction()).toEqual({ ok: true });
    expect(state.cleared).toEqual(expect.arrayContaining(["credential", "email", "pending", "order"]));
  });

  it("also clears it when Connect says the credential is already invalid", async () => {
    vi.mocked(revokeInstanceLink).mockResolvedValueOnce({ ok: false, reason: "unauthorized", message: "x" });
    expect(await connectUnlinkAction()).toEqual({ ok: true });
    expect(state.cleared).toContain("credential");
  });

  it("keeps the credential when Connect could not be reached, so 断开 can be retried", async () => {
    vi.mocked(revokeInstanceLink).mockResolvedValueOnce({ ok: false, reason: "unreachable", message: "x" });
    const result = await connectUnlinkAction();
    expect(result.ok).toBe(false);
    expect(state.cleared).not.toContain("credential");
  });
});

describe("a credential Connect no longer accepts", () => {
  it("is forgotten with its email and its pending order when the account is read", async () => {
    vi.mocked(getConnectAccount).mockResolvedValueOnce({ ok: false, reason: "unauthorized", message: "x" });
    expect(await connectAccountAction()).toEqual({ state: "unlinked" });
    expect(state.cleared).toEqual(expect.arrayContaining(["credential", "email", "order"]));
  });

  it("is forgotten while checking an order, and the wizard is told to start over", async () => {
    vi.mocked(getConnectOrderStatus).mockResolvedValueOnce({ ok: false, reason: "unauthorized", message: "x" });
    const result = await connectOrderStatusAction("ord_1");
    expect(result).toMatchObject({ ok: false, unlinked: true });
    expect(state.cleared).toEqual(expect.arrayContaining(["credential", "email", "order"]));
  });

  it("is kept when the order check failed for another reason, so polling can retry", async () => {
    vi.mocked(getConnectOrderStatus).mockResolvedValueOnce({ ok: false, reason: "unreachable", message: "x" });
    const result = await connectOrderStatusAction("ord_1");
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("unlinked", true);
    expect(state.cleared).toEqual([]);
  });
});

describe("pending order", () => {
  it("remembers the order a checkout created, so a reloaded page can keep checking it", async () => {
    await connectCheckoutAction("year");
    expect(state.stored).toContainEqual(["order", "ord_1"]);
  });

  it("keeps a newer order another tab created while an older one settled", async () => {
    state.order = "ord_new";
    vi.mocked(getConnectOrderStatus).mockResolvedValueOnce({ ok: true, status: "closed" });
    await connectOrderStatusAction("ord_old");
    expect(state.cleared).not.toContain("order");
  });

  it("forgets the order once it is fulfilled, closed or expired, and keeps it while pending", async () => {
    vi.mocked(getConnectOrderStatus).mockResolvedValueOnce({ ok: true, status: "pending" });
    await connectOrderStatusAction("ord_1");
    expect(state.cleared).not.toContain("order");
    for (const status of ["fulfilled", "closed", "expired"] as const) {
      state.cleared = [];
      state.order = "ord_1";
      vi.mocked(getConnectOrderStatus).mockResolvedValueOnce({ ok: true, status });
      await connectOrderStatusAction("ord_1");
      expect(state.cleared).toContain("order");
    }
  });
});
