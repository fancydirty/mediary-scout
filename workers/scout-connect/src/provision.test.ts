import { describe, it, expect } from "vitest";
import { provisionEndpoint, type ProvisionDeps } from "./provision.js";
import { createMemoryConnectDb, type ConnectDb, type InviteRow } from "./db.js";
import type { CfApi } from "./cf-api.js";

const NOW = "2026-07-24T10:00:00.000Z";
const WRAP_KEY = "00".repeat(32);
const PLAIN_TOKEN = "tok-plain-1";

function makePendingInvite(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: "inv_1",
    code: "code-abc",
    invitee_label: "Alice",
    email: "alice@example.com",
    slug: null,
    status: "pending",
    created_at: "2026-07-24T00:00:00.000Z",
    provisioned_at: null,
    revoked_at: null,
    ...overrides,
  };
}

interface FakeCfOptions {
  // "access" is retained deliberately: provisioning no longer creates an Access
  // app, and the test that sets it asserts exactly that (a throwing
  // createAccessApp changes nothing because it is never called). deleteAccessApp
  // is still real API surface — revoke.ts calls it for pre-removal endpoints.
  failOn?: "ingress" | "access" | "dns";
}

function makeFakeCf(calls: string[], opts: FakeCfOptions = {}): CfApi {
  return {
    async createTunnel(name) {
      calls.push(`tunnel:${name}`);
      return { tunnelId: "tid-1", token: PLAIN_TOKEN };
    },
    async getTunnelToken(tunnelId) {
      calls.push(`getToken:${tunnelId}`);
      return PLAIN_TOKEN;
    },
    async putTunnelIngress(tunnelId, hostname) {
      calls.push(`ingress:${tunnelId}:${hostname}`);
      if (opts.failOn === "ingress") throw new Error("cf ingress boom");
    },
    async createAccessApp(input) {
      calls.push(`access:${input.domain}:${input.email}`);
      if (opts.failOn === "access") throw new Error("cf access boom");
      return { appId: "app-1", policyId: "pol-1" };
    },
    async createDnsCname(slug, tunnelId) {
      calls.push(`dns:${slug}:${tunnelId}`);
      if (opts.failOn === "dns") throw new Error("cf dns boom");
      return { recordId: "rec-1" };
    },
    async deleteTunnel(tunnelId) {
      calls.push(`del-tunnel:${tunnelId}`);
    },
    async deleteDnsRecord(recordId) {
      calls.push(`del-dns:${recordId}`);
    },
    async deleteAccessApp(appId) {
      calls.push(`del-access:${appId}`);
    },
  };
}

function makeDeps(db: ConnectDb, cf: CfApi): ProvisionDeps {
  return {
    cf,
    db,
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: WRAP_KEY,
    now: () => NOW,
    newEndpointId: () => "ep_test1",
    newAuditId: () => "aud_test1",
  };
}

function countCalls(calls: string[], prefix: string): number {
  return calls.filter((c) => c.startsWith(prefix)).length;
}

describe("provisionEndpoint", () => {
  it("happy path: ordered cf calls, persists endpoint/invite/audit, never persists plaintext token", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    const result = await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps });

    expect(calls).toEqual([
      "tunnel:scout-alice",
      "ingress:tid-1:alice.mediaryconnect.app",
      "dns:alice:tid-1",
    ]);

    expect(result.endpointId).toBe("ep_test1");
    expect(result.inviteCode).toBe("code-abc");
    expect(result.hostname).toBe("alice.mediaryconnect.app");
    expect(result.token).toBe(PLAIN_TOKEN);
    expect(result.agentPrompt).toContain("alice.mediaryconnect.app");

    const endpoint = await db.getEndpointById("ep_test1");
    expect(endpoint).not.toBeNull();
    expect(endpoint?.status).toBe("active");
    // P4: token 不落库,只留 sha256 供心跳反查。
    expect(endpoint?.token_ciphertext).toBeNull();
    expect(endpoint?.token_sha256).toBeTruthy();
    expect(endpoint?.token_shown_at).toBeNull();
    expect(endpoint?.invite_id).toBe("inv_1");
    expect(endpoint?.slug).toBe("alice");
    expect(endpoint?.hostname).toBe("alice.mediaryconnect.app");
    expect(endpoint?.cf_tunnel_id).toBe("tid-1");
    expect(endpoint?.cf_access_app_id).toBeNull();
    expect(endpoint?.cf_access_policy_id).toBeNull();
    expect(endpoint?.cf_dns_record_id).toBe("rec-1");
    expect(endpoint?.created_at).toBe(NOW);
    expect(endpoint?.revoked_at).toBeNull();

    // The plaintext token must never touch the db.
    expect(JSON.stringify(await db.listEndpoints())).not.toContain(PLAIN_TOKEN);

    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("provisioned");
    expect(invite?.slug).toBe("alice");
    expect(invite?.provisioned_at).toBe(NOW);

    const audits = await db.listAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("endpoint.provision");
    expect(audits[0]?.actor).toBe("admin");
    expect(audits[0]?.invite_id).toBe("inv_1");
    expect(audits[0]?.endpoint_id).toBe("ep_test1");
    expect(audits[0]?.detail_json ?? "").not.toContain(PLAIN_TOKEN);
    expect(audits[0]?.detail_json ?? "").toContain("alice.mediaryconnect.app");
  });

  // Regression guard for the Access removal: a CfApi whose createAccessApp
  // would throw must make no difference, because provisioning never calls it.
  // (This test used to be "access failure: deletes tunnel exactly once, never
  // touches dns/access deletes, persists nothing" — a name describing the
  // pre-removal behaviour, while every assertion below checks the happy path.)
  it("succeeds even when createAccessApp would fail, because it is never called", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "access" }));

    const result = await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps });

    expect(result.hostname).toBe("alice.mediaryconnect.app");
    expect(countCalls(calls, "access:")).toBe(0);
    expect(await db.listEndpoints()).toHaveLength(1);
    expect((await db.getInviteById("inv_1"))?.status).toBe("provisioned");
  });

  it("dns failure: deletes tunnel exactly once, persists nothing", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "dns" }));

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow("cf dns boom");

    expect(countCalls(calls, "del-tunnel")).toBe(1);
    expect(countCalls(calls, "del-dns")).toBe(0);
    expect(await db.listEndpoints()).toHaveLength(0);
    expect((await db.getInviteById("inv_1"))?.status).toBe("pending");
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("ingress failure: deletes tunnel exactly once, creates no dns (and no access app, which is never created anyway)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "ingress" }));

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow("cf ingress boom");

    expect(countCalls(calls, "del-tunnel")).toBe(1);
    expect(countCalls(calls, "del-access")).toBe(0);
    expect(countCalls(calls, "del-dns")).toBe(0);
    expect(countCalls(calls, "access:")).toBe(0);
    expect(countCalls(calls, "dns:")).toBe(0);
    expect(await db.listEndpoints()).toHaveLength(0);
    expect((await db.getInviteById("inv_1"))?.status).toBe("pending");
  });

  it("throws when invite is not found, before any cf call", async () => {
    const db = createMemoryConnectDb();
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "missing" }, slug: "alice", deps }),
    ).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(0);
  });

  it("throws when invite is not pending, before any cf call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite({ status: "provisioned" }));
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow(/not pending/);
    expect(calls).toHaveLength(0);
  });

  it("throws on reserved slug, before any cf call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "Admin", deps }),
    ).rejects.toThrow(/reserved slug/);
    expect(calls).toHaveLength(0);
  });

  it("token is NOT persisted (P4): ciphertext null, only sha256 kept for heartbeat lookup", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const deps = makeDeps(db, makeFakeCf([]));

    const result = await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps });

    const endpoint = await db.getEndpointById(result.endpointId);
    expect(endpoint?.token_ciphertext).toBeNull();
    expect(endpoint?.token_sha256).toBeTruthy();
    // 明文 token 只作返回值,决不出现在任何持久化行里
    expect(JSON.stringify(await db.listEndpoints())).not.toContain(result.token);
  });

  it("hostname conflict error names the hostname, not the slug", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));
    // pre-seed an endpoint whose hostname collides but slug differs
    await db.insertEndpoint({
      id: "ep_other",
      invite_id: "inv_other",
      slug: "other",
      hostname: "alice.mediaryconnect.app",
      cf_tunnel_id: "tid-x",
      cf_access_app_id: "app-x",
      cf_access_policy_id: null,
      cf_dns_record_id: "rec-x",
      status: "active",
      token_sha256: "x",
      token_ciphertext: null,
      token_shown_at: null,
      created_at: NOW,
      revoked_at: null,
      last_seen_at: null, account_id: null, grace_until: null, suspended_at: null, purge_after: null,
    });

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow(/hostname already in use/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a slug already used by an existing endpoint before any cf call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));
    await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps });

    await db.insertInvite(makePendingInvite({ id: "inv_2", code: "code-def" }));
    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_2" }, slug: "alice", deps }),
    ).rejects.toThrow(/already in use/);
    // only the first provision's cf calls exist — no second tunnel was created
    expect(countCalls(calls, "tunnel:")).toBe(1);
  });

  it("D1 write failure: best-effort deletes dns/tunnel and audits provision.orphan", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    // first provision occupies the endpoint id so the retry's insertEndpoint
    // dies on the endpoints.id PRIMARY KEY after CF resources already exist
    await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps });

    await db.insertInvite(makePendingInvite({ id: "inv_2", code: "code-def" }));
    const otherDeps = {
      ...makeDeps(db, makeFakeCf(calls)),
      newEndpointId: () => "ep_test1", // collides with the existing row
      newAuditId: () => "aud_test2",
    };
    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_2" }, slug: "bob", deps: otherDeps }),
    ).rejects.toThrow(/UNIQUE/i);

    // second tunnel's full resource set was cleaned up
    const secondTunnelCalls = calls.filter((c) => c.startsWith("tunnel:")).length;
    expect(secondTunnelCalls).toBe(2);
    expect(countCalls(calls, "del-dns:")).toBe(1);
    expect(countCalls(calls, "del-tunnel:")).toBe(1);

    // orphan audit row recorded, carrying cf ids for forensics, no plaintext token
    const audits = await db.listAudits();
    const orphan = audits.find((a) => a.action === "provision.orphan");
    expect(orphan).toBeDefined();
    expect(orphan?.actor).toBe("system");
    expect(orphan?.invite_id).toBe("inv_2");
    expect(orphan?.detail_json).toContain("tid-1");
    expect(orphan?.detail_json).toContain("rec-1");
    expect(orphan?.detail_json).not.toContain("app-1");
    expect(JSON.stringify(orphan)).not.toContain(PLAIN_TOKEN);

    // invite stays pending so the admin can retry
    expect((await db.getInviteById("inv_2"))?.status).toBe("pending");
  });

  // Same-invite double-provision race (admin double-clicks 开通 — the button
  // was never disabled): both requests pass the prechecks while the invite is
  // still pending, both create CF resources, the winner commits, and the loser
  // dies on `UNIQUE … endpoints.invite_id`. The loser's compensation must NOT
  // flip the invite back to pending — that would orphan the winner's live
  // endpoint (invite page shows "waiting" forever, reveal 409s, re-provision
  // 500s on UNIQUE). The existing race tests above use a DIFFERENT invite;
  // this one pins the same-invite case.
  it("same-invite race: loser's compensation leaves the winner's invite provisioned", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    // Winner runs to completion.
    await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps });
    expect((await db.getInviteById("inv_1"))?.status).toBe("provisioned");

    // Loser: its precheck reads happened BEFORE the winner committed — model
    // the race window with stale reads (invite still pending, slug still free).
    // Everything else goes to the real db, so the INSERT hits the winner's row.
    const staleDb: ConnectDb = {
      ...db,
      async getInviteById(id) {
        const row = await db.getInviteById(id);
        return row === null ? null : { ...row, status: "pending" };
      },
      async findEndpointBySlugOrHostname() {
        return null;
      },
    };
    const loserDeps = {
      ...makeDeps(db, makeFakeCf(calls)),
      newEndpointId: () => "ep_loser",
      newAuditId: () => "aud_loser",
    };
    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps: { ...loserDeps, db: staleDb } }),
    ).rejects.toThrow(/UNIQUE/i);

    // The winner's state must survive the loser's compensation untouched.
    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("provisioned");
    expect(invite?.slug).toBe("alice");
    expect(invite?.provisioned_at).toBe(NOW);
    expect(await db.getEndpointByInviteId("inv_1")).not.toBeNull();
    // The loser's own CF resources were still cleaned up.
    expect(countCalls(calls, "del-dns:")).toBe(1);
    expect(countCalls(calls, "del-tunnel:")).toBe(1);
  });

  it("D1 failure compensation still throws the original error when cf deletes also fail", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const base = makeFakeCf(calls);
    const failingDeletes: CfApi = {
      ...base,
      async deleteTunnel() {
        calls.push("del-tunnel:boom");
        throw new Error("delete tunnel boom");
      },
      async deleteDnsRecord() {
        calls.push("del-dns:boom");
        throw new Error("delete dns boom");
      },
      async deleteAccessApp() {
        calls.push("del-access:boom");
        throw new Error("delete access boom");
      },
    };
    const deps = {
      ...makeDeps(db, failingDeletes),
      newEndpointId: () => "ep_test1",
    };
    // first, occupy the endpoint id so the insert fails
    await provisionEndpoint({
      origin: { kind: "invite", inviteId: "inv_1" },
      slug: "alice",
      deps: makeDeps(db, makeFakeCf([])),
    });
    await db.insertInvite(makePendingInvite({ id: "inv_2", code: "code-def" }));

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_2" }, slug: "bob", deps }),
    ).rejects.toThrow(/UNIQUE/i);
    expect(calls).toContain("del-dns:boom");
    expect(calls).toContain("del-tunnel:boom");
  });

  it("updateInviteStatus failure after successful insert: phantom row removed, cf cleaned, retry possible", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    // poison updateInviteStatus to fail once
    const inner = db;
    const failingDb: ConnectDb = {
      ...inner,
      async updateInviteStatus(id, patch) {
        throw new Error("d1 update boom");
      },
    };
    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps: { ...deps, db: failingDb } }),
    ).rejects.toThrow(/d1 update boom/);

    // phantom endpoint row removed
    expect(await db.listEndpoints()).toHaveLength(0);
    // full cf resource set cleaned
    expect(countCalls(calls, "del-dns:")).toBe(1);
    expect(countCalls(calls, "del-tunnel:")).toBe(1);
    // invite still pending, and a retry with the same slug now succeeds
    expect((await db.getInviteById("inv_1"))?.status).toBe("pending");
    const retryDeps = { ...deps, newEndpointId: () => "ep_retry", newAuditId: () => "aud_retry" };
    const retry = await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps: retryDeps });
    expect(retry.hostname).toBe("alice.mediaryconnect.app");
    expect(await db.listEndpoints()).toHaveLength(1);
  });

  it("persistence-phase failure (insertEndpoint throws) still cleans up cf resources", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    // P4 起 token 不再加密落库,原「wrap key 配错」失败路径消失。但持久化阶段
    // 仍可能失败(D1 挂),补偿逻辑必须照样删掉已建的 CF 资源。用 insertEndpoint
    // 抛错模拟持久化失败。
    const failingDb: ConnectDb = {
      ...db,
      async insertEndpoint(): Promise<never> {
        throw new Error("d1 insert boom");
      },
    };
    const deps = { ...makeDeps(failingDb, makeFakeCf(calls)) };

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow();

    expect(countCalls(calls, "tunnel:")).toBe(1);
    expect(countCalls(calls, "del-dns:")).toBe(1);
    expect(countCalls(calls, "del-tunnel:")).toBe(1);
    expect(await db.listEndpoints()).toHaveLength(0);
    const audits = await db.listAudits();
    expect(audits.some((a) => a.action === "provision.orphan")).toBe(true);
  });

  it("insertAudit fails AND deleteEndpoint also fails: invite STILL rolls back (phantom row is revocable)", async () => {
    // The rollback guard exists to protect the RACE WINNER's row (a different
    // endpointId). It must not protect OUR OWN attempt's row: when our own
    // deleteEndpoint compensation fails, the surviving row points at CF
    // resources the compensation is about to delete — leaving the invite
    // provisioned would let reveal hand out a token for a dead tunnel.
    // Rolling the invite back is strictly better: the phantom row stays
    // visible in the admin endpoints list and revoke is 404-idempotent.
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    const inner = db;
    const failingDb: ConnectDb = {
      ...inner,
      async insertAudit() {
        throw new Error("d1 audit boom");
      },
      async deleteEndpoint() {
        throw new Error("d1 delete boom");
      },
    };
    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps: { ...deps, db: failingDb } }),
    ).rejects.toThrow(/d1 audit boom/);

    // invite rolled back (NOT stuck provisioned pointing at deleted resources)
    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("pending");
    expect(invite?.slug).toBeNull();
    expect(invite?.provisioned_at).toBeNull();
    // our own phantom row survives (delete failed) — visible, revocable later
    expect(await db.listEndpoints()).toHaveLength(1);
    // cf resources still cleaned up
    expect(countCalls(calls, "del-dns:")).toBe(1);
    expect(countCalls(calls, "del-tunnel:")).toBe(1);
  });

  it("insertAudit failure after invite flip: invite rolled back to pending, endpoint row gone, retry succeeds", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    // poison ONLY insertAudit — updateInviteStatus succeeds first
    const inner = db;
    const failingAuditDb: ConnectDb = {
      ...inner,
      async insertAudit() {
        throw new Error("d1 audit boom");
      },
    };
    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps: { ...deps, db: failingAuditDb } }),
    ).rejects.toThrow(/d1 audit boom/);

    // invite rolled back to pending (not stuck provisioned-without-endpoint)
    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("pending");
    expect(invite?.slug).toBeNull();
    expect(invite?.provisioned_at).toBeNull();
    // phantom endpoint row removed
    expect(await db.listEndpoints()).toHaveLength(0);
    // cf resources cleaned
    expect(countCalls(calls, "del-dns:")).toBe(1);
    expect(countCalls(calls, "del-tunnel:")).toBe(1);

    // retry works end-to-end
    const retryDeps = { ...deps, newEndpointId: () => "ep_retry", newAuditId: () => "aud_retry" };
    const retry = await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps: retryDeps });
    expect(retry.hostname).toBe("alice.mediaryconnect.app");
    expect(await db.listEndpoints()).toHaveLength(1);
  });

  it("dns failure + deleteTunnel also throws: ORIGINAL dns error propagates, delete still attempted", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const base = makeFakeCf(calls, { failOn: "dns" });
    const cf: CfApi = {
      ...base,
      async deleteTunnel(tunnelId) {
        calls.push(`del-tunnel:${tunnelId}:boom`);
        throw new Error("delete tunnel boom");
      },
    };
    const deps = makeDeps(db, cf);

    // Compensation is BEST EFFORT: a failing deleteTunnel must never displace
    // the failure that triggered the rollback, or the caller is told "delete
    // tunnel boom" when the real problem was "cf dns boom". (This test used to
    // assert the opposite — it pinned that bug as the contract.)
    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow(/cf dns boom/);
    // ...but the delete must still have been ATTEMPTED. Twice, deliberately:
    // deleteTunnelOnce() latches only AFTER a successful await, so the inner
    // catch's failed attempt leaves the flag unset and the outer catch retries
    // it (deletion is 404-idempotent, so a retry is free).
    expect(countCalls(calls, "del-tunnel:")).toBe(2);
  });

  it("dns failure + deleteTunnel transiently failing then succeeding: latch stops after the retry", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const base = makeFakeCf(calls, { failOn: "dns" });
    let attempts = 0;
    const cf: CfApi = {
      ...base,
      async deleteTunnel(tunnelId) {
        attempts += 1;
        if (attempts === 1) {
          calls.push(`del-tunnel:${tunnelId}:transient`);
          throw new Error("delete tunnel transient");
        }
        calls.push(`del-tunnel:${tunnelId}`);
      },
    };
    const deps = makeDeps(db, cf);

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow(/cf dns boom/);
    // inner catch failed → outer catch retried → succeeded → latch set. No third call.
    expect(countCalls(calls, "del-tunnel:")).toBe(2);
  });

  it("ingress failure + deleteTunnel also throws: ORIGINAL ingress error propagates", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const base = makeFakeCf(calls, { failOn: "ingress" });
    const cf: CfApi = {
      ...base,
      async deleteTunnel(tunnelId) {
        calls.push(`del-tunnel:${tunnelId}:boom`);
        throw new Error("delete tunnel boom");
      },
    };
    const deps = makeDeps(db, cf);

    await expect(
      provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps }),
    ).rejects.toThrow(/cf ingress boom/);
    // ingress never reaches the inner try, so only the outer catch compensates
    expect(countCalls(calls, "del-tunnel:")).toBe(1);
  });

  it("no longer creates Access app; cf_access_app_id & cf_access_policy_id are null", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const cf = makeFakeCf(calls);
    const deps = makeDeps(db, cf);

    const result = await provisionEndpoint({ origin: { kind: "invite", inviteId: "inv_1" }, slug: "alice", deps });

    expect(result.hostname).toBe("alice.mediaryconnect.app");
    expect(calls.filter((c) => c.startsWith("access:"))).toHaveLength(0);

    const endpoints = await db.listEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.cf_access_app_id).toBeNull();
    expect(endpoints[0]?.cf_access_policy_id).toBeNull();
  });
});
