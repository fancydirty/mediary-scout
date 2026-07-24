import { describe, it, expect } from "vitest";
import { provisionEndpoint, type ProvisionDeps } from "./provision.js";
import { createMemoryConnectDb, type ConnectDb, type InviteRow } from "./db.js";
import type { CfApi } from "./cf-api.js";
import { unwrapToken } from "./crypto-token.js";

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
  failOn?: "ingress" | "access" | "dns";
}

function makeFakeCf(calls: string[], opts: FakeCfOptions = {}): CfApi {
  return {
    async createTunnel(name) {
      calls.push(`tunnel:${name}`);
      return { tunnelId: "tid-1", token: PLAIN_TOKEN };
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

    const result = await provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps });

    expect(calls).toEqual([
      "tunnel:scout-alice",
      "ingress:tid-1:alice.mediaryconnect.app",
      "access:alice.mediaryconnect.app:alice@example.com",
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
    expect(endpoint?.token_ciphertext).toBeTruthy();
    expect(endpoint?.token_shown_at).toBeNull();
    expect(endpoint?.invite_id).toBe("inv_1");
    expect(endpoint?.slug).toBe("alice");
    expect(endpoint?.hostname).toBe("alice.mediaryconnect.app");
    expect(endpoint?.cf_tunnel_id).toBe("tid-1");
    expect(endpoint?.cf_access_app_id).toBe("app-1");
    expect(endpoint?.cf_access_policy_id).toBe("pol-1");
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

  it("passes lowercased invite email to createAccessApp", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite({ email: "Alice@Example.COM" }));
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    await provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps });

    expect(calls).toContain("access:alice.mediaryconnect.app:alice@example.com");
  });

  it("access failure: deletes tunnel exactly once, never touches dns/access deletes, persists nothing", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "access" }));

    await expect(
      provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps }),
    ).rejects.toThrow("cf access boom");

    expect(countCalls(calls, "del-tunnel")).toBe(1);
    expect(countCalls(calls, "del-access")).toBe(0);
    expect(countCalls(calls, "del-dns")).toBe(0);
    expect(await db.listEndpoints()).toHaveLength(0);
    expect((await db.getInviteById("inv_1"))?.status).toBe("pending");
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("dns failure: deletes access app once and tunnel exactly once, persists nothing", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "dns" }));

    await expect(
      provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps }),
    ).rejects.toThrow("cf dns boom");

    expect(countCalls(calls, "del-access")).toBe(1);
    expect(countCalls(calls, "del-tunnel")).toBe(1);
    expect(countCalls(calls, "del-dns")).toBe(0);
    expect(await db.listEndpoints()).toHaveLength(0);
    expect((await db.getInviteById("inv_1"))?.status).toBe("pending");
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("ingress failure: deletes tunnel exactly once, never creates access app or dns", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "ingress" }));

    await expect(
      provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps }),
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
      provisionEndpoint({ inviteId: "missing", slug: "alice", deps }),
    ).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(0);
  });

  it("throws when invite is not pending, before any cf call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite({ status: "provisioned" }));
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    await expect(
      provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps }),
    ).rejects.toThrow(/not pending/);
    expect(calls).toHaveLength(0);
  });

  it("throws on reserved slug, before any cf call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    await expect(
      provisionEndpoint({ inviteId: "inv_1", slug: "Admin", deps }),
    ).rejects.toThrow(/reserved slug/);
    expect(calls).toHaveLength(0);
  });

  it("stored ciphertext unwraps back to the returned token", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const deps = makeDeps(db, makeFakeCf([]));

    const result = await provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps });

    const endpoint = await db.getEndpointById(result.endpointId);
    if (endpoint === null || endpoint.token_ciphertext === null) {
      throw new Error("expected persisted endpoint with ciphertext");
    }
    const unwrapped = await unwrapToken(endpoint.token_ciphertext, WRAP_KEY);
    expect(unwrapped).toBe(result.token);
  });

  it("rejects a slug already used by an existing endpoint before any cf call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));
    await provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps });

    await db.insertInvite(makePendingInvite({ id: "inv_2", code: "code-def" }));
    await expect(
      provisionEndpoint({ inviteId: "inv_2", slug: "alice", deps }),
    ).rejects.toThrow(/already in use/);
    // only the first provision's cf calls exist — no second tunnel was created
    expect(countCalls(calls, "tunnel:")).toBe(1);
  });

  it("D1 write failure: best-effort deletes dns/access/tunnel and audits provision.orphan", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makePendingInvite());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    // first provision occupies the slug so the retry's insertEndpoint dies on
    // the UNIQUE invite_id constraint after CF resources already exist
    await provisionEndpoint({ inviteId: "inv_1", slug: "alice", deps });

    await db.insertInvite(makePendingInvite({ id: "inv_2", code: "code-def" }));
    const otherDeps = {
      ...makeDeps(db, makeFakeCf(calls)),
      newEndpointId: () => "ep_test1", // collides with the existing row
      newAuditId: () => "aud_test2",
    };
    await expect(
      provisionEndpoint({ inviteId: "inv_2", slug: "bob", deps: otherDeps }),
    ).rejects.toThrow(/UNIQUE/i);

    // second tunnel's full resource set was cleaned up
    const secondTunnelCalls = calls.filter((c) => c.startsWith("tunnel:")).length;
    expect(secondTunnelCalls).toBe(2);
    expect(countCalls(calls, "del-dns:")).toBe(1);
    expect(countCalls(calls, "del-access:")).toBe(1);
    expect(countCalls(calls, "del-tunnel:")).toBe(1);

    // orphan audit row recorded, no plaintext token inside
    const audits = await db.listAudits();
    const orphan = audits.find((a) => a.action === "provision.orphan");
    expect(orphan).toBeDefined();
    expect(orphan?.actor).toBe("system");
    expect(orphan?.invite_id).toBe("inv_2");
    expect(JSON.stringify(orphan)).not.toContain(PLAIN_TOKEN);

    // invite stays pending so the admin can retry
    expect((await db.getInviteById("inv_2"))?.status).toBe("pending");
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
      inviteId: "inv_1",
      slug: "alice",
      deps: makeDeps(db, makeFakeCf([])),
    });
    await db.insertInvite(makePendingInvite({ id: "inv_2", code: "code-def" }));

    await expect(
      provisionEndpoint({ inviteId: "inv_2", slug: "bob", deps }),
    ).rejects.toThrow(/UNIQUE/i);
    expect(calls).toContain("del-dns:boom");
    expect(calls).toContain("del-access:boom");
    expect(calls).toContain("del-tunnel:boom");
  });
});
