import { describe, it, expect } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import type { CfApi } from "./cf-api.js";

const BASE = "https://mediaryconnect.app";
const ADMIN = "test-admin-token-fixture";
const WRAP_KEY = "00".repeat(32);
const NOW = "2026-07-24T10:00:00.000Z";
const FIXTURE_TOKEN_1 = "fixture-tunnel-token-1";

interface CfCall {
  method: string;
  args: unknown[];
}

function makeFakeCf(): { cf: CfApi; calls: CfCall[] } {
  const calls: CfCall[] = [];
  let tunnels = 0;
  const rec = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const cf: CfApi = {
    async createTunnel(name) {
      rec("createTunnel", name);
      tunnels += 1;
      return { tunnelId: `tid-${tunnels}`, token: `fixture-tunnel-token-${tunnels}` };
    },
    async putTunnelIngress(tunnelId, hostname) {
      rec("putTunnelIngress", tunnelId, hostname);
    },
    async createDnsCname(slug, tunnelId) {
      rec("createDnsCname", slug, tunnelId);
      return { recordId: `rec-${slug}` };
    },
    async createAccessApp(input) {
      rec("createAccessApp", input);
      return { appId: `app-${input.domain}`, policyId: "pol-1" };
    },
    async deleteTunnel(tunnelId) {
      rec("deleteTunnel", tunnelId);
    },
    async deleteDnsRecord(recordId) {
      rec("deleteDnsRecord", recordId);
    },
    async deleteAccessApp(appId) {
      rec("deleteAccessApp", appId);
    },
  };
  return { cf, calls };
}

function makeDeps(db: ConnectDb, cf: CfApi): RouteDeps {
  let n = 0;
  const seq =
    (prefix: string) =>
    (): string => {
      n += 1;
      return `${prefix}_${n}`;
    };
  return {
    db,
    cf,
    adminToken: ADMIN,
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: WRAP_KEY,
    now: () => NOW,
    newInviteId: seq("inv"),
    newEndpointId: seq("ep"),
    newAuditId: seq("aud"),
    newInviteCode: seq("code"),
  };
}

function setup(): { db: ConnectDb; calls: CfCall[]; deps: RouteDeps } {
  const db = createMemoryConnectDb();
  const { cf, calls } = makeFakeCf();
  return { db, calls, deps: makeDeps(db, cf) };
}

function adminPost(path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

function adminGet(path: string): Request {
  return new Request(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${ADMIN}` },
  });
}

async function createInviteViaApi(deps: RouteDeps, body: unknown): Promise<Response> {
  return handleRequest(adminPost("/api/admin/invites", body), deps);
}

async function provisionViaApi(
  deps: RouteDeps,
  inviteId: string,
  body?: unknown,
): Promise<Response> {
  return handleRequest(adminPost(`/api/admin/invites/${inviteId}/provision`, body), deps);
}

interface InviteCreated {
  id: string;
  code: string;
  inviteUrl: string;
}

interface ProvisionOk {
  hostname: string;
  token: string;
  agentPrompt: string;
  inviteUrl: string;
}

/** Creates an invite (slug "alice") and provisions it through the HTTP routes. */
async function seedProvisioned(deps: RouteDeps): Promise<InviteCreated & ProvisionOk> {
  const createRes = await createInviteViaApi(deps, { email: "alice@example.com", slug: "alice" });
  const created = (await createRes.json()) as InviteCreated;
  const provRes = await provisionViaApi(deps, created.id);
  const prov = (await provRes.json()) as ProvisionOk;
  return { ...created, ...prov };
}

describe("handleRequest", () => {
  it("GET / → 200 HTML containing Scout Connect", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/`), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Scout Connect");
  });

  it("GET /healthz → ok", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/healthz`), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("admin api without bearer → 401", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/api/admin/invites`), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST invite → 201 with lowercased email, inviteUrl, and audit row", async () => {
    const { db, deps } = setup();
    const res = await createInviteViaApi(deps, {
      email: " Alice@Example.COM ",
      invitee_label: "Alice",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteCreated;
    expect(body.inviteUrl).toBe(`${BASE}/i/${body.code}`);

    const invite = await db.getInviteById(body.id);
    expect(invite?.email).toBe("alice@example.com");
    expect(invite?.status).toBe("pending");
    expect(invite?.invitee_label).toBe("Alice");
    expect(invite?.created_at).toBe(NOW);

    const audits = await db.listAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("invite.create");
    expect(audits[0]?.actor).toBe("admin");
    expect(audits[0]?.invite_id).toBe(body.id);
    expect(audits[0]?.detail_json).toContain("alice@example.com");
  });

  it("POST invite with invalid email → 400, nothing persisted", async () => {
    const { db, deps } = setup();
    const res = await createInviteViaApi(deps, { email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid email" });
    expect(await db.listInvites()).toHaveLength(0);
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("provision happy path → 200 with token; public endpoints list carries no token material", async () => {
    const { db, deps } = setup();
    const createRes = await createInviteViaApi(deps, {
      email: "alice@example.com",
      slug: "alice",
    });
    const created = (await createRes.json()) as InviteCreated;

    const res = await provisionViaApi(deps, created.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProvisionOk;
    expect(body.hostname).toBe("alice.mediaryconnect.app");
    expect(body.token).toBe(FIXTURE_TOKEN_1);
    expect(body.agentPrompt).toContain(FIXTURE_TOKEN_1);
    expect(body.inviteUrl).toBe(`${BASE}/i/${created.code}`);

    const listRes = await handleRequest(adminGet("/api/admin/endpoints"), deps);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { endpoints: Array<Record<string, unknown>> };
    expect(list.endpoints).toHaveLength(1);
    const ep = list.endpoints[0];
    expect(ep?.hostname).toBe("alice.mediaryconnect.app");
    expect(ep?.cf_tunnel_id).toBe("tid-1");
    expect(ep && "token" in ep).toBe(false);
    expect(ep && "token_ciphertext" in ep).toBe(false);
    expect(ep && "token_sha256" in ep).toBe(false);
    expect(JSON.stringify(list)).not.toContain("fixture-tunnel-token");

    // db still holds the one-time ciphertext (not burned by listing)
    const stored = await db.getEndpointByInviteId(created.id);
    expect(stored?.token_ciphertext).not.toBeNull();
    expect(stored?.token_shown_at).toBeNull();
  });

  it("provision without any slug → 400 slug required", async () => {
    const { deps } = setup();
    const createRes = await createInviteViaApi(deps, { email: "alice@example.com" });
    const created = (await createRes.json()) as InviteCreated;

    const res = await provisionViaApi(deps, created.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "slug required" });
  });

  it("provision unknown invite → 404", async () => {
    const { deps } = setup();
    const res = await provisionViaApi(deps, "inv_nope", { slug: "alice" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "invite not found" });
  });

  it("revoke → 200 {hostname, revoked:true}, endpoint+invite flipped, cf deletes called", async () => {
    const { db, calls, deps } = setup();
    await seedProvisioned(deps);
    const endpointId = (await db.listEndpoints())[0]?.id;
    expect(endpointId).toBeDefined();

    const res = await handleRequest(
      adminPost(`/api/admin/endpoints/${endpointId ?? ""}/revoke`),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hostname: "alice.mediaryconnect.app",
      revoked: true,
    });

    const methods = calls.map((c) => c.method);
    expect(methods).toContain("deleteAccessApp");
    expect(methods).toContain("deleteDnsRecord");
    expect(methods).toContain("deleteTunnel");

    const endpoint = await db.getEndpointById(endpointId ?? "");
    expect(endpoint?.status).toBe("revoked");
    expect(endpoint?.revoked_at).toBe(NOW);
    const invite = await db.getInviteById(endpoint?.invite_id ?? "");
    expect(invite?.status).toBe("revoked");
  });

  it("GET /i/unknown → 链接无效 page", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/i/${"x".repeat(40)}`), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("链接无效");
  });

  it("GET /i/:code with pending invite → 作者尚未开通, no reveal button", async () => {
    const { deps } = setup();
    const createRes = await createInviteViaApi(deps, { email: "alice@example.com" });
    const created = (await createRes.json()) as InviteCreated;

    const res = await handleRequest(new Request(`${BASE}/i/${created.code}`), deps);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("作者尚未开通");
    expect(html).not.toContain("显示连接信息");
  });

  it("GET /i/:code ready → 显示连接信息 button, but NOT the token", async () => {
    const { deps } = setup();
    const seeded = await seedProvisioned(deps);

    const res = await handleRequest(new Request(`${BASE}/i/${seeded.code}`), deps);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("显示连接信息");
    expect(html).not.toContain(FIXTURE_TOKEN_1);
  });

  it("GET ready page does not pre-burn: reveal afterwards still returns the token", async () => {
    const { db, deps } = setup();
    const seeded = await seedProvisioned(deps);

    await handleRequest(new Request(`${BASE}/i/${seeded.code}`), deps);
    const invite = await db.getInviteByCode(seeded.code);
    const ep = await db.getEndpointByInviteId(invite?.id ?? "");
    expect(ep?.token_ciphertext).not.toBeNull();
    expect(ep?.token_shown_at).toBeNull();

    const reveal = await handleRequest(
      new Request(`${BASE}/api/i/${seeded.code}/reveal`, { method: "POST" }),
      deps,
    );
    expect(reveal.status).toBe(200);
    expect(((await reveal.json()) as { token?: string }).token).toBe(FIXTURE_TOKEN_1);
  });

  it("POST reveal → 200 with token; second reveal → 200 alreadyShown without token", async () => {
    const { deps } = setup();
    const seeded = await seedProvisioned(deps);

    const first = await handleRequest(
      new Request(`${BASE}/api/i/${seeded.code}/reveal`, { method: "POST" }),
      deps,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.hostname).toBe("alice.mediaryconnect.app");
    expect(firstBody.token).toBe(FIXTURE_TOKEN_1);
    expect(firstBody.agentPrompt).toBe(seeded.agentPrompt);

    const second = await handleRequest(
      new Request(`${BASE}/api/i/${seeded.code}/reveal`, { method: "POST" }),
      deps,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody).toEqual({
      hostname: "alice.mediaryconnect.app",
      alreadyShown: true,
    });
    expect("token" in secondBody).toBe(false);
  });

  it("POST reveal with unknown code → 404", async () => {
    const { deps } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/api/i/${"y".repeat(40)}/reveal`, { method: "POST" }),
      deps,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("www.* hostname → 301 apex, preserving path", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request("https://www.mediaryconnect.app/i/abc"), deps);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://mediaryconnect.app/i/abc");
  });

  it("unknown path → 404", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/nope`), deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
