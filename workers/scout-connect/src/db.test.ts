import { describe, it, expect } from "vitest";
import {
  createMemoryConnectDb,
  type InviteRow,
  type EndpointRow,
  type AuditRow,
} from "./db.js";

function makeInvite(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: "inv_1",
    code: "code-1",
    invitee_label: null,
    email: "alice@example.com",
    slug: null,
    status: "pending",
    created_at: "2026-07-24T00:00:00.000Z",
    provisioned_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function makeEndpoint(overrides: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: "ep_1",
    invite_id: "inv_1",
    slug: "alice",
    hostname: "alice.connect.example.com",
    cf_tunnel_id: "tun_1",
    cf_access_app_id: "app_1",
    cf_access_policy_id: null,
    cf_dns_record_id: "dns_1",
    status: "active",
    token_sha256: "sha256hex",
    token_ciphertext: "ciphertext",
    token_shown_at: null,
    created_at: "2026-07-24T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

describe("memory ConnectDb", () => {
  it("insertInvite roundtrips via getInviteById and getInviteByCode", async () => {
    const db = createMemoryConnectDb();
    const invite = makeInvite();
    const inserted = await db.insertInvite(invite);
    expect(inserted).toEqual(invite);
    expect(await db.getInviteById("inv_1")).toEqual(invite);
    expect(await db.getInviteByCode("code-1")).toEqual(invite);
    expect(await db.getInviteById("missing")).toBeNull();
    expect(await db.getInviteByCode("missing")).toBeNull();
  });

  it("rejects duplicate invite code and id with UNIQUE error", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await expect(db.insertInvite(makeInvite({ id: "inv_2" }))).rejects.toThrow(/UNIQUE/i);
    await expect(db.insertInvite(makeInvite({ code: "code-2" }))).rejects.toThrow(/UNIQUE/i);
  });

  it("listInvites returns newest first", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite({ id: "inv_1", code: "c1", created_at: "2026-07-20T00:00:00.000Z" }));
    await db.insertInvite(makeInvite({ id: "inv_2", code: "c2", created_at: "2026-07-22T00:00:00.000Z" }));
    await db.insertInvite(makeInvite({ id: "inv_3", code: "c3", created_at: "2026-07-21T00:00:00.000Z" }));
    const list = await db.listInvites();
    expect(list.map((row) => row.id)).toEqual(["inv_2", "inv_3", "inv_1"]);
  });

  it("updateInviteStatus applies status, slug and provisioned_at", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.updateInviteStatus("inv_1", {
      status: "provisioned",
      slug: "alice",
      provisioned_at: "2026-07-24T01:00:00.000Z",
    });
    const row = await db.getInviteById("inv_1");
    expect(row?.status).toBe("provisioned");
    expect(row?.slug).toBe("alice");
    expect(row?.provisioned_at).toBe("2026-07-24T01:00:00.000Z");
    expect(row?.revoked_at).toBeNull();
  });

  it("insertEndpoint roundtrips via getEndpointById and getEndpointByInviteId", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    const endpoint = makeEndpoint();
    const inserted = await db.insertEndpoint(endpoint);
    expect(inserted).toEqual(endpoint);
    expect(await db.getEndpointById("ep_1")).toEqual(endpoint);
    expect(await db.getEndpointByInviteId("inv_1")).toEqual(endpoint);
    expect(await db.getEndpointById("missing")).toBeNull();
    expect(await db.getEndpointByInviteId("missing")).toBeNull();
  });

  it("rejects duplicate endpoint slug, invite_id and hostname with UNIQUE error", async () => {
    const db = createMemoryConnectDb();
    await db.insertEndpoint(makeEndpoint());
    await expect(
      db.insertEndpoint(makeEndpoint({ id: "ep_2", invite_id: "inv_2", hostname: "other.connect.example.com" })),
    ).rejects.toThrow(/UNIQUE/i);
    await expect(
      db.insertEndpoint(makeEndpoint({ id: "ep_2", slug: "other", hostname: "other.connect.example.com" })),
    ).rejects.toThrow(/UNIQUE/i);
    await expect(
      db.insertEndpoint(makeEndpoint({ id: "ep_2", invite_id: "inv_2", slug: "other" })),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("markTokenShown sets token_shown_at and nulls token_ciphertext", async () => {
    const db = createMemoryConnectDb();
    await db.insertEndpoint(makeEndpoint());
    await db.markTokenShown("ep_1", "2026-07-24T02:00:00.000Z");
    const row = await db.getEndpointById("ep_1");
    expect(row?.token_shown_at).toBe("2026-07-24T02:00:00.000Z");
    expect(row?.token_ciphertext).toBeNull();
  });

  it("markEndpointRevoked sets status revoked and revoked_at", async () => {
    const db = createMemoryConnectDb();
    await db.insertEndpoint(makeEndpoint());
    await db.markEndpointRevoked("ep_1", "2026-07-24T03:00:00.000Z");
    const row = await db.getEndpointById("ep_1");
    expect(row?.status).toBe("revoked");
    expect(row?.revoked_at).toBe("2026-07-24T03:00:00.000Z");
  });

  it("markEndpointRevokeFailed sets status revoke_failed", async () => {
    const db = createMemoryConnectDb();
    await db.insertEndpoint(makeEndpoint());
    await db.markEndpointRevokeFailed("ep_1");
    const row = await db.getEndpointById("ep_1");
    expect(row?.status).toBe("revoke_failed");
    expect(row?.revoked_at).toBeNull();
  });

  it("insertAudit roundtrips via listAudits", async () => {
    const db = createMemoryConnectDb();
    const audit: AuditRow = {
      id: "aud_1",
      at: "2026-07-24T00:00:00.000Z",
      actor: "admin",
      action: "invite.create",
      invite_id: "inv_1",
      endpoint_id: null,
      detail_json: null,
    };
    await db.insertAudit(audit);
    const audits = await db.listAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(audit);
  });

  it("returned rows are defensive copies and cannot mutate the store", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    const row = await db.getInviteById("inv_1");
    if (row === null) {
      throw new Error("expected invite to exist");
    }
    row.email = "hacked@example.com";
    row.status = "revoked";
    const again = await db.getInviteById("inv_1");
    expect(again?.email).toBe("alice@example.com");
    expect(again?.status).toBe("pending");

    const listed = await db.listInvites();
    const first = listed[0];
    if (first === undefined) {
      throw new Error("expected invite to exist");
    }
    first.code = "mutated";
    expect((await db.getInviteById("inv_1"))?.code).toBe("code-1");
  });
});
