import { describe, it, expect } from "vitest";
import { revealByCode, type RevealDeps } from "./reveal.js";
import {
  createMemoryConnectDb,
  type ConnectDb,
  type EndpointRow,
  type InviteRow,
} from "./db.js";
import type { CfApi } from "./cf-api.js";

const NOW = "2026-07-24T10:00:00.000Z";
const CF_TOKEN = "cf-connector-token-for-tid-1";

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
    cf_access_app_id: null,
    cf_access_policy_id: null,
    cf_dns_record_id: "rec-1",
    status: "active",
    token_sha256: "deadbeef",
    token_ciphertext: null,
    token_shown_at: null,
    created_at: "2026-07-24T01:00:00.000Z",
    revoked_at: null,
    last_seen_at: null,
    ...overrides,
  };
}

/** Fake CF that records getTunnelToken calls and returns a token per tunnel. */
function makeFakeCf(calls: string[]): CfApi {
  const boom = (name: string) => async () => {
    throw new Error(`unexpected ${name} call during reveal`);
  };
  return {
    createTunnel: boom("createTunnel") as never,
    getTunnelToken: async (tunnelId: string) => {
      calls.push(`getTunnelToken:${tunnelId}`);
      return CF_TOKEN;
    },
    putTunnelIngress: boom("putTunnelIngress") as never,
    createDnsCname: boom("createDnsCname") as never,
    createAccessApp: boom("createAccessApp") as never,
    deleteTunnel: boom("deleteTunnel") as never,
    deleteDnsRecord: boom("deleteDnsRecord") as never,
    deleteAccessApp: boom("deleteAccessApp") as never,
  };
}

function makeDeps(db: ConnectDb, cfCalls: string[] = []): RevealDeps {
  return {
    db,
    cf: makeFakeCf(cfCalls),
    now: () => NOW,
    newAuditId: () => "aud_x",
  };
}

describe("revealByCode (P4: fetch token from CF, idempotent, no burn)", () => {
  it("unknown code → not_found, never calls CF", async () => {
    const db = createMemoryConnectDb();
    const cfCalls: string[] = [];
    const outcome = await revealByCode({ code: "nope", deps: makeDeps(db, cfCalls) });
    expect(outcome).toEqual({ kind: "not_found" });
    expect(cfCalls).toHaveLength(0);
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("revoked invite → not_found (indistinguishable from never-existing), no CF call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(
      makeInvite({ status: "revoked", slug: null, revoked_at: "2026-07-24T05:00:00.000Z" }),
    );
    await db.insertEndpoint(makeEndpoint());
    const cfCalls: string[] = [];
    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db, cfCalls) });
    expect(outcome).toEqual({ kind: "not_found" });
    expect(cfCalls).toHaveLength(0);
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("pending invite → not_ready, no CF call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite({ status: "pending", slug: null, provisioned_at: null }));
    const cfCalls: string[] = [];
    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db, cfCalls) });
    expect(outcome).toEqual({ kind: "not_ready" });
    expect(cfCalls).toHaveLength(0);
  });

  it("provisioned + active → revealed with token fetched from CF, audits hostname only", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(makeEndpoint());
    const cfCalls: string[] = [];
    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db, cfCalls) });

    if (outcome.kind !== "revealed") throw new Error(`expected revealed, got ${outcome.kind}`);
    expect(outcome.hostname).toBe("alice.mediaryconnect.app");
    expect(outcome.token).toBe(CF_TOKEN);
    expect(outcome.agentPrompt).toContain("alice.mediaryconnect.app");
    expect(outcome.agentPrompt).toContain(CF_TOKEN);
    // 按 cf_tunnel_id 取
    expect(cfCalls).toEqual(["getTunnelToken:tid-1"]);

    const audits = await db.listAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("token.reveal");
    expect(audits[0]?.detail_json).toContain("alice.mediaryconnect.app");
    // token 绝不落库/进审计
    expect(audits[0]?.detail_json).not.toContain(CF_TOKEN);
    expect(JSON.stringify(await db.listEndpoints())).not.toContain(CF_TOKEN);
    expect(JSON.stringify(audits)).not.toContain(CF_TOKEN);
  });

  it("second reveal → still revealed (idempotent),换机器/重试都能再取", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(makeEndpoint());
    const cfCalls: string[] = [];
    let n = 0;
    const deps: RevealDeps = { ...makeDeps(db, cfCalls), newAuditId: () => `aud_${++n}` };

    const first = await revealByCode({ code: "code-abc", deps });
    const second = await revealByCode({ code: "code-abc", deps });

    expect(first.kind).toBe("revealed");
    expect(second.kind).toBe("revealed");
    if (second.kind === "revealed") expect(second.token).toBe(CF_TOKEN);
    // 幂等的真正证据:两次都成功交付、CF 各取一次(恒返回同 token)。
    expect(cfCalls).toEqual(["getTunnelToken:tid-1", "getTunnelToken:tid-1"]);
    expect(await db.listAudits()).toHaveLength(2);
  });

  it("provisioned invite but endpoint row missing → not_ready, no CF call", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    const cfCalls: string[] = [];
    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db, cfCalls) });
    expect(outcome).toEqual({ kind: "not_ready" });
    expect(cfCalls).toHaveLength(0);
  });

  it("revoked endpoint under a still-provisioned invite → not_found, no CF call (no token, no leak)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(makeEndpoint());
    await db.markEndpointRevoked("ep_1", NOW);
    const cfCalls: string[] = [];
    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db, cfCalls) });
    expect(outcome).toEqual({ kind: "not_found" });
    expect(cfCalls).toHaveLength(0);
  });

  it("audit insert failure still delivers the token (best-effort audit)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(makeEndpoint());
    const failingAuditDb: ConnectDb = {
      ...db,
      async insertAudit(): Promise<void> {
        throw new Error("d1 audit boom");
      },
    };
    const outcome = await revealByCode({ code: "code-abc", deps: { ...makeDeps(db), db: failingAuditDb } });
    if (outcome.kind !== "revealed") throw new Error(`expected revealed, got ${outcome.kind}`);
    expect(outcome.token).toBe(CF_TOKEN);
    expect(await db.listAudits()).toHaveLength(0);
  });
});
