import { describe, expect, it, vi } from "vitest";
import { createMemoryConnectDb, type ConnectDb, type EndpointRow } from "./db.js";
import { sha256Hex } from "./crypto-token.js";
import { AT_CAPACITY_MESSAGE, CAPACITY_LIMIT } from "./capacity.js";
import type { CfApi } from "./cf-api.js";
import { restoreEndpoint, type RestoreDeps } from "./restore.js";

const NOW = "2026-10-04T00:00:00.000Z";
const FUTURE = "2027-07-28T12:00:00.000Z";

function fakeCf(calls: string[], opts: { dnsThrows?: boolean; deleteTunnelThrows?: boolean } = {}): CfApi {
  return {
    async createTunnel(name) {
      calls.push(`createTunnel:${name}`);
      return { tunnelId: `tid-${name}`, token: `tok-${name}` };
    },
    async getTunnelToken() {
      return "cf-token";
    },
    async putTunnelIngress(tunnelId) {
      calls.push(`ingress:${tunnelId}`);
    },
    async createDnsCname(slug) {
      calls.push(`dns:${slug}`);
      if (opts.dnsThrows) throw new Error("cf dns boom");
      return { recordId: `rec-${slug}` };
    },
    async createAccessApp() {
      throw new Error("unexpected createAccessApp");
    },
    async deleteTunnel(tunnelId) {
      calls.push(`deleteTunnel:${tunnelId}`);
      if (opts.deleteTunnelThrows) throw new Error("delete tunnel boom");
    },
    async deleteDnsRecord(recordId) {
      calls.push(`deleteDns:${recordId}`);
    },
    async deleteAccessApp() {},
  };
}

function deps(db: ConnectDb, cf: CfApi): RestoreDeps {
  let n = 0;
  return {
    cf,
    db,
    now: () => NOW,
    newAuditId: () => `aud_${++n}`,
  };
}

async function seedAccount(db: ConnectDb, id: string, expiresAt: string | null): Promise<void> {
  await db.insertAccount({
    id,
    email: `${id}@example.com`,
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: null,
  });
  if (expiresAt !== null) {
    await db.insertEntitlement({
      id: `ent_${id}`,
      account_id: id,
      expires_at: expiresAt,
      source: "manual",
      paddle_transaction_id: null,
      payment_provider: null,
      payment_transaction_id: null,
      refunded_at: null,
      months: 12,
      created_at: NOW,
    });
  }
}

function endpoint(overrides: Partial<EndpointRow> & Pick<EndpointRow, "id" | "slug" | "account_id">): EndpointRow {
  return {
    invite_id: null,
    hostname: `${overrides.slug}.mediaryconnect.app`,
    cf_tunnel_id: "t-old",
    cf_access_app_id: null,
    cf_access_policy_id: null,
    cf_dns_record_id: "dns-old",
    status: "revoked",
    token_sha256: "old-sha",
    token_ciphertext: null,
    token_shown_at: null,
    last_seen_at: null,
    created_at: NOW,
    revoked_at: "2026-09-01T00:00:00.000Z",
    grace_until: null,
    suspended_at: null,
    purge_after: null,
    revoke_reason: "expired",
    ...overrides,
  };
}

describe("restoreEndpoint", () => {
  it("brings the same row back with a new tunnel and DNS, and audits endpoint.restore", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A", cf_tunnel_id: "t-old" }));
    const calls: string[] = [];
    const result = await restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls)) });

    expect(result).toEqual({ endpointId: "ep_old", hostname: "fam.mediaryconnect.app" });
    expect(calls).toEqual([
      "createTunnel:scout-fam",
      "ingress:tid-scout-fam",
      "dns:fam",
    ]);
    const row = await db.getEndpointById("ep_old");
    expect(row?.status).toBe("active");
    expect(row?.cf_tunnel_id).toBe("tid-scout-fam");
    expect(row?.token_sha256).toBe(await sha256Hex("tok-scout-fam"));
    expect(row?.revoked_at).toBeNull();
    expect(row?.revoke_reason).toBeNull();
    expect(await db.listEndpoints()).toHaveLength(1);
    const audit = (await db.listAudits()).find((item) => item.action === "endpoint.restore");
    expect(audit?.actor).toBe("account:A");
    expect(JSON.parse(audit?.detail_json ?? "{}")).toEqual({
      hostname: "fam.mediaryconnect.app",
      previous_tunnel_id: "t-old",
      tunnel_id: "tid-scout-fam",
      previous_reason: "expired",
    });
  });

  it("refuses without an active entitlement before touching Cloudflare", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", null);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const calls: string[] = [];
    await expect(restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls)) })).rejects.toThrow(
      "no active entitlement",
    );
    expect(calls).toEqual([]);
  });

  it("refuses when the account already has a live endpoint", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(
      endpoint({ id: "ep_live", slug: "live", account_id: "A", status: "active", revoke_reason: null, revoked_at: null }),
    );
    const calls: string[] = [];
    await expect(restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls)) })).rejects.toThrow(
      "already provisioned",
    );
    expect(calls).toEqual([]);
  });

  it("refuses when nothing is restorable (admin revoke, NULL reason, no rows)", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "admin-acct", FUTURE);
    await seedAccount(db, "null-acct", FUTURE);
    await seedAccount(db, "empty-acct", FUTURE);
    await db.insertEndpoint(
      endpoint({ id: "ep_admin", slug: "admin-name", account_id: "admin-acct", revoke_reason: "admin" }),
    );
    await db.insertEndpoint(
      endpoint({ id: "ep_null", slug: "null-name", account_id: "null-acct", revoke_reason: null }),
    );
    const calls: string[] = [];
    const cf = fakeCf(calls);
    await expect(restoreEndpoint({ accountId: "admin-acct", deps: deps(db, cf) })).rejects.toThrow(
      "nothing to restore",
    );
    await expect(restoreEndpoint({ accountId: "null-acct", deps: deps(db, cf) })).rejects.toThrow(
      "nothing to restore",
    );
    await expect(restoreEndpoint({ accountId: "empty-acct", deps: deps(db, cf) })).rejects.toThrow(
      "nothing to restore",
    );
    expect(calls).toEqual([]);
  });

  it("finishes the cleanup of a revoke_failed row first, then restores", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(
      endpoint({
        id: "ep_old",
        slug: "fam",
        account_id: "A",
        status: "revoke_failed",
        revoke_reason: "refunded",
        cf_tunnel_id: "t-old",
        cf_dns_record_id: "dns-old",
      }),
    );
    const calls: string[] = [];
    await restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls)) });
    expect(calls.indexOf("deleteDns:dns-old")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("deleteTunnel:t-old")).toBeGreaterThan(calls.indexOf("deleteDns:dns-old"));
    expect(calls.indexOf("createTunnel:scout-fam")).toBeGreaterThan(calls.indexOf("deleteTunnel:t-old"));
    expect((await db.getEndpointById("ep_old"))?.status).toBe("active");
  });

  it("stops with restore cleanup failed when that cleanup still fails, and keeps the row revoke_failed", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(
      endpoint({ id: "ep_old", slug: "fam", account_id: "A", status: "revoke_failed", revoke_reason: "refunded" }),
    );
    const calls: string[] = [];
    await expect(
      restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls, { deleteTunnelThrows: true })) }),
    ).rejects.toThrow("restore cleanup failed");
    expect(calls.some((call) => call.startsWith("createTunnel:"))).toBe(false);
    expect((await db.getEndpointById("ep_old"))?.status).toBe("revoke_failed");
  });

  it("checks capacity before creating anything", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const capped: ConnectDb = {
      ...db,
      async countLiveEndpoints() {
        return CAPACITY_LIMIT;
      },
    };
    const calls: string[] = [];
    await expect(restoreEndpoint({ accountId: "A", deps: deps(capped, fakeCf(calls)) })).rejects.toThrow(
      AT_CAPACITY_MESSAGE,
    );
    expect(calls).toEqual([]);
  });

  it("discards the new tunnel and DNS when the row was restored by someone else meanwhile", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const racing: ConnectDb = {
      ...db,
      async reactivateEndpoint() {
        return false;
      },
    };
    const calls: string[] = [];
    await expect(restoreEndpoint({ accountId: "A", deps: deps(racing, fakeCf(calls)) })).rejects.toThrow(
      "already provisioned",
    );
    expect(calls).toContain("deleteDns:rec-fam");
    expect(calls).toContain("deleteTunnel:tid-scout-fam");
    expect((await db.getEndpointById("ep_old"))?.status).toBe("revoked");
  });

  it("discards the new resources when Cloudflare DNS fails, and leaves the row revoked", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const calls: string[] = [];
    await expect(
      restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls, { dnsThrows: true })) }),
    ).rejects.toThrow("cf dns boom");
    expect(calls.filter((call) => call.startsWith("deleteTunnel:"))).toEqual(["deleteTunnel:tid-scout-fam"]);
    expect((await db.getEndpointById("ep_old"))?.status).toBe("revoked");
  });

  it("still returns the restored address when the audit write fails", async () => {
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const flaky: ConnectDb = {
      ...db,
      async insertAudit() {
        throw new Error("audit down");
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await restoreEndpoint({ accountId: "A", deps: deps(flaky, fakeCf([])) });
      expect(result).toEqual({ endpointId: "ep_old", hostname: "fam.mediaryconnect.app" });
      expect((await db.getEndpointById("ep_old"))?.status).toBe("active");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
