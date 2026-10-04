import { describe, expect, it, vi } from "vitest";
import { createMemoryConnectDb, type ConnectDb, type EndpointRow } from "./db.js";
import { sha256Hex } from "./crypto-token.js";
import { AT_CAPACITY_MESSAGE, CAPACITY_LIMIT } from "./capacity.js";
import type { CfApi } from "./cf-api.js";
import { restoreEndpoint, type RestoreDeps } from "./restore.js";

vi.mock("./crypto-token.js", async () => {
  const actual = await vi.importActual<typeof import("./crypto-token.js")>("./crypto-token.js");
  return {
    ...actual,
    sha256Hex: vi.fn((value: string) => actual.sha256Hex(value)),
  };
});

const NOW = "2026-10-04T00:00:00.000Z";
const FUTURE = "2027-07-28T12:00:00.000Z";

function fakeCf(
  calls: string[],
  opts: {
    dnsThrows?: boolean;
    deleteTunnelThrows?: boolean;
    deleteDnsThrows?: boolean;
    deleteAccessThrows?: boolean;
  } = {},
): CfApi {
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
      if (opts.deleteDnsThrows) throw new Error("delete dns boom");
    },
    async deleteAccessApp(appId) {
      calls.push(`deleteAccess:${appId}`);
      if (opts.deleteAccessThrows) throw new Error("delete access boom");
    },
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
      previous_status: "revoked",
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
        cf_access_app_id: "app-old",
      }),
    );
    const calls: string[] = [];
    await restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls)) });
    expect(calls).toEqual([
      "deleteAccess:app-old",
      "deleteDns:dns-old",
      "deleteTunnel:t-old",
      "createTunnel:scout-fam",
      "ingress:tid-scout-fam",
      "dns:fam",
    ]);
    expect((await db.getEndpointById("ep_old"))?.status).toBe("active");
    const audits = await db.listAudits();
    expect(audits.map((item) => item.action)).not.toContain("endpoint.revoke");
    const audit = audits.find((item) => item.action === "endpoint.restore");
    expect(JSON.parse(audit?.detail_json ?? "{}")).toMatchObject({
      previous_tunnel_id: "t-old",
      previous_reason: "refunded",
      previous_status: "revoke_failed",
    });
  });

  it("stops with restore cleanup failed when a captured delete fails, and keeps the row revoke_failed", async () => {
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
        cf_access_app_id: "app-old",
        revoked_at: null,
      }),
    );
    const calls: string[] = [];
    await expect(
      restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls, { deleteDnsThrows: true })) }),
    ).rejects.toThrow("restore cleanup failed");
    expect(calls).toEqual(["deleteAccess:app-old", "deleteDns:dns-old", "deleteTunnel:t-old"]);
    expect((await db.getEndpointById("ep_old"))?.status).toBe("revoke_failed");
    expect((await db.getEndpointById("ep_old"))?.revoke_reason).toBe("refunded");
    expect((await db.listAudits()).map((item) => item.action)).not.toContain("endpoint.revoke_failed");
  });

  it("throws already provisioned when another request restored the row during cleanup, without deleting the new tunnel", async () => {
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
    const cf = fakeCf(calls);
    const deleteTunnel = cf.deleteTunnel.bind(cf);
    cf.deleteTunnel = async (tunnelId: string) => {
      await deleteTunnel(tunnelId);
      if (tunnelId !== "t-old") return;
      await db.markEndpointRevoked("ep_old", NOW, "refunded");
      await db.reactivateEndpoint({
        id: "ep_old",
        accountId: "A",
        cfTunnelId: "t-new",
        cfDnsRecordId: "dns-new",
        tokenSha256: "sha-new",
      });
    };
    await expect(restoreEndpoint({ accountId: "A", deps: deps(db, cf) })).rejects.toThrow(
      "already provisioned",
    );
    expect(calls).not.toContain("deleteTunnel:t-new");
    expect(calls).not.toContain("deleteDns:dns-new");
    expect(calls.some((call) => call.startsWith("createTunnel:"))).toBe(false);
    expect(await db.getEndpointById("ep_old")).toMatchObject({
      status: "active",
      cf_tunnel_id: "t-new",
      cf_dns_record_id: "dns-new",
    });
  });

  it("restores when another request already finished the same cleanup", async () => {
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
    const cf = fakeCf(calls);
    const deleteTunnel = cf.deleteTunnel.bind(cf);
    cf.deleteTunnel = async (tunnelId: string) => {
      await deleteTunnel(tunnelId);
      if (tunnelId === "t-old") await db.markEndpointRevoked("ep_old", NOW, "refunded");
    };
    await restoreEndpoint({ accountId: "A", deps: deps(db, cf) });
    expect(calls).toEqual([
      "deleteDns:dns-old",
      "deleteTunnel:t-old",
      "createTunnel:scout-fam",
      "ingress:tid-scout-fam",
      "dns:fam",
    ]);
    expect((await db.getEndpointById("ep_old"))?.status).toBe("active");
    expect((await db.listAudits()).map((item) => item.action)).toEqual(["endpoint.restore"]);
    expect(JSON.parse((await db.listAudits())[0]?.detail_json ?? "{}")).toMatchObject({
      previous_status: "revoke_failed",
      previous_tunnel_id: "t-old",
    });
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

  it("answers already provisioned when a concurrent restore won and its CNAME blocks this one", async () => {
    // Two restores read the same revoked row; the first creates the CNAME and reactivates the row,
    // so the second's createDnsCname fails on the duplicate. That is the lost race, not a 500.
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const calls: string[] = [];
    const base = fakeCf(calls);
    const cf: CfApi = {
      ...base,
      async createDnsCname(slug, tunnelId) {
        await db.reactivateEndpoint({
          id: "ep_old",
          accountId: "A",
          cfTunnelId: "t-winner",
          cfDnsRecordId: "dns-winner",
          tokenSha256: "sha-winner",
        });
        calls.push(`dns:${slug}`);
        void tunnelId;
        throw new Error("cf dns: record already exists");
      },
    };
    await expect(restoreEndpoint({ accountId: "A", deps: deps(db, cf) })).rejects.toThrow("already provisioned");
    // Only this request's own tunnel is cleaned up; the winner's DNS record and tunnel stay.
    expect(calls.filter((call) => call.startsWith("delete"))).toEqual(["deleteTunnel:tid-scout-fam"]);
    expect((await db.getEndpointById("ep_old"))?.cf_tunnel_id).toBe("t-winner");
  });

  it("leaves an orphan audit with the new tunnel and DNS ids when the restore is rolled back", async () => {
    // discard() is best effort: if its deletes fail, these ids are the operator's only handle on the
    // leftovers (same as provision.orphan for a failed provisioning).
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const failing: ConnectDb = {
      ...db,
      async reactivateEndpoint() {
        throw new Error("d1 down");
      },
    };
    await expect(
      restoreEndpoint({ accountId: "A", deps: deps(failing, fakeCf([], { deleteTunnelThrows: true })) }),
    ).rejects.toThrow("d1 down");
    const orphan = (await db.listAudits()).find((audit) => audit.action === "restore.orphan");
    expect(orphan?.endpoint_id).toBe("ep_old");
    expect(JSON.parse(orphan?.detail_json ?? "{}")).toMatchObject({
      hostname: "fam.mediaryconnect.app",
      cf_tunnel_id: "tid-scout-fam",
      cf_dns_record_id: "rec-fam",
    });
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

  it("discards the new DNS record and tunnel when hashing the token rejects", async () => {
    vi.mocked(sha256Hex).mockRejectedValueOnce(new Error("hash boom"));
    const db = createMemoryConnectDb();
    await seedAccount(db, "A", FUTURE);
    await db.insertEndpoint(endpoint({ id: "ep_old", slug: "fam", account_id: "A" }));
    const calls: string[] = [];
    await expect(restoreEndpoint({ accountId: "A", deps: deps(db, fakeCf(calls)) })).rejects.toThrow(
      "hash boom",
    );
    expect(calls).toContain("deleteDns:rec-fam");
    expect(calls).toContain("deleteTunnel:tid-scout-fam");
    expect((await db.getEndpointById("ep_old"))?.status).toBe("revoked");
    expect((await db.getEndpointById("ep_old"))?.cf_tunnel_id).toBe("t-old");
  });
});
