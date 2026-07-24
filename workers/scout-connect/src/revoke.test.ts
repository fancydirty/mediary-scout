import { describe, it, expect } from "vitest";
import { revokeEndpoint, type RevokeDeps } from "./revoke.js";
import {
  createMemoryConnectDb,
  type ConnectDb,
  type EndpointRow,
  type InviteRow,
} from "./db.js";
import type { CfApi } from "./cf-api.js";

const NOW = "2026-07-24T10:00:00.000Z";

function makeInvite(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: "inv_1",
    code: "code-abc",
    invitee_label: "Alice",
    email: "alice@example.com",
    slug: "alice",
    status: "provisioned",
    created_at: "2026-07-24T00:00:00.000Z",
    provisioned_at: "2026-07-24T01:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

function makeEndpoint(overrides: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: "ep_1",
    invite_id: "inv_1",
    slug: "alice",
    hostname: "alice.mediaryconnect.app",
    cf_tunnel_id: "tid-1",
    cf_access_app_id: "app-1",
    cf_access_policy_id: "pol-1",
    cf_dns_record_id: "rec-1",
    status: "active",
    token_sha256: "deadbeef",
    token_ciphertext: null,
    token_shown_at: "2026-07-24T02:00:00.000Z",
    created_at: "2026-07-24T01:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

interface FakeCfOptions {
  failOn?: "access" | "dns" | "tunnel";
  /** when true, the configured failure happens only on the first attempt of that step */
  failOnce?: boolean;
}

/**
 * Records delete calls. Deletes on "already deleted" resources succeed (the
 * real cf-api treats 404 as success), so a retry after a failOnce failure
 * runs all three deletes cleanly.
 */
function makeFakeCf(calls: string[], opts: FakeCfOptions = {}): CfApi {
  const attempts: Record<"access" | "dns" | "tunnel", number> = {
    access: 0,
    dns: 0,
    tunnel: 0,
  };
  const shouldFail = (step: "access" | "dns" | "tunnel"): boolean => {
    attempts[step] += 1;
    if (opts.failOn !== step) return false;
    return opts.failOnce !== true || attempts[step] === 1;
  };
  return {
    async createTunnel() {
      throw new Error("unexpected createTunnel call during revoke");
    },
    async putTunnelIngress() {
      throw new Error("unexpected putTunnelIngress call during revoke");
    },
    async createDnsCname() {
      throw new Error("unexpected createDnsCname call during revoke");
    },
    async createAccessApp() {
      throw new Error("unexpected createAccessApp call during revoke");
    },
    async deleteAccessApp(appId) {
      calls.push(`del-access:${appId}`);
      if (shouldFail("access")) throw new Error("cf delete access boom");
    },
    async deleteDnsRecord(recordId) {
      calls.push(`del-dns:${recordId}`);
      if (shouldFail("dns")) throw new Error("cf delete dns boom");
    },
    async deleteTunnel(tunnelId) {
      calls.push(`del-tunnel:${tunnelId}`);
      if (shouldFail("tunnel")) throw new Error("cf delete tunnel boom");
    },
  };
}

function makeDeps(db: ConnectDb, cf: CfApi): RevokeDeps {
  return {
    cf,
    db,
    now: () => NOW,
    newAuditId: () => "aud_x",
  };
}

describe("revokeEndpoint", () => {
  it("happy path: deletes access→dns→tunnel, revokes endpoint+invite, audits endpoint.revoke", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(makeEndpoint());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    const result = await revokeEndpoint({ endpointId: "ep_1", deps });

    expect(result).toEqual({
      endpointId: "ep_1",
      hostname: "alice.mediaryconnect.app",
    });
    expect(calls).toEqual(["del-access:app-1", "del-dns:rec-1", "del-tunnel:tid-1"]);

    const endpoint = await db.getEndpointById("ep_1");
    expect(endpoint?.status).toBe("revoked");
    expect(endpoint?.revoked_at).toBe(NOW);

    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("revoked");
    expect(invite?.slug).toBeNull();
    expect(invite?.revoked_at).toBe(NOW);

    const audits = await db.listAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.id).toBe("aud_x");
    expect(audits[0]?.at).toBe(NOW);
    expect(audits[0]?.action).toBe("endpoint.revoke");
    expect(audits[0]?.actor).toBe("admin");
    expect(audits[0]?.invite_id).toBe("inv_1");
    expect(audits[0]?.endpoint_id).toBe("ep_1");
    expect(audits[0]?.detail_json).toContain("alice.mediaryconnect.app");
  });

  it("already revoked: returns hostname with zero cf calls and zero new audit rows", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite({ status: "revoked", slug: null, revoked_at: NOW }));
    await db.insertEndpoint(makeEndpoint({ status: "revoked", revoked_at: NOW }));
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    const result = await revokeEndpoint({ endpointId: "ep_1", deps });

    expect(result).toEqual({
      endpointId: "ep_1",
      hostname: "alice.mediaryconnect.app",
    });
    expect(calls).toHaveLength(0);
    expect(await db.listAudits()).toHaveLength(0);
    // row untouched
    expect((await db.getEndpointById("ep_1"))?.status).toBe("revoked");
  });

  it("already revoked self-heals a stuck provisioned invite (crash window between the two D1 writes)", async () => {
    const db = createMemoryConnectDb();
    // Simulates isolate death between markEndpointRevoked and updateInviteStatus:
    // endpoint revoked, invite still provisioned with slug set.
    await db.insertInvite(makeInvite({ status: "provisioned", slug: "alice", provisioned_at: NOW }));
    await db.insertEndpoint(makeEndpoint({ status: "revoked", revoked_at: NOW }));
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    const result = await revokeEndpoint({ endpointId: "ep_1", deps });

    expect(result.hostname).toBe("alice.mediaryconnect.app");
    expect(calls).toHaveLength(0); // still no cf calls
    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("revoked");
    expect(invite?.slug).toBeNull();
    expect(invite?.revoked_at).toBe(NOW);
  });

  it("access-app delete throws: dns+tunnel still attempted, revoke_failed, audit written, error rethrown, invite NOT revoked", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(makeEndpoint());
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "access" }));

    await expect(revokeEndpoint({ endpointId: "ep_1", deps })).rejects.toThrow(
      "cf delete access boom",
    );

    // all three deletes attempted despite the first one throwing
    expect(calls).toEqual(["del-access:app-1", "del-dns:rec-1", "del-tunnel:tid-1"]);

    const endpoint = await db.getEndpointById("ep_1");
    expect(endpoint?.status).toBe("revoke_failed");
    expect(endpoint?.revoked_at).toBeNull();

    // invite must NOT be flipped to revoked — the admin retries later
    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("provisioned");
    expect(invite?.slug).toBe("alice");
    expect(invite?.revoked_at).toBeNull();

    const audits = await db.listAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("endpoint.revoke_failed");
    expect(audits[0]?.actor).toBe("admin");
    expect(audits[0]?.invite_id).toBe("inv_1");
    expect(audits[0]?.endpoint_id).toBe("ep_1");
    expect(audits[0]?.detail_json).toContain("alice.mediaryconnect.app");
    expect(audits[0]?.detail_json).toContain("cf delete access boom");
  });

  it("tunnel delete throws: revoke_failed, then a retry succeeds because deletes are 404-idempotent", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(makeEndpoint());
    const calls: string[] = [];
    // first tunnel delete throws; access/dns deletes succeed (and keep
    // succeeding on the retry as "already deleted" → 404 → success)
    const deps = makeDeps(db, makeFakeCf(calls, { failOn: "tunnel", failOnce: true }));

    await expect(revokeEndpoint({ endpointId: "ep_1", deps })).rejects.toThrow(
      "cf delete tunnel boom",
    );
    expect((await db.getEndpointById("ep_1"))?.status).toBe("revoke_failed");
    expect((await db.getInviteById("inv_1"))?.status).toBe("provisioned");

    // admin retries with the same (now healthy) cf — second run's deletes on
    // already-deleted access/dns return success without throwing
    const retryDeps = { ...deps, newAuditId: () => "aud_retry" };
    const result = await revokeEndpoint({ endpointId: "ep_1", deps: retryDeps });

    expect(result).toEqual({
      endpointId: "ep_1",
      hostname: "alice.mediaryconnect.app",
    });
    expect((await db.getEndpointById("ep_1"))?.status).toBe("revoked");
    expect((await db.getEndpointById("ep_1"))?.revoked_at).toBe(NOW);
    const invite = await db.getInviteById("inv_1");
    expect(invite?.status).toBe("revoked");
    expect(invite?.slug).toBeNull();

    // both runs attempted the full delete set
    expect(calls.filter((c) => c.startsWith("del-access:"))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("del-dns:"))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("del-tunnel:"))).toHaveLength(2);

    const actions = (await db.listAudits()).map((a) => a.action);
    expect(actions).toContain("endpoint.revoke_failed");
    expect(actions).toContain("endpoint.revoke");
  });

  it("endpoint not found → throws, before any cf call", async () => {
    const db = createMemoryConnectDb();
    const calls: string[] = [];
    const deps = makeDeps(db, makeFakeCf(calls));

    await expect(revokeEndpoint({ endpointId: "ep_missing", deps })).rejects.toThrow(
      /not found/,
    );
    expect(calls).toHaveLength(0);
    expect(await db.listAudits()).toHaveLength(0);
  });
});
