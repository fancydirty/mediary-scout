import { describe, expect, it } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb } from "./db.js";
import { buildSessionCookie, SESSION_COOKIE } from "./session.js";

const BASE = "https://mediaryconnect.app";
const SECRET = "f".repeat(64);

function deps(): RouteDeps {
  return {
    db: createMemoryConnectDb(),
    cf: {} as never,
    adminToken: "t",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => "2026-07-28T00:00:00.000Z",
    newInviteId: () => "inv_x",
    newEndpointId: () => "ep_x",
    newAuditId: () => "aud_x",
    newInviteCode: () => "code_x",
    newAccountId: () => "act_x",
    newEntitlementId: () => "ent_x",
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
  };
}

async function cookie(): Promise<string> {
  const c = await buildSessionCookie("act_1", { secret: SECRET, ttlMs: 3600_000, now: Date.parse("2026-07-28T00:00:00.000Z") });
  return `${SESSION_COOKIE}=${c.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]}`;
}

describe("GET /api/slug/check", () => {
  it("401 without session", async () => {
    const res = await handleRequest(new Request(`${BASE}/api/slug/check?s=alice`), deps());
    expect(res.status).toBe(401);
  });

  it("available for a fresh slug", async () => {
    const res = await handleRequest(
      new Request(`${BASE}/api/slug/check?s=charlie`, { headers: { cookie: await cookie() } }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("taken slug (including revoked) returns unavailable + suggestions", async () => {
    const d = deps();
    // 一条 revoked 的 endpoint 也占用 slug（永久保留）
    await d.db.insertEndpoint({
      id: "ep_1", invite_id: "inv_1", slug: "alice", hostname: "alice.mediaryconnect.app",
      cf_tunnel_id: "t", cf_access_app_id: null, cf_access_policy_id: null,
      cf_dns_record_id: "d", status: "revoked", token_sha256: "x",
      token_ciphertext: null, token_shown_at: null, last_seen_at: null,
      created_at: "2026-01-01T00:00:00.000Z", revoked_at: "2026-02-01T00:00:00.000Z",
    });
    const res = await handleRequest(
      new Request(`${BASE}/api/slug/check?s=alice`, { headers: { cookie: await cookie() } }),
      d,
    );
    const body = (await res.json()) as { available: boolean; reason?: string; suggestions?: string[] };
    expect(body.available).toBe(false);
    expect(body.reason).toBe("taken");
    expect(body.suggestions!.length).toBeGreaterThan(0);
  });

  it("reserved slug returns unavailable", async () => {
    const res = await handleRequest(
      new Request(`${BASE}/api/slug/check?s=admin`, { headers: { cookie: await cookie() } }),
      deps(),
    );
    const body = (await res.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBe("reserved");
  });
});
