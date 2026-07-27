import { describe, it, expect, vi, afterEach } from "vitest";
import { handleRequest, MAX_JSON_BODY_BYTES, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import type { CfApi } from "./cf-api.js";
import { EMAIL_MAX_LENGTH, EMAIL_RE } from "./validation.js";

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
  it("GET / → 200 HTML containing Mediary Connect", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/`), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Mediary Connect");
  });

  it("GET / on the beta subdomain serves the signup page (canonical URL is the bare host)", async () => {
    const { deps } = setup();
    // beta.mediaryconnect.app 就是规范地址——"beta.…/beta" 是结巴。
    // 该子域名的根路径必须直接给报名表单，而不是 Mediary Connect 说明页。
    const res = await handleRequest(new Request("https://beta.mediaryconnect.app/"), deps);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("申请内测席位");
    expect(html).not.toContain("Mediary Connect 说明");
  });

  it("beta root routing survives an un-normalized rootDomain env value", async () => {
    // CONNECT_ROOT_DOMAIN 从 env 原样进来，不 trim 不小写。带大小写/空格的
    // 配置不该让 beta 根路径静默退回说明页（Copilot PR #183）。
    const { deps } = setup();
    const messyDeps = { ...deps, rootDomain: "  MediaryConnect.APP  " };
    const res = await handleRequest(new Request("https://beta.mediaryconnect.app/"), messyDeps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("申请内测席位");
  });

  it("GET / on apex still serves the home page (host routing must not leak)", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/`), deps);
    const html = await res.text();
    expect(html).toContain("Mediary Connect");
    expect(html).not.toContain("申请内测席位");
  });

  it("GET /beta keeps working on both hosts (no regression)", async () => {
    const { deps } = setup();
    for (const host of [BASE, "https://beta.mediaryconnect.app"]) {
      const res = await handleRequest(new Request(`${host}/beta`), deps);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("申请内测席位");
    }
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

  // The heartbeat's only output was unobservable: POST /api/instance/status
  // wrote endpoints.last_seen_at, but the admin list shape stripped it.
  it("GET /api/admin/endpoints exposes last_seen_at (null before, ISO after a heartbeat)", async () => {
    const { deps } = setup();
    const seeded = await seedProvisioned(deps);

    const beforeRes = await handleRequest(adminGet("/api/admin/endpoints"), deps);
    const before = (await beforeRes.json()) as { endpoints: Array<Record<string, unknown>> };
    expect(before.endpoints).toHaveLength(1);
    expect(before.endpoints[0] && "last_seen_at" in before.endpoints[0]).toBe(true);
    expect(before.endpoints[0]?.last_seen_at).toBeNull();

    const beat = await handleRequest(
      new Request(`${BASE}/api/instance/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${seeded.token}` },
      }),
      deps,
    );
    expect(beat.status).toBe(204);

    const afterRes = await handleRequest(adminGet("/api/admin/endpoints"), deps);
    const after = (await afterRes.json()) as { endpoints: Array<Record<string, unknown>> };
    expect(after.endpoints[0]?.last_seen_at).toBe(NOW);
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

  // The TOCTOU window past the slug precheck dies on the UNIQUE constraint,
  // whose message ("UNIQUE constraint failed: endpoints.slug") matched NEITHER
  // of the old 409 patterns ("already in use" / "invite not pending") and so
  // surfaced as an opaque 500. A lost race is a client conflict, not an outage.
  it("provision losing a slug race (UNIQUE endpoints.slug) → 409, not 500", async () => {
    const { db, deps } = setup();
    await seedProvisioned(deps); // alice.mediaryconnect.app endpoint exists
    const createRes = await createInviteViaApi(deps, { email: "bob@example.com", slug: "alice" });
    const created = (await createRes.json()) as InviteCreated;

    // Blind ONLY the availability precheck: the winner's row was not visible
    // when the loser checked, but is by the time the INSERT runs.
    const racing: ConnectDb = {
      ...db,
      async findEndpointBySlugOrHostname() {
        return null;
      },
    };
    const res = await provisionViaApi({ ...deps, db: racing }, created.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    // User-facing message, NOT the raw "UNIQUE constraint failed: …" string —
    // echoing internal schema text to the client violates this file's contract.
    expect(body.error).toBe("slug already in use: alice");
    expect(body.error).not.toContain("UNIQUE");
  });

  it("provision losing a same-invite race (UNIQUE endpoints.invite_id) → 409, not 500", async () => {
    const { db, deps } = setup();
    const seeded = await seedProvisioned(deps);

    // The loser's invite read happened before the winner committed: stale
    // pending snapshot + a blinded availability precheck, then the INSERT
    // dies on the winner's row.
    const racing: ConnectDb = {
      ...db,
      async getInviteById(id) {
        const row = await db.getInviteById(id);
        return row === null ? null : { ...row, status: "pending" as const };
      },
      async findEndpointBySlugOrHostname() {
        return null;
      },
    };
    const res = await provisionViaApi({ ...deps, db: racing }, seeded.id);
    expect(res.status).toBe(409);
    const body2 = (await res.json()) as { error: string };
    expect(body2.error).toBe("invite already provisioned");
    expect(body2.error).not.toContain("UNIQUE");
    // …and the winner's invite was not rolled back by the loser's compensation.
    expect((await db.getInviteById(seeded.id))?.status).toBe("provisioned");
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
    // New endpoints don't have Access app (cf_access_app_id is null)
    expect(methods).not.toContain("deleteAccessApp");
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

  it("GET /beta → 200 signup page, CSP permits its same-origin fetch", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/beta`), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Mediary Connect 远程访问 · 内测");
    expect(body).toContain('<form id="signup"');
    // The page's inline script POSTs fetch("/waitlist") same-origin. Under the
    // old CSP (default-src 'none', no connect-src) a real browser REFUSES that
    // fetch (connect-src falls back to default-src) — verified empirically:
    // "FETCH_BLOCKED Failed to fetch" without the directive, "FETCH_OK" with
    // it. The invite page's reveal and the admin console needed it too.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  it("GET pages carry a CSP that allows the Cloudflare Turnstile assets", async () => {
    // The beta signup page's bot gate (Turnstile) loads api.js, renders an
    // iframe, and beacons to challenges.cloudflare.com. htmlPage()'s CSP is
    // shared by home/invite/admin/beta, so the allowlist lives there for all.
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/beta`), deps);
    const csp = res.headers.get("content-security-policy") ?? "";
    // New Turnstile sources (exact directive bodies — a dropped source here
    // silently breaks the widget in production while tests stay green):
    expect(csp).toContain("script-src 'unsafe-inline' https://challenges.cloudflare.com");
    // 最小权限：没有任何同源脚本资源（每个 <script> 要么内联、要么是上面的
    // Turnstile CDN），所以 script-src 指令里不该出现 'self' —— 按指令解析，
    // 不靠子串匹配（子串写法漏掉 "…https://… 'self'" 这种换序）。
    const scriptSrc = (csp.split(";").find((d) => d.trim().startsWith("script-src ")) ?? "")
      .trim()
      .split(/\s+/)
      .slice(1);
    expect(scriptSrc).not.toContain("'self'");
    expect(scriptSrc).toEqual(["'unsafe-inline'", "https://challenges.cloudflare.com"]);
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("connect-src 'self' https://challenges.cloudflare.com");
    // Pre-existing directives unchanged:
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
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

  it("POST /waitlist with valid email → 201, id starts with wl_, position = 1", async () => {
    const { deps } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com" }),
      }),
      deps,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; position: number };
    expect(body.id).toMatch(/^wl_/);
    expect(body.position).toBe(1);
  });

  it("POST /waitlist same email twice → 200, same id, position unchanged", async () => {
    const { deps } = setup();
    const first = await handleRequest(
      new Request(`${BASE}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
      deps,
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; position: number };

    const second = await handleRequest(
      new Request(`${BASE}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
      deps,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      already_exists: boolean;
      id: string;
      position: number;
    };
    expect(secondBody.already_exists).toBe(true);
    expect(secondBody.id).toBe(firstBody.id);
    // The test name promises "position unchanged", so assert it. The 200 body is
    // a strict superset of {already_exists, id} — `position` is returned on BOTH
    // success paths on purpose (the settings form shows the user their rank, and
    // a repeat submit is exactly when they look again). Without this the
    // already-exists path could silently drop it and the name would still lie.
    expect(secondBody.position).toBe(firstBody.position);
  });

  // Pins the error vocabulary documented in the addToWaitlist JSDoc and the
  // README table. "bad encoding" was listed there for a while but is only ever
  // thrown by decodeParam (URL components) — the body reader cannot produce it.
  // If you add a new 4xx to this route, add it here and to both docs together.
  it("POST /waitlist error vocabulary matches the documented contract", async () => {
    const { deps } = setup();
    const post = async (body: string, headers: Record<string, string> = {}) =>
      handleRequest(
        new Request(`${BASE}/waitlist`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        }),
        deps,
      );

    const seen = new Set<string>();
    for (const body of [
      JSON.stringify({}),                      // email required
      JSON.stringify({ email: "nope" }),       // invalid email
      "{not json",                             // invalid json
      JSON.stringify([1, 2, 3]),               // invalid body
      JSON.stringify({ email: `${"a".repeat(9000)}@x.com` }), // body too large
    ]) {
      const res = await post(body);
      const { error } = (await res.json()) as { error: string };
      seen.add(error);
    }

    expect([...seen].sort()).toEqual([
      "body too large",
      "email required",
      "invalid body",
      "invalid email",
      "invalid json",
    ]);
    expect(seen.has("bad encoding")).toBe(false);
  });

  it("POST /waitlist invalid email → 400", async () => {
    const { deps } = setup();
    const invalid = [
      "not-an-email",
      "missing-at-sign.com",
      "@no-local.com",
      "no-domain@",
      "bad@domain",
      "bad@.com",
    ];
    for (const email of invalid) {
      const res = await handleRequest(
        new Request(`${BASE}/waitlist`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        }),
        deps,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid email" });
    }
  });

  it("POST /waitlist normalizes email (uppercase/whitespace) → same record", async () => {
    const { deps } = setup();
    const first = await handleRequest(
      new Request(`${BASE}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "  Charlie@Example.COM  " }),
      }),
      deps,
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; position: number };

    const second = await handleRequest(
      new Request(`${BASE}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "charlie@example.com" }),
      }),
      deps,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      already_exists: boolean;
      id: string;
      position: number;
    };
    expect(secondBody.already_exists).toBe(true);
    expect(secondBody.id).toBe(firstBody.id);
    // Same record ⇒ same rank. Pins `position` on the normalization path too.
    expect(secondBody.position).toBe(firstBody.position);
  });

  it("POST /api/instance/status with valid token → 204, updates last_seen_at", async () => {
    const { db, deps } = setup();
    const seeded = await seedProvisioned(deps);
    
    // Get the endpoint to extract its token
    const endpoint = await db.getEndpointByInviteId(seeded.id);
    expect(endpoint).not.toBeNull();
    expect(endpoint?.last_seen_at).toBeNull();
    
    const res = await handleRequest(
      new Request(`${BASE}/api/instance/status`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${seeded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "1.0.0", uptime_seconds: 3600 }),
      }),
      deps,
    );
    expect(res.status).toBe(204);
    
    // Verify last_seen_at was updated
    const updated = await db.getEndpointByInviteId(seeded.id);
    expect(updated?.last_seen_at).toBe(NOW);
  });

  it("POST /api/instance/status missing Authorization header → 401", async () => {
    const { deps } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/api/instance/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /api/instance/status invalid token (wrong hash) → 401", async () => {
    const { deps } = setup();
    await seedProvisioned(deps);
    
    const res = await handleRequest(
      new Request(`${BASE}/api/instance/status`, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token-that-wont-match",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /api/instance/status revoked endpoint (status='revoked') → 401", async () => {
    const { db, deps } = setup();
    const seeded = await seedProvisioned(deps);
    
    // Revoke the endpoint
    const endpoint = await db.getEndpointByInviteId(seeded.id);
    expect(endpoint).not.toBeNull();
    await handleRequest(
      adminPost(`/api/admin/endpoints/${endpoint?.id ?? ""}/revoke`),
      deps,
    );
    
    // Try to report status with the (now revoked) token
    const res = await handleRequest(
      new Request(`${BASE}/api/instance/status`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${seeded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /api/instance/status valid token + optional body fields (version/uptime) → 204", async () => {
    const { deps } = setup();
    const seeded = await seedProvisioned(deps);
    
    const res = await handleRequest(
      new Request(`${BASE}/api/instance/status`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${seeded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "2.5.1", uptime_seconds: 86400 }),
      }),
      deps,
    );
    expect(res.status).toBe(204);
  });
});

describe("GET /api/admin/waitlist", () => {
  it("→ 401 without admin token", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/api/admin/waitlist`), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("→ 200 with rows in queue order ((created_at, id) ascending) for a seeded list", async () => {
    const { db, deps } = setup();
    // Insert OUT of order to prove the response is sorted by the queue
    // composite (created_at, id), not insertion order.
    await db.insertWaitlist({
      id: "wl_c",
      email: "c@example.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-24T10:00:02.000Z",
      survey_json: null,
    });
    await db.insertWaitlist({
      id: "wl_a",
      email: "a@example.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-24T10:00:00.000Z",
      survey_json: null,
    });
    await db.insertWaitlist({
      id: "wl_b",
      email: "b@example.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-24T10:00:01.000Z",
      survey_json: null,
    });

    const res = await handleRequest(adminGet("/api/admin/waitlist"), deps);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      waitlist: Array<{ id: string; email: string; status: string; created_at: string }>;
    };
    expect(body.waitlist.map((r) => r.email)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(body.waitlist[0]).toMatchObject({
      id: "wl_a",
      status: "pending",
      created_at: "2026-07-24T10:00:00.000Z",
    });
  });

  it("→ 200 { waitlist: [] } when the batch is empty", async () => {
    const { deps } = setup();
    const res = await handleRequest(adminGet("/api/admin/waitlist"), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ waitlist: [] });
  });

  it("GET /admin console page renders the waitlist section wired to the route", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/admin`), deps);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Section with the four required columns.
    expect(html).toContain("内测报名列表");
    expect(html).toContain("名次");
    expect(html).toContain("邮箱");
    expect(html).toContain("报名时间");
    // The copy-all-emails export (the project has no email-sending capability).
    expect(html).toContain("复制全部邮箱");
    // Actually wired to fetch the route, like the other sections.
    expect(html).toContain("/api/admin/waitlist");
    // Empty-state copy.
    expect(html).toContain("暂无报名");
  });
});

describe("GET /api/admin/audits", () => {
  it("→ 401 without admin token", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/api/admin/audits`), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("→ 200 with audit rows, newest first", async () => {
    const { db, deps } = setup();
    // Insert OUT of order to prove the response is sorted (at DESC, id DESC).
    await db.insertAudit({
      id: "aud_old",
      at: "2026-07-24T09:00:00.000Z",
      actor: "admin",
      action: "invite.create",
      invite_id: "inv_1",
      endpoint_id: null,
      detail_json: JSON.stringify({ email: "a@example.com" }),
    });
    await db.insertAudit({
      id: "aud_new",
      at: "2026-07-24T11:00:00.000Z",
      actor: "admin",
      action: "invite.create",
      invite_id: "inv_2",
      endpoint_id: null,
      detail_json: JSON.stringify({ email: "b@example.com" }),
    });

    const res = await handleRequest(adminGet("/api/admin/audits"), deps);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      audits: Array<{ id: string; action: string; at: string }>;
    };
    expect(body.audits.map((r) => r.id)).toEqual(["aud_new", "aud_old"]);
    expect(body.audits[0]).toMatchObject({ action: "invite.create", at: "2026-07-24T11:00:00.000Z" });
  });

  it("→ 200 { audits: [] } when nothing has happened yet", async () => {
    const { deps } = setup();
    const res = await handleRequest(adminGet("/api/admin/audits"), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audits: [] });
  });
});

describe("POST /waitlist hardening", () => {
  function waitlistPost(email: unknown): Request {
    return new Request(`${BASE}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  // HIGH-4: the endpoint is unauthenticated, so an oversized body is stored
  // verbatim and amplified. A 200KB "email" was previously accepted.
  it("rejects an email longer than 254 chars (RFC 5321) with 400", async () => {
    const { db, deps } = setup();
    const huge = `${"a".repeat(300)}@example.com`;

    const res = await handleRequest(waitlistPost(huge), deps);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid email" });
    expect(await db.countWaitlist(1)).toBe(0);
  });

  // Copilot round 2, finding 1: this used to assert 400, because the ONLY
  // thing standing between a stranger and a 200KB payload was the email length
  // check — which runs after the whole body has already been read and parsed.
  // The body cap now rejects it earlier and more cheaply, so the status is 413
  // and the parse never happens. The property the test actually cares about —
  // an enormous payload is refused and nothing is stored — is unchanged and
  // still asserted; only the layer that refuses it moved outward.
  it("rejects a 200KB email at the body cap, without storing it", async () => {
    const { db, deps } = setup();
    const enormous = `${"a".repeat(200 * 1024)}@example.com`;

    const res = await handleRequest(waitlistPost(enormous), deps);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body too large" });
    expect(await db.countWaitlist(1)).toBe(0);
  });

  // The email cap is NOT made redundant by the body cap: an address can be
  // grossly invalid while the body stays well under 8 KB. This keeps the 400
  // path pinned so the inner check cannot be deleted as "already covered".
  it("still rejects an over-long email with 400 when the body is under the cap", async () => {
    const { db, deps } = setup();
    // ~1 KB body: far below MAX_JSON_BODY_BYTES, far above EMAIL_MAX_LENGTH.
    const longButSmall = `${"a".repeat(1000)}@example.com`;

    const res = await handleRequest(waitlistPost(longButSmall), deps);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid email" });
    expect(await db.countWaitlist(1)).toBe(0);
  });

  it("caps length BEFORE the regex so a pathological local-part cannot be scanned", async () => {
    const { deps } = setup();
    // 254 chars is the RFC 5321 maximum; 255 must fail on length alone.
    const at255 = `${"a".repeat(255 - "@example.com".length)}@example.com`;
    expect(at255).toHaveLength(255);
    expect(EMAIL_RE.test(at255)).toBe(true); // regex-valid, length-invalid

    const res = await handleRequest(waitlistPost(at255), deps);
    expect(res.status).toBe(400);
  });

  it("still accepts an email at exactly the 254-char boundary", async () => {
    const { db, deps } = setup();
    const at254 = `${"a".repeat(254 - "@example.com".length)}@example.com`;
    expect(at254).toHaveLength(254);

    const res = await handleRequest(waitlistPost(at254), deps);

    expect(res.status).toBe(201);
    expect(await db.countWaitlist(1)).toBe(1);
  });

  // Copilot round 5, finding 1: the cap used to run on the RAW string, before
  // trim(). The stored/validated value is the trimmed one, so a legitimate
  // 254-char address pasted with surrounding whitespace (every mail client and
  // password manager adds it) was rejected on a length its normalized form does
  // not have. The cap must measure what we actually keep.
  it("accepts a 254-char email submitted with surrounding whitespace", async () => {
    const { db, deps } = setup();
    const at254 = `${"a".repeat(254 - "@example.com".length)}@example.com`;
    expect(at254).toHaveLength(254);
    const padded = `  \t${at254}\n `;
    expect(padded.length).toBeGreaterThan(EMAIL_MAX_LENGTH);

    const res = await handleRequest(waitlistPost(padded), deps);

    expect(res.status).toBe(201);
    expect(await db.countWaitlist(1)).toBe(1);
  });

  // The other half of the same boundary: moving the cap after trim() must not
  // turn it into a no-op. 255 trimmed chars is still over the RFC limit, and
  // padding it with whitespace must not smuggle it past.
  it("rejects an email whose TRIMMED length is 255, whitespace or not", async () => {
    const { db, deps } = setup();
    const at255 = `${"a".repeat(255 - "@example.com".length)}@example.com`;
    expect(at255).toHaveLength(EMAIL_MAX_LENGTH + 1);

    for (const candidate of [at255, `  ${at255}  `]) {
      const res = await handleRequest(waitlistPost(candidate), deps);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid email" });
    }
    expect(await db.countWaitlist(1)).toBe(0);
  });

  // HIGH-4: position was computed by pulling EVERY row and scanning in JS, so
  // each request cost O(n) and the endpoint cost O(n^2) cumulatively. The
  // indexed countWaitlist() was implemented but never called on this path.
  it("does not call listWaitlist on the signup path (uses the indexed count)", async () => {
    const { db, deps } = setup();
    let listCalls = 0;
    let countCalls = 0;
    const tracked: ConnectDb = {
      ...db,
      async listWaitlist(batch) {
        listCalls += 1;
        return db.listWaitlist(batch);
      },
      async countWaitlist(batch) {
        countCalls += 1;
        return db.countWaitlist(batch);
      },
      async waitlistRankOf(batch, createdAt, id) {
        countCalls += 1;
        return db.waitlistRankOf(batch, createdAt, id);
      },
    };

    const first = await handleRequest(waitlistPost("new@example.com"), { ...deps, db: tracked });
    expect(first.status).toBe(201);
    // And on the already-exists branch too.
    const second = await handleRequest(waitlistPost("new@example.com"), { ...deps, db: tracked });
    expect(second.status).toBe(200);

    expect(listCalls).toBe(0);
    expect(countCalls).toBeGreaterThan(0);
  });

  it("reports positions that increase with each distinct signup", async () => {
    // Distinct signups arriving in distinct seconds — the plain ordering case.
    // `now` advances here on purpose: the frozen-clock variant is a different
    // scenario and is covered by the same-second test below.
    const { deps: base } = setup();
    let tick = 0;
    const deps = { ...base, now: () => `2026-07-24T10:00:0${tick++}.000Z` };
    const positions: number[] = [];
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      const res = await handleRequest(waitlistPost(email), deps);
      expect(res.status).toBe(201);
      positions.push(((await res.json()) as { position: number }).position);
    }
    expect(positions).toEqual([1, 2, 3]);
  });

  // The regression Copilot flagged, at the HTTP layer. created_at is a
  // whole-second ISO string, so several people signing up in the same second is
  // routine. Under the old `created_at <= ?` count, querying those rows gave
  // every one of them the SAME position (measured against real SQLite with
  // three same-second rows: 3, 3, 3).
  //
  // Distinctness is a property of a fixed snapshot, so this asserts against the
  // settled table (via the repeat-submit 200 path) rather than against the
  // insert-time values: a position handed out mid-signup is the rank among the
  // rows that existed then, and because newId("wl") is random hex rather than
  // monotonic, a later same-second row can legitimately sort ahead of an
  // earlier one. Hence also no assertion of submission order here — that is
  // not something this implementation guarantees within one second.
  it("same-second signups get distinct, stable positions (no ties)", async () => {
    const { db, deps } = setup();
    const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"];
    for (const email of emails) {
      expect((await handleRequest(waitlistPost(email), deps)).status).toBe(201);
    }

    // All four share one frozen timestamp — this is the tie scenario.
    const rows = await db.listWaitlist(1);
    expect(rows).toHaveLength(emails.length);
    expect(new Set(rows.map((r) => r.created_at)).size).toBe(1);

    const settled = async (): Promise<number[]> => {
      const out: number[] = [];
      for (const email of emails) {
        const res = await handleRequest(waitlistPost(email), deps);
        expect(res.status).toBe(200);
        out.push(((await res.json()) as { position: number }).position);
      }
      return out;
    };

    const positions = await settled();
    // Every position distinct, and exactly the set 1..4 — no gaps, no ties.
    // The old implementation returned [4, 4, 4, 4] here.
    expect(new Set(positions).size).toBe(emails.length);
    expect([...positions].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);

    // Stable across repeated reads, not just internally consistent once.
    expect(await settled()).toEqual(positions);
  });

  // HIGH-5: SELECT-then-INSERT is not atomic. Five concurrent identical POSTs
  // previously returned one 201 and four 500 {"error":"internal"} — a user
  // double-clicking Submit got an error page after being signed up.
  it("concurrent identical submits never 500 (TOCTOU)", async () => {
    const { db, deps } = setup();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => handleRequest(waitlistPost("race@example.com"), deps)),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 500)).toEqual([]);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(4);
    // Data integrity: the UNIQUE index still admits exactly one row.
    expect(await db.countWaitlist(1)).toBe(1);
  });

  it("a lost INSERT race returns the same shape as the already-exists branch", async () => {
    const { db, deps } = setup();
    const first = await handleRequest(waitlistPost("dup@example.com"), deps);
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;

    // Force the race deterministically: blind ONLY the pre-check, so the
    // handler proceeds to an INSERT that the UNIQUE index rejects. The
    // post-violation lookup still works, exactly as in a real race where the
    // winner's row is committed by the time we re-read.
    let precheckBlinded = false;
    const racing: ConnectDb = {
      ...db,
      async getWaitlistByEmail(email, batch) {
        if (!precheckBlinded) {
          precheckBlinded = true;
          return null;
        }
        return db.getWaitlistByEmail(email, batch);
      },
    };

    const second = await handleRequest(waitlistPost("dup@example.com"), {
      ...deps,
      db: racing,
    });

    expect(precheckBlinded).toBe(true);
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      already_exists: boolean;
      id: string;
      position: number;
    };
    expect(body.already_exists).toBe(true);
    expect(body.id).toBe(firstId);
    expect(body.position).toBe(1);
    expect(await db.countWaitlist(1)).toBe(1);
  });

  it("propagates a genuine insert failure as 500 (does not swallow every error)", async () => {
    const { db, deps } = setup();
    const broken: ConnectDb = {
      ...db,
      async insertWaitlist() {
        throw new Error("D1_ERROR: network unreachable");
      },
    };

    const res = await handleRequest(waitlistPost("boom@example.com"), { ...deps, db: broken });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("a non-UNIQUE failure still 500s even when a row is readable afterwards", async () => {
    // Pins the narrowness of the UNIQUE check itself. Above, the recovery
    // lookup returns null and the `winner === null` guard produces the 500 —
    // so that test passes even with a broad catch-all. Here the lookup DOES
    // return a row, so only classifying on the error message keeps this a 500.
    // A blanket `catch { return 200 }` would report a D1 outage as success.
    const { db, deps } = setup();
    await db.insertWaitlist({
      id: "wl_pre",
      email: "outage@example.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-24T09:00:00.000Z",
      survey_json: null,
    });
    let precheckBlinded = false;
    const broken: ConnectDb = {
      ...db,
      async getWaitlistByEmail(email, batch) {
        if (!precheckBlinded) {
          precheckBlinded = true;
          return null;
        }
        return db.getWaitlistByEmail(email, batch);
      },
      async insertWaitlist() {
        throw new Error("D1_ERROR: statement timed out");
      },
    };

    const res = await handleRequest(waitlistPost("outage@example.com"), { ...deps, db: broken });

    expect(precheckBlinded).toBe(true);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  // MEDIUM-7: the schema default was 'waiting' while routes insert 'pending',
  // so the column held two different words for one state. Nothing filters on
  // status today — this pins that the app and the schema agree on the literal.
  it("inserts the same status literal the schema defaults to", async () => {
    const { db, deps } = setup();
    await handleRequest(waitlistPost("lit@example.com"), deps);
    const row = await db.getWaitlistByEmail("lit@example.com", 1);
    expect(row?.status).toBe("pending");
  });
});

describe("POST /waitlist seat cap (founding batch = 100)", () => {
  function waitlistPost(email: unknown): Request {
    return new Request(`${BASE}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Seeds `n` pending rows directly into batch 1, bypassing the route.
   * Distinct, ascending created_at values (all BEFORE the frozen NOW) so the
   * (created_at, id) queue order is chronological and positions are
   * deterministic: seed i holds position i regardless of the random id the
   * route assigns to a new signup.
   */
  async function seedBatch(db: ConnectDb, n: number): Promise<void> {
    for (let i = 1; i <= n; i++) {
      const mm = String(Math.floor(i / 60)).padStart(2, "0");
      const ss = String(i % 60).padStart(2, "0");
      await db.insertWaitlist({
        id: `wl_seed_${i}`,
        email: `seed${i}@example.com`,
        batch: 1,
        status: "pending",
        created_at: `2026-07-24T09:${mm}:${ss}.000Z`,
        survey_json: null,
      });
    }
  }

  it("99 entries → the 100th new email still succeeds (201)", async () => {
    const { db, deps } = setup();
    await seedBatch(db, 99);

    const res = await handleRequest(waitlistPost("last-seat@example.com"), deps);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; position: number };
    expect(body.id).toMatch(/^wl_/);
    expect(body.position).toBe(100);
    expect(await db.countWaitlist(1)).toBe(100);
  });

  it("100 entries → a NEW email → 409 本批内测席位已满, nothing inserted", async () => {
    const { db, deps } = setup();
    await seedBatch(db, 100);

    const res = await handleRequest(waitlistPost("too-late@example.com"), deps);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "本批内测席位已满" });
    expect(await db.countWaitlist(1)).toBe(100);
    expect(await db.getWaitlistByEmail("too-late@example.com", 1)).toBeNull();
  });

  it("at capacity, an EXISTING email still gets 200 with its position", async () => {
    const { db, deps } = setup();
    await seedBatch(db, 100);

    const res = await handleRequest(waitlistPost("seed42@example.com"), deps);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      already_exists: boolean;
      id: string;
      position: number;
    };
    expect(body.already_exists).toBe(true);
    expect(body.id).toBe("wl_seed_42");
    expect(body.position).toBe(42);
  });
});

describe("POST /waitlist/survey", () => {
  function surveyPost(body: unknown): Request {
    return new Request(`${BASE}/waitlist/survey`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Signs `email` up via the real route and returns the new waitlist id. */
  async function signup(deps: RouteDeps, email: string): Promise<string> {
    const res = await handleRequest(
      new Request(`${BASE}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      deps,
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("404 for an unknown id, nothing written", async () => {
    const { db, deps } = setup();
    const res = await handleRequest(
      surveyPost({ id: "wl_nope", willing_to_pay: "willing" }),
      deps,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "waitlist entry not found" });
    expect(await db.getWaitlistById("wl_nope")).toBeNull();
  });

  it("503 (not a bare 500) when the survey column does not exist yet (migration window)", async () => {
    const { deps } = setup();
    const id = await signup(deps, "win@example.com");
    // Simulate the pre-0002 schema: updateWaitlistSurvey throws the missing-column error.
    const windowDeps: RouteDeps = {
      ...deps,
      db: {
        ...deps.db,
        async updateWaitlistSurvey() {
          throw new Error("no such column: survey_json");
        },
      },
    };
    const res = await handleRequest(
      surveyPost({ id, willing_to_pay: "willing" }),
      windowDeps,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "survey temporarily unavailable" });
  });

  it("non-schema errors from updateWaitlistSurvey still propagate (not masked as 503)", async () => {
    const { deps } = setup();
    const id = await signup(deps, "realerr@example.com");
    const errDeps: RouteDeps = {
      ...deps,
      db: {
        ...deps.db,
        async updateWaitlistSurvey() {
          throw new Error("d1 connection reset");
        },
      },
    };
    // handleRequest 的兜底把未识别错误统一成 500 internal —— 关键是它绝不能
    // 被误判成 503：只有「缺列」这种明确可恢复的情况才配 typed 状态码。
    const res = await handleRequest(surveyPost({ id, willing_to_pay: "willing" }), errDeps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("400 when id is missing or not a string", async () => {
    const { deps } = setup();
    for (const body of [{}, { id: 42 }, { id: "  " }]) {
      const res = await handleRequest(surveyPost(body), deps);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "id required" });
    }
  });

  it("204 and stores only the answered fields as JSON (round-trip)", async () => {
    const { db, deps } = setup();
    const id = await signup(deps, "survey@example.com");

    const res = await handleRequest(
      surveyPost({
        id,
        willing_to_pay: "willing",
        price_point: "19",
        use_cases: ["progress", "all"],
        donate: true,
        feedback: "加油",
      }),
      deps,
    );

    expect(res.status).toBe(204);
    const row = await db.getWaitlistById(id);
    expect(JSON.parse(row?.survey_json ?? "")).toEqual({
      willing_to_pay: "willing",
      price_point: "19",
      use_cases: ["progress", "all"],
      donate: true,
      feedback: "加油",
    });
  });

  it("ignores unknown fields — only known keys are persisted", async () => {
    const { db, deps } = setup();
    const id = await signup(deps, "unknown-fields@example.com");

    const res = await handleRequest(
      surveyPost({ id, willing_to_pay: "willing", hacker: "x", admin: true, email: "new@x.com" }),
      deps,
    );

    expect(res.status).toBe(204);
    expect(JSON.parse((await db.getWaitlistById(id))?.survey_json ?? "")).toEqual({
      willing_to_pay: "willing",
    });
  });

  it("truncates feedback at 500 chars server-side", async () => {
    const { db, deps } = setup();
    const id = await signup(deps, "long-feedback@example.com");

    const res = await handleRequest(
      surveyPost({ id, feedback: "a".repeat(600) }),
      deps,
    );

    expect(res.status).toBe(204);
    const stored = JSON.parse((await db.getWaitlistById(id))?.survey_json ?? "") as {
      feedback: string;
    };
    expect(stored.feedback).toHaveLength(500);
  });

  it("id but no survey fields → 204, survey_json stays null (nothing clobbered)", async () => {
    const { db, deps } = setup();
    const id = await signup(deps, "empty-survey@example.com");

    expect((await handleRequest(surveyPost({ id }), deps)).status).toBe(204);
    expect((await db.getWaitlistById(id))?.survey_json).toBeNull();
  });

  it("an empty re-submit does not clobber answers already stored", async () => {
    const { db, deps } = setup();
    const id = await signup(deps, "resubmit@example.com");
    await handleRequest(surveyPost({ id, donate: true }), deps);

    // Second submit with no fields at all: answers from the first survive.
    expect((await handleRequest(surveyPost({ id }), deps)).status).toBe(204);
    expect(JSON.parse((await db.getWaitlistById(id))?.survey_json ?? "")).toEqual({
      donate: true,
    });
  });

  it("wrong-typed values are dropped, not stored and not a 500", async () => {
    const { db, deps } = setup();
    const id = await signup(deps, "types@example.com");

    const res = await handleRequest(
      surveyPost({ id, willing_to_pay: 5, use_cases: "all", donate: "yes", feedback: {} }),
      deps,
    );

    expect(res.status).toBe(204);
    expect((await db.getWaitlistById(id))?.survey_json).toBeNull();
  });

  it("non-string use_cases items are filtered out", async () => {
    const { db, deps } = setup();
    const id = await signup(deps, "uc@example.com");

    const res = await handleRequest(
      surveyPost({ id, use_cases: ["progress", 7, null, "all"] }),
      deps,
    );

    expect(res.status).toBe(204);
    expect(JSON.parse((await db.getWaitlistById(id))?.survey_json ?? "")).toEqual({
      use_cases: ["progress", "all"],
    });
  });

  it("oversized declared body → 413 (the shared capped reader)", async () => {
    const { deps } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/waitlist/survey`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(64 * 1024) },
        body: JSON.stringify({ id: "wl_x" }),
      }),
      deps,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body too large" });
  });
});

// Copilot round 2, finding 1: readJsonBody() read and JSON.parse'd an
// unbounded body. The email length cap runs AFTER that, so /waitlist — public
// and unauthenticated — let a stranger make the Worker buffer and parse
// megabytes for free. This Worker shares its D1 with the provisioning control
// plane, so that is CPU/memory amplification against provisioning too.
describe("request body size cap", () => {
  function waitlistPost(email: unknown): Request {
    return new Request(`${BASE}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  /** A body far above MAX_JSON_BODY_BYTES (8 KB) but cheap to build. */
  const oversizedJson = (): string => JSON.stringify({ email: "a".repeat(64 * 1024) });

  /** Streams `text` so the Request carries NO content-length (chunked). */
  function chunkedRequest(
    url: string,
    text: string,
    headers: Record<string, string> = {},
  ): Request {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      // Required by undici/workerd for a streaming request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  it("declared Content-Length over the cap → 413, before the body is read", async () => {
    const { deps } = setup();
    // Body is never sent — only the header claims the size. A cap that is
    // enforced purely post-read would have nothing to reject here.
    const res = await handleRequest(
      new Request(`${BASE}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(64 * 1024) },
        body: JSON.stringify({ email: "ok@example.com" }),
      }),
      deps,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body too large" });
  });

  it("oversized actual body with NO Content-Length (chunked) → 413", async () => {
    const { db, deps } = setup();

    const res = await handleRequest(
      chunkedRequest(`${BASE}/waitlist`, oversizedJson()),
      deps,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body too large" });
    expect(await db.countWaitlist(1)).toBe(0);
  });

  it("oversized actual body behind a LYING small Content-Length → 413", async () => {
    const { db, deps } = setup();
    // The header cannot be trusted: it says 12 bytes, the stream delivers 64 KB.
    const res = await handleRequest(
      chunkedRequest(`${BASE}/waitlist`, oversizedJson(), { "content-length": "12" }),
      deps,
    );

    expect(res.status).toBe(413);
    expect(await db.countWaitlist(1)).toBe(0);
  });

  it("counts BYTES, not UTF-16 code units (multibyte payload under the char count)", async () => {
    const { deps } = setup();
    // 4 KB of 3-byte characters = 12 KB on the wire but only ~4k `.length`.
    // A `text.length` cap would wave this through; a byte cap must not.
    const res = await handleRequest(
      chunkedRequest(`${BASE}/waitlist`, JSON.stringify({ email: "中".repeat(4096) })),
      deps,
    );

    expect(res.status).toBe(413);
  });

  it("a normal small body still succeeds on POST /waitlist", async () => {
    const { db, deps } = setup();
    const res = await handleRequest(waitlistPost("small@example.com"), deps);
    expect(res.status).toBe(201);
    expect(await db.countWaitlist(1)).toBe(1);
  });

  // The cap lives in the shared helper, so the two admin call sites get it too
  // and must keep working. Both are bearer-authenticated; the cap is not their
  // threat model, but a regression here would break the admin console.
  it("a normal small body still succeeds on POST /api/admin/invites", async () => {
    const { deps } = setup();
    const res = await createInviteViaApi(deps, { email: "admin@example.com", slug: "alice" });
    expect(res.status).toBe(201);
  });

  it("a normal small body still succeeds on POST /api/admin/invites/:id/provision", async () => {
    const { deps } = setup();
    const created = (await (
      await createInviteViaApi(deps, { email: "admin@example.com" })
    ).json()) as InviteCreated;

    const res = await provisionViaApi(deps, created.id, { slug: "bob" });

    expect(res.status).toBe(200);
  });

  it("oversized body on POST /api/admin/invites → 413 (helper is shared)", async () => {
    const { deps } = setup();
    const res = await handleRequest(
      chunkedRequest(`${BASE}/api/admin/invites`, oversizedJson(), {
        authorization: `Bearer ${ADMIN}`,
      }),
      deps,
    );
    expect(res.status).toBe(413);
  });

  // POST /api/instance/status is deliberately NOT in this list: it never reads
  // its body at all (no readJsonBody call — it authenticates by header and
  // returns 204), so there is nothing to buffer and nothing to amplify. The
  // test below pins that, so if someone later adds a body read they get a
  // failing test telling them to route it through the capped helper.
  it("POST /api/instance/status ignores its body entirely, so a huge one is not read", async () => {
    const { deps } = setup();
    const seeded = await seedProvisioned(deps);
    const req = chunkedRequest(
      `${BASE}/api/instance/status`,
      JSON.stringify({ version: "1".repeat(64 * 1024), uptime_seconds: 1 }),
      { authorization: `Bearer ${seeded.token}` },
    );

    const res = await handleRequest(req, deps);

    expect(res.status).toBe(204);
    // Never consumed → never buffered. This is the property that makes the
    // absence of a cap on this route safe.
    expect(req.bodyUsed).toBe(false);
  });

  it("a body at exactly the cap is accepted; one byte over is not", async () => {
    const { deps } = setup();
    const overhead = JSON.stringify({ email: "", pad: "" }).length;
    const atCap = JSON.stringify({
      email: "edge@example.com",
      pad: "a".repeat(MAX_JSON_BODY_BYTES - overhead - "edge@example.com".length),
    });
    expect(new TextEncoder().encode(atCap).byteLength).toBe(MAX_JSON_BODY_BYTES);

    expect((await handleRequest(chunkedRequest(`${BASE}/waitlist`, atCap), deps)).status).toBe(201);

    const overCap = `${atCap.slice(0, -2)}a"}`;
    expect(new TextEncoder().encode(overCap).byteLength).toBe(MAX_JSON_BODY_BYTES + 1);
    expect((await handleRequest(chunkedRequest(`${BASE}/waitlist`, overCap), deps)).status).toBe(
      413,
    );
  });
});

// Cloudflare Turnstile gate on the public signup funnel (bot protection).
// Active ONLY when BOTH turnstileSitekey (public var) and turnstileSecret
// (wrangler secret) are configured in deps — either missing → the route
// behaves exactly as before and siteverify is never called.
describe("POST /waitlist Turnstile gate", () => {
  const TS_SITEKEY = "0x4AAAAAAD-wkGraJigl3YK0-gate-fixture";
  const TS_SECRET = "turnstile-secret-gate-fixture"; // fixture only — must never leak into responses/logs

  function tsDeps(deps: RouteDeps): RouteDeps {
    return { ...deps, turnstileSitekey: TS_SITEKEY, turnstileSecret: TS_SECRET };
  }

  function waitlistPost(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`${BASE}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  /** Stubs global fetch to explode — the gate must never reach siteverify. */
  function forbidFetch() {
    const spy = vi.fn(() => {
      throw new Error("fetch must not be called in this scenario");
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  function siteverifyJson(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("configured + missing/empty/non-string token → 400 turnstile required, siteverify never called, nothing stored", async () => {
    const { db, deps } = setup();
    const fetchSpy = forbidFetch();
    for (const body of [
      { email: "a@example.com" },
      { email: "a@example.com", turnstile_token: "" },
      { email: "a@example.com", turnstile_token: "   " },
      { email: "a@example.com", turnstile_token: 42 },
    ]) {
      const res = await handleRequest(waitlistPost(body), tsDeps(deps));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "turnstile required" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.countWaitlist(1)).toBe(0);
  });

  it("configured + siteverify success:false → 403 turnstile failed, nothing stored", async () => {
    const { db, deps } = setup();
    vi.stubGlobal("fetch", async () =>
      siteverifyJson({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    const res = await handleRequest(
      waitlistPost({ email: "bot@example.com", turnstile_token: "tok-bad" }),
      tsDeps(deps),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "turnstile failed" });
    expect(await db.countWaitlist(1)).toBe(0);
  });

  it("configured + siteverify success:true → 201; request is form-encoded with secret+token+remoteip and a timeout signal", async () => {
    const { deps } = setup();
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url:
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        init,
      });
      return siteverifyJson({ success: true });
    });
    const res = await handleRequest(
      waitlistPost(
        { email: "human@example.com", turnstile_token: "tok-ok" },
        { "cf-connecting-ip": "203.0.113.9" },
      ),
      tsDeps(deps),
    );
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    const form = new URLSearchParams(call.init?.body as string);
    expect(form.get("secret")).toBe(TS_SECRET);
    expect(form.get("response")).toBe("tok-ok");
    expect(form.get("remoteip")).toBe("203.0.113.9");
    // Project rule: every external HTTP call is bounded by a timeout signal.
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("configured + siteverify network/timeout error → 403 fail closed, and the secret/token leak into neither response nor logs", async () => {
    const { db, deps } = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    const res = await handleRequest(
      waitlistPost({ email: "human@example.com", turnstile_token: "tok-leakcheck" }),
      tsDeps(deps),
    );
    expect(res.status).toBe(403);
    const bodyText = JSON.stringify(await res.json());
    expect(bodyText).not.toContain(TS_SECRET);
    expect(bodyText).not.toContain("tok-leakcheck");
    expect(await db.countWaitlist(1)).toBe(0);
    // Fail-closed was logged — but the log carries neither the secret nor the token.
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
    expect(logged).not.toContain(TS_SECRET);
    expect(logged).not.toContain("tok-leakcheck");
  });

  it("an invalid email gets its plain 400 WITHOUT consuming the single-use token (shape validated before the gate)", async () => {
    // siteverify tokens are single-use: burning one on a request that was
    // doomed on email shape would 403 the user's corrected retry. The gate
    // therefore runs after the cheap shape checks, before any db work.
    const { deps } = setup();
    const fetchSpy = forbidFetch();
    const res = await handleRequest(waitlistPost({ email: "not-an-email" }), tsDeps(deps));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid email" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 运维可观测性：CF 挂掉 / secret 配错 与「来的全是机器人」在 fail-closed
  // 之下产生完全相同的用户可见结果（403）。若日志也一样，报名漏斗静默归零
  // 且无人知情。基础设施异常必须留下 console.error，且绝不带 secret/token。
  it("siteverify non-2xx → still 403 (fail closed) but logs an error carrying the status, never the secret/token", async () => {
    const { db, deps } = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("upstream boom", { status: 502 }));
    const res = await handleRequest(
      waitlistPost({ email: "human@example.com", turnstile_token: "tok-502" }),
      tsDeps(deps),
    );
    expect(res.status).toBe(403);
    expect(await db.countWaitlist(1)).toBe(0);
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/502/);
    expect(logged).not.toContain(TS_SECRET);
    expect(logged).not.toContain("tok-502");
  });

  it("siteverify 200 with a non-JSON body → 403 and an error log (not silently indistinguishable from a bot)", async () => {
    const { deps } = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      async () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const res = await handleRequest(
      waitlistPost({ email: "human@example.com", turnstile_token: "tok-html" }),
      tsDeps(deps),
    );
    expect(res.status).toBe(403);
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain(TS_SECRET);
    expect(logged).not.toContain("tok-html");
  });

  it("success:false carrying a CONFIG error-code (invalid-input-secret) is logged — a misconfigured secret must not look like bot traffic", async () => {
    const { deps } = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () =>
      siteverifyJson({ success: false, "error-codes": ["invalid-input-secret"] }),
    );
    const res = await handleRequest(
      waitlistPost({ email: "human@example.com", turnstile_token: "tok-cfg" }),
      tsDeps(deps),
    );
    expect(res.status).toBe(403);
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/invalid-input-secret/);
    expect(logged).not.toContain(TS_SECRET);
    expect(logged).not.toContain("tok-cfg");
  });

  it("a plain bot rejection (invalid-input-response) stays quiet — no error spam on the normal path", async () => {
    const { deps } = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () =>
      siteverifyJson({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    const res = await handleRequest(
      waitlistPost({ email: "bot@example.com", turnstile_token: "tok-bot" }),
      tsDeps(deps),
    );
    expect(res.status).toBe(403);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("a DOMException-like timeout is logged by NAME, not as \"unknown error\"", async () => {
    const { deps } = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Some runtimes' DOMException is not `instanceof Error`; the logger must
    // still surface TimeoutError instead of a useless "unknown error".
    vi.stubGlobal("fetch", async () => {
      throw { name: "TimeoutError", message: "The operation was aborted due to timeout" };
    });
    const res = await handleRequest(
      waitlistPost({ email: "human@example.com", turnstile_token: "tok-timeout" }),
      tsDeps(deps),
    );
    expect(res.status).toBe(403);
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/TimeoutError/);
    expect(logged).not.toMatch(/unknown error/);
  });

  // wrangler secret put 从文件/echo 灌进来时极易带上尾换行。带空白的 secret
  // 会让门「开着但永远验不过」——报名漏斗 100% 静默死，且用户侧只看到 403。
  it("secret with surrounding whitespace: gate stays on and siteverify receives the TRIMMED secret", async () => {
    const { db, deps } = setup();
    let sentSecret: string | null = null;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      sentSecret = new URLSearchParams(String(init?.body ?? "")).get("secret");
      return siteverifyJson({ success: true });
    });
    const res = await handleRequest(
      waitlistPost({ email: "human@example.com", turnstile_token: "tok-ws" }),
      { ...deps, turnstileSitekey: TS_SITEKEY, turnstileSecret: `  ${TS_SECRET}\n` },
    );
    expect(res.status).toBe(201);
    expect(sentSecret).toBe(TS_SECRET);
    expect(await db.countWaitlist(1)).toBe(1);
  });

  it("whitespace-only secret counts as UNCONFIGURED (gate off), never as a usable secret", async () => {
    const { db, deps } = setup();
    const fetchSpy = forbidFetch();
    const res = await handleRequest(waitlistPost({ email: "free@example.com" }), {
      ...deps,
      turnstileSitekey: TS_SITEKEY,
      turnstileSecret: "   \n",
    });
    expect(res.status).toBe(201); // 门关着=按未配置处理，报名照常
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.countWaitlist(1)).toBe(1);
  });

  it("whitespace-only secret also keeps the widget OFF the page (page and gate stay in lockstep)", async () => {
    const { deps } = setup();
    const page = await handleRequest(new Request(`${BASE}/beta`), {
      ...deps,
      turnstileSitekey: TS_SITEKEY,
      turnstileSecret: "   ",
    });
    expect(await page.text()).not.toContain("cf-turnstile");
  });

  it("unconfigured (no turnstile deps) → unchanged behavior, fetch NEVER called", async () => {
    const { db, deps } = setup();
    const fetchSpy = forbidFetch();
    const res = await handleRequest(waitlistPost({ email: "free@example.com" }), deps);
    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.countWaitlist(1)).toBe(1);
  });

  it("only one half configured → gate stays OFF (both sitekey and secret are required)", async () => {
    const { db, deps } = setup();
    const fetchSpy = forbidFetch();
    // Sitekey without secret: the page mints tokens nobody can verify; secret
    // without sitekey: no widget exists to mint tokens. Enforcing in either
    // misconfiguration would 400 every signup — the gate must stay off.
    const sitekeyOnly = await handleRequest(waitlistPost({ email: "k@example.com" }), {
      ...deps,
      turnstileSitekey: TS_SITEKEY,
    });
    expect(sitekeyOnly.status).toBe(201);
    const secretOnly = await handleRequest(waitlistPost({ email: "s@example.com" }), {
      ...deps,
      turnstileSecret: TS_SECRET,
    });
    expect(secretOnly.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.countWaitlist(1)).toBe(2);
  });

  it("malformed sitekey (even with secret) → gate OFF consistently: no widget AND signup passes", async () => {
    // 页面侧 trim + 字符集校验会拒绝畸形 sitekey（不渲染 widget）；
    // 门侧若只看 truthy 就会开着——用户没有任何途径拿 token，报名全 400。
    // 两侧必须归一到同一个判定（Copilot PR #184 round 2）。
    const { db, deps } = setup();
    const fetchSpy = forbidFetch();
    const messy = { ...deps, turnstileSitekey: ' x"><script>', turnstileSecret: TS_SECRET };
    const page = await handleRequest(new Request(`${BASE}/beta`), messy);
    expect(await page.text()).not.toContain("cf-turnstile");
    const res = await handleRequest(waitlistPost({ email: "no-widget@example.com" }), messy);
    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.countWaitlist(1)).toBe(1);
  });

  it("GET /beta renders the widget only when BOTH halves are configured", async () => {
    const { deps } = setup();
    const both = await handleRequest(new Request(`${BASE}/beta`), tsDeps(deps));
    expect(await both.text()).toContain(`data-sitekey="${TS_SITEKEY}"`);

    const sitekeyOnly = await handleRequest(new Request(`${BASE}/beta`), {
      ...deps,
      turnstileSitekey: TS_SITEKEY,
    });
    expect(await sitekeyOnly.text()).not.toContain("cf-turnstile");

    const secretOnly = await handleRequest(new Request(`${BASE}/beta`), {
      ...deps,
      turnstileSecret: TS_SECRET,
    });
    expect(await secretOnly.text()).not.toContain("cf-turnstile");

    const neither = await handleRequest(new Request(`${BASE}/beta`), deps);
    expect(await neither.text()).not.toContain("cf-turnstile");
  });
});
