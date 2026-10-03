import { describe, expect, it } from "vitest";
import { createMemoryConnectDb } from "./db.js";
import { handleRequest, type RouteDeps } from "./routes.js";
import { sha256Hex } from "./crypto-token.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-10-03T00:00:00.000Z";
const SECRET = "e".repeat(64);

function setup() {
  const db = createMemoryConnectDb();
  const sent: Array<{ to: string; details: { url: string; verifyCode: string; requestIp: string; requestedAt: string } }> = [];
  const deps: RouteDeps = {
    db,
    cf: {} as never,
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => NOW,
    newInviteId: () => "inv_x",
    newEndpointId: () => "ep_x",
    newAuditId: () => "aud_x",
    newInviteCode: () => "code_x",
    newAccountId: () => "act_link",
    newEntitlementId: () => "ent_x",
    sessionSecret: SECRET,
    sendMagicLink: async () => undefined,
    sendInstanceLinkEmail: async (to, details) => { sent.push({ to, details }); },
  } as RouteDeps;
  return { deps, sent };
}

async function start(deps: RouteDeps, email = "alice@example.com", headers: Record<string, string> = {}) {
  return handleRequest(new Request(`${BASE}/api/instance-link/start`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email }),
  }), deps);
}

async function startData(deps: RouteDeps, email = "alice@example.com") {
  const response = await start(deps, email);
  expect(response.status).toBe(202);
  return response.json() as Promise<{ pollSecret: string; verifyCode: string; expiresAt: string; interval: number }>;
}

describe("instance-link start", () => {
  it("returns a poll secret and emails one confirmation URL while storing only its hash", async () => {
    const { deps, sent } = setup();
    const result = await startData(deps);
    expect(result.pollSecret.length).toBeGreaterThanOrEqual(43);
    expect(result.verifyCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    expect(result.interval).toBe(3);
    expect(result.expiresAt).toBe("2026-10-03T00:30:00.000Z");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.details.url).toContain("/link?t=");
    const row = await deps.db.getInstanceLinkRequestByPollSecretSha(await sha256Hex(result.pollSecret));
    expect(row?.email).toBe("alice@example.com");
    expect(row?.poll_secret_sha256).toBe(await sha256Hex(result.pollSecret));
    expect(JSON.stringify(row)).not.toContain(result.pollSecret);
    expect(sent[0]!.details.verifyCode).toBe(result.verifyCode);
  });

  it("rejects invalid email and applies independent email/IP windows", async () => {
    const { deps } = setup();
    const invalid = await start(deps, "nope");
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect((await start(deps, "a@example.com")).status).toBe(202);
    expect((await start(deps, "a@example.com")).status).toBe(202);
    expect((await start(deps, "a@example.com")).status).toBe(429);

    const other = setup();
    for (let i = 0; i < 5; i++) expect((await start(other.deps, `user${i}@example.com`, { "cf-connecting-ip": "192.0.2.1" })).status).toBe(202);
    expect((await start(other.deps, "user5@example.com", { "cf-connecting-ip": "192.0.2.1" })).status).toBe(429);
  });

  it("refuses a browser cross-site request before writing or sending", async () => {
    const { deps, sent } = setup();
    const res = await start(deps, "alice@example.com", { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(await deps.db.getAccountByEmail("alice@example.com")).toBeNull();
  });

  it("still returns 202 when email delivery fails", async () => {
    const { deps } = setup();
    deps.sendInstanceLinkEmail = async () => { throw new Error("mail down"); };
    expect((await start(deps)).status).toBe(202);
  });
});

describe("instance-link confirmation and polling", () => {
  it("renders a pending page, confirms same-origin, delivers exactly once, and revokes", async () => {
    const { deps, sent } = setup();
    const data = await startData(deps);
    const token = new URL(sent[0]!.details.url).searchParams.get("t")!;
    const page = await handleRequest(new Request(`${BASE}/link?t=${encodeURIComponent(token)}`), deps);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(data.verifyCode);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await handleRequest(new Request(`${BASE}/link`, {
      method: "POST", headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ t: token }),
    }), deps)).status).toBe(200);
    const account = await deps.db.getAccountByEmail("alice@example.com");
    expect(account).not.toBeNull();
    const cookie = (await handleRequest(new Request(`${BASE}/link`, {
      method: "POST", headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ t: token }),
    }), deps));
    expect(cookie.status).toBe(409);

    const poll = await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: data.pollSecret }),
    }), deps);
    expect(poll.status).toBe(200);
    const approved = await poll.json() as { status: string; credential: string; email: string };
    expect(approved.status).toBe("approved");
    expect(approved.email).toBe("alice@example.com");
    expect(approved.credential).toMatch(/^ic_[A-Za-z0-9_-]{43,}$/);
    expect((await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: data.pollSecret }),
    }), deps)).status).toBe(410);

    const revoke = await handleRequest(new Request(`${BASE}/api/instance-link/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${approved.credential}` },
    }), deps);
    expect(revoke.status).toBe(200);
    expect((await handleRequest(new Request(`${BASE}/api/instance-link/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${approved.credential}` },
    }), deps)).status).toBe(401);
  });

  it("revokes the previous credential when the same account links again", async () => {
    const { deps, sent } = setup();
    const first = await startData(deps);
    const firstToken = new URL(sent[0]!.details.url).searchParams.get("t")!;
    await handleRequest(new Request(`${BASE}/link`, {
      method: "POST", headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ t: firstToken }),
    }), deps);
    const firstPoll = await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: first.pollSecret }),
    }), deps);
    const firstCredential = (await firstPoll.json() as { credential: string }).credential;

    const second = await startData(deps, "alice@example.com");
    const secondToken = new URL(sent[1]!.details.url).searchParams.get("t")!;
    await handleRequest(new Request(`${BASE}/link`, {
      method: "POST", headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ t: secondToken }),
    }), deps);
    const secondPoll = await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: second.pollSecret }),
    }), deps);
    const secondCredential = (await secondPoll.json() as { credential: string }).credential;

    expect(await deps.db.getActiveInstanceCredentialBySha(await sha256Hex(firstCredential))).toBeNull();
    expect(await deps.db.getActiveInstanceCredentialBySha(await sha256Hex(secondCredential))).not.toBeNull();
  });

  it("returns unknown, pending, slow_down, expiry, and rejects cross-site confirmation", async () => {
    const { deps, sent } = setup();
    expect((await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: "unknown" }),
    }), deps)).status).toBe(404);
    const data = await startData(deps);
    const pending = await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: data.pollSecret }),
    }), deps);
    expect(pending.status).toBe(200);
    expect((await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: data.pollSecret }),
    }), deps)).status).toBe(429);
    const token = new URL(sent[0]!.details.url).searchParams.get("t")!;
    const blocked = await handleRequest(new Request(`${BASE}/link`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "same-site" }, body: JSON.stringify({ t: token }),
    }), deps);
    expect(blocked.status).toBe(403);
    expect(await deps.db.getAccountByEmail("alice@example.com")).toBeNull();
  });

  it("returns expired when the confirmation POST arrives at the request expiry", async () => {
    const { deps, sent } = setup();
    let now = NOW;
    deps.now = () => now;
    await startData(deps);
    const token = new URL(sent[0]!.details.url).searchParams.get("t")!;
    now = "2026-10-03T00:30:00.001Z";
    const response = await handleRequest(new Request(`${BASE}/link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ t: token }),
    }), deps);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "expired" });
  });

  it("returns expired instead of slow_down once a pending request has expired", async () => {
    const { deps } = setup();
    let now = NOW;
    deps.now = () => now;
    const data = await startData(deps);
    now = "2026-10-03T00:29:59.000Z";
    const first = await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: data.pollSecret }),
    }), deps);
    expect(first.status).toBe(200);
    now = "2026-10-03T00:30:00.001Z";
    const expired = await handleRequest(new Request(`${BASE}/api/instance-link/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pollSecret: data.pollSecret }),
    }), deps);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ status: "expired" });
  });
});
