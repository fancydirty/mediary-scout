import { describe, it, expect } from "vitest";
import { revealByCode, type RevealDeps } from "./reveal.js";
import {
  createMemoryConnectDb,
  type ConnectDb,
  type EndpointRow,
  type InviteRow,
} from "./db.js";
import { wrapToken } from "./crypto-token.js";

const NOW = "2026-07-24T10:00:00.000Z";
const WRAP_KEY = "00".repeat(32);
const PLAIN_TOKEN = "tok-plain-secret-1";

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
    token_shown_at: null,
    created_at: "2026-07-24T01:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

function makeDeps(db: ConnectDb): RevealDeps {
  return {
    db,
    tokenWrapKeyHex: WRAP_KEY,
    now: () => NOW,
    newAuditId: () => "aud_x",
  };
}

/** Seeds an endpoint whose ciphertext is a real wrapToken(PLAIN_TOKEN). */
async function seedEndpointWithToken(
  db: ConnectDb,
  overrides: Partial<EndpointRow> = {},
): Promise<void> {
  const ciphertext = await wrapToken(PLAIN_TOKEN, WRAP_KEY);
  await db.insertEndpoint(makeEndpoint({ token_ciphertext: ciphertext, ...overrides }));
}

describe("revealByCode", () => {
  it("unknown code → not_found", async () => {
    const db = createMemoryConnectDb();
    const outcome = await revealByCode({ code: "nope", deps: makeDeps(db) });
    expect(outcome).toEqual({ kind: "not_found" });
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("revoked invite → not_found, indistinguishable from never-existing (no leak)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(
      makeInvite({ status: "revoked", slug: null, revoked_at: "2026-07-24T05:00:00.000Z" }),
    );
    // ciphertext still present — a leak would surface as revealed/already_shown
    await seedEndpointWithToken(db);

    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db) });

    expect(outcome).toEqual({ kind: "not_found" });
    expect(await db.listAudits()).toHaveLength(0);
    // ciphertext untouched, token not burned
    const endpoint = await db.getEndpointById("ep_1");
    expect(endpoint?.token_ciphertext).not.toBeNull();
    expect(endpoint?.token_shown_at).toBeNull();
  });

  it("pending invite → not_ready", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite({ status: "pending", slug: null, provisioned_at: null }));

    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db) });

    expect(outcome).toEqual({ kind: "not_ready" });
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("provisioned + ciphertext present → revealed with real unwrap roundtrip; burns ciphertext, audits hostname only", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await seedEndpointWithToken(db);

    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db) });

    if (outcome.kind !== "revealed") {
      throw new Error(`expected revealed, got ${outcome.kind}`);
    }
    expect(outcome.hostname).toBe("alice.mediaryconnect.app");
    // real unwrap roundtrip — the exact plaintext that was wrapped
    expect(outcome.token).toBe(PLAIN_TOKEN);
    expect(outcome.agentPrompt).toContain("alice.mediaryconnect.app");
    expect(outcome.agentPrompt).toContain(PLAIN_TOKEN);

    // one-time burn: shown_at set AND ciphertext nulled atomically
    const endpoint = await db.getEndpointById("ep_1");
    expect(endpoint?.token_shown_at).toBe(NOW);
    expect(endpoint?.token_ciphertext).toBeNull();

    const audits = await db.listAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("token.reveal");
    expect(audits[0]?.actor).toBe("invitee");
    expect(audits[0]?.at).toBe(NOW);
    expect(audits[0]?.invite_id).toBe("inv_1");
    expect(audits[0]?.endpoint_id).toBe("ep_1");
    expect(audits[0]?.detail_json).toContain("alice.mediaryconnect.app");
    // the token must never be persisted anywhere
    expect(audits[0]?.detail_json).not.toContain(PLAIN_TOKEN);
    expect(JSON.stringify(await db.listEndpoints())).not.toContain(PLAIN_TOKEN);
    expect(JSON.stringify(audits)).not.toContain(PLAIN_TOKEN);
  });

  it("second reveal → already_shown with hostname, no additional audit row, ciphertext stays null", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await seedEndpointWithToken(db);
    const deps = makeDeps(db);

    const first = await revealByCode({ code: "code-abc", deps });
    expect(first.kind).toBe("revealed");

    const second = await revealByCode({ code: "code-abc", deps });
    expect(second).toEqual({
      kind: "already_shown",
      hostname: "alice.mediaryconnect.app",
    });

    // audit count unchanged — refresh must not spam the audit log
    expect(await db.listAudits()).toHaveLength(1);
    const endpoint = await db.getEndpointById("ep_1");
    expect(endpoint?.token_ciphertext).toBeNull();
    expect(endpoint?.token_shown_at).toBe(NOW);
  });

  it("provisioned invite but endpoint row missing → not_ready (half-done provisioning)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite()); // provisioned, no endpoint row

    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db) });

    expect(outcome).toEqual({ kind: "not_ready" });
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("corrupt state (ciphertext null, shown_at null) → already_shown, no decrypt attempted", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    // ciphertext null AND shown_at null — unwrap would explode if attempted
    await db.insertEndpoint(makeEndpoint());

    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db) });

    expect(outcome).toEqual({
      kind: "already_shown",
      hostname: "alice.mediaryconnect.app",
    });
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("returns the exact plaintext that was wrapped, even with tricky characters", async () => {
    const tricky = 'tok-with-"quotes"-\\-newline\n-unicode-✓';
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await db.insertEndpoint(
      makeEndpoint({ token_ciphertext: await wrapToken(tricky, WRAP_KEY) }),
    );

    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db) });

    if (outcome.kind !== "revealed") {
      throw new Error(`expected revealed, got ${outcome.kind}`);
    }
    expect(outcome.token).toBe(tricky);
  });

  it("audit insert failure after the burn still delivers the token (best-effort audit)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await seedEndpointWithToken(db);
    const inner = db;
    const failingAuditDb = {
      ...inner,
      async insertAudit(): Promise<void> {
        throw new Error("d1 audit boom");
      },
    };
    const deps = { ...makeDeps(db), db: failingAuditDb };

    const outcome = await revealByCode({ code: "code-abc", deps });

    if (outcome.kind !== "revealed") {
      throw new Error(`expected revealed, got ${outcome.kind}`);
    }
    expect(outcome.token).toBe(PLAIN_TOKEN);
    // burn still happened — ciphertext is gone despite the lost audit
    const endpoint = await db.getEndpointById("ep_1");
    expect(endpoint?.token_shown_at).toBe(NOW);
    expect(endpoint?.token_ciphertext).toBeNull();
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("revoked endpoint under a still-provisioned invite → not_found (no token, no validity leak)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite()); // provisioned
    await seedEndpointWithToken(db);
    await db.markEndpointRevoked("ep_1", NOW);

    const outcome = await revealByCode({ code: "code-abc", deps: makeDeps(db) });

    expect(outcome).toEqual({ kind: "not_found" });
    // ciphertext must NOT have been burned — admin forensics stay intact
    const endpoint = await db.getEndpointById("ep_1");
    expect(endpoint?.token_ciphertext).not.toBeNull();
    expect(await db.listAudits()).toHaveLength(0);
  });

  it("concurrent reveals: exactly one wins, the other gets already_shown (atomic burn)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    await seedEndpointWithToken(db);
    const deps = makeDeps(db);

    // Fire two reveals back-to-back without awaiting the first — the atomic
    // conditional burn in markTokenShown decides the winner.
    const [a, b] = await Promise.all([
      revealByCode({ code: "code-abc", deps }),
      revealByCode({ code: "code-abc", deps: { ...deps, newAuditId: () => "aud_y" } }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["already_shown", "revealed"]);
  });
});
