import { describe, it, expect } from "vitest";
import {
  createMemoryConnectDb,
  createD1ConnectDb,
  type D1Database,
  type D1PreparedStatement,
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
    last_seen_at: null,
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
    const burned = await db.markTokenShown("ep_1", "2026-07-24T02:00:00.000Z");
    expect(burned).toBe(true);
    const row = await db.getEndpointById("ep_1");
    expect(row?.token_shown_at).toBe("2026-07-24T02:00:00.000Z");
    expect(row?.token_ciphertext).toBeNull();
  });

  it("markTokenShown returns false on the second call (once-only race semantics)", async () => {
    const db = createMemoryConnectDb();
    await db.insertEndpoint(makeEndpoint());
    expect(await db.markTokenShown("ep_1", "2026-07-24T02:00:00.000Z")).toBe(true);
    expect(await db.markTokenShown("ep_1", "2026-07-24T03:00:00.000Z")).toBe(false);
    // first burn wins
    expect((await db.getEndpointById("ep_1"))?.token_shown_at).toBe("2026-07-24T02:00:00.000Z");
    // nonexistent id also false
    expect(await db.markTokenShown("nope", "2026-07-24T03:00:00.000Z")).toBe(false);
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

  it("mutations on nonexistent ids are silent no-ops (D1 UPDATE parity contract)", async () => {
    const db = createMemoryConnectDb();
    // markTokenShown returns false (no row burned); the others resolve void
    await expect(db.markTokenShown("nope", "2026-07-24T04:00:00.000Z")).resolves.toBe(false);
    await expect(db.markEndpointRevoked("nope", "2026-07-24T04:00:00.000Z")).resolves.toBeUndefined();
    await expect(db.markEndpointRevokeFailed("nope")).resolves.toBeUndefined();
    await expect(db.updateInviteStatus("nope", { status: "revoked" })).resolves.toBeUndefined();
    expect(await db.listEndpoints()).toHaveLength(0);
    expect(await db.listInvites()).toHaveLength(0);
  });

  it("list ordering ties break deterministically by id DESC", async () => {
    const db = createMemoryConnectDb();
    const sameAt = "2026-07-24T00:00:00.000Z";
    await db.insertInvite(makeInvite({ id: "inv_a", code: "ca", created_at: sameAt }));
    await db.insertInvite(makeInvite({ id: "inv_b", code: "cb", created_at: sameAt }));
    await db.insertEndpoint(makeEndpoint({ id: "ep_a", invite_id: "inv_a", slug: "sa", hostname: "sa.x", created_at: sameAt }));
    await db.insertEndpoint(makeEndpoint({ id: "ep_b", invite_id: "inv_b", slug: "sb", hostname: "sb.x", created_at: sameAt }));
    expect((await db.listInvites()).map((row) => row.id)).toEqual(["inv_b", "inv_a"]);
    expect((await db.listEndpoints()).map((row) => row.id)).toEqual(["ep_b", "ep_a"]);
  });

  it("updateInviteStatus supports the revoke-shaped patch (slug cleared)", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite({ status: "provisioned", slug: "alice", provisioned_at: "2026-07-24T01:00:00.000Z" }));
    await db.updateInviteStatus("inv_1", {
      status: "revoked",
      slug: null,
      revoked_at: "2026-07-24T05:00:00.000Z",
    });
    const row = await db.getInviteById("inv_1");
    expect(row?.status).toBe("revoked");
    expect(row?.slug).toBeNull();
    expect(row?.revoked_at).toBe("2026-07-24T05:00:00.000Z");
    expect(row?.provisioned_at).toBe("2026-07-24T01:00:00.000Z");
  });
});

interface SpyCall {
  query: string;
  binds: unknown[];
  method: "first" | "all" | "run";
}

function createSpyD1(respond: { first?: unknown; all?: unknown[] } = {}): {
  d1: D1Database;
  calls: SpyCall[];
} {
  const calls: SpyCall[] = [];
  const d1: D1Database = {
    prepare(query: string): D1PreparedStatement {
      const binds: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          binds.push(...values);
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          calls.push({ query, binds: [...binds], method: "first" });
          return (respond.first ?? null) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          calls.push({ query, binds: [...binds], method: "all" });
          return { results: (respond.all ?? []) as T[] };
        },
        async run(): Promise<unknown> {
          calls.push({ query, binds: [...binds], method: "run" });
          return {};
        },
      };
      return stmt;
    },
  };
  return { d1, calls };
}

describe("D1 ConnectDb SQL", () => {
  it("markTokenShown issues one conditional UPDATE and reports the burn from meta.changes", async () => {
    const { d1, calls } = createSpyD1({ first: null, all: [] });
    // spy run() returns {} — meta.changes undefined → false. Patch run to
    // report one change so we can assert the true path too.
    const db = createD1ConnectDb(d1);
    const burned = await db.markTokenShown("ep_1", "2026-07-24T02:00:00.000Z");
    expect(burned).toBe(false); // spy run() has no meta.changes
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("run");
    expect(call?.query).toContain("token_shown_at = ?");
    expect(call?.query).toContain("token_ciphertext = NULL");
    expect(call?.query).toContain("token_shown_at IS NULL");
    expect(call?.query).toContain("token_ciphertext IS NOT NULL");
    expect(call?.binds).toEqual(["2026-07-24T02:00:00.000Z", "ep_1"]);
  });

  it("updateInviteStatus full patch keeps placeholder↔bind alignment", async () => {
    const { d1, calls } = createSpyD1();
    const db = createD1ConnectDb(d1);
    await db.updateInviteStatus("inv_1", {
      status: "provisioned",
      slug: "alice",
      provisioned_at: "2026-07-24T01:00:00.000Z",
      revoked_at: null,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.query).toBe(
      "UPDATE invites SET status = ?, slug = ?, provisioned_at = ?, revoked_at = ? WHERE id = ?",
    );
    expect(call?.binds).toEqual(["provisioned", "alice", "2026-07-24T01:00:00.000Z", null, "inv_1"]);
  });

  it("updateInviteStatus status-only patch emits one placeholder", async () => {
    const { d1, calls } = createSpyD1();
    const db = createD1ConnectDb(d1);
    await db.updateInviteStatus("inv_1", { status: "revoked" });
    expect(calls[0]?.query).toBe("UPDATE invites SET status = ? WHERE id = ?");
    expect(calls[0]?.binds).toEqual(["revoked", "inv_1"]);
  });

  it("insertEndpoint binds token fields without leaking them into SQL text", async () => {
    const { d1, calls } = createSpyD1();
    const db = createD1ConnectDb(d1);
    await db.insertEndpoint(makeEndpoint({ token_ciphertext: "s3cret-ciphertext" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).not.toContain("s3cret-ciphertext");
    expect(calls[0]?.binds).toContain("s3cret-ciphertext");
  });

  it("insertWaitlist binds survey_json without leaking it into SQL text", async () => {
    const { d1, calls } = createSpyD1();
    const db = createD1ConnectDb(d1);
    await db.insertWaitlist({
      id: "w1",
      email: "a@x.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-26T00:00:00.000Z",
      survey_json: `{"willing_to_pay":"愿意"}`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("survey_json");
    expect(calls[0]?.query).not.toContain("willing_to_pay");
    expect(calls[0]?.binds).toContain(`{"willing_to_pay":"愿意"}`);
  });
});

describe("waitlist", () => {
  it("insert + count + list; email 唯一约束", async () => {
    const db = createMemoryConnectDb();
    await db.insertWaitlist({
      id: "w1",
      email: "a@x.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-25T00:00:00Z",
      survey_json: null,
    });
    await expect(
      db.insertWaitlist({
        id: "w2",
        email: "a@x.com",
        batch: 1,
        status: "pending",
        created_at: "2026-07-25T00:00:01Z",
        survey_json: null,
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.countWaitlist(1)).toBe(1);
    expect((await db.listWaitlist(1)).map((r) => r.email)).toEqual(["a@x.com"]);
  });

  it("getWaitlistByEmail 返回匹配行或 null", async () => {
    const db = createMemoryConnectDb();
    await db.insertWaitlist({
      id: "w1",
      email: "b@y.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-25T00:00:00Z",
      survey_json: null,
    });
    expect(await db.getWaitlistByEmail("b@y.com", 1)).toMatchObject({ email: "b@y.com" });
    expect(await db.getWaitlistByEmail("missing@z.com", 1)).toBeNull();
  });

  // The memory backend must rank identically to the D1 backend, or route tests
  // (which run on memory) prove nothing about production. The authoritative
  // same-second coverage lives in schema.test.ts against real SQLite; this is
  // the lockstep check for the mock.
  it("waitlistRankOf 同一秒内按 id 给出互不相同的 1,2,3", async () => {
    const db = createMemoryConnectDb();
    const ts = "2026-07-26T00:00:00.000Z";
    for (const { id, email } of [
      { id: "wl_b", email: "b@x.com" },
      { id: "wl_c", email: "c@x.com" },
      { id: "wl_a", email: "a@x.com" },
    ]) {
      await db.insertWaitlist({ id, email, batch: 1, status: "pending", created_at: ts, survey_json: null });
    }

    const ranks = await Promise.all(
      ["wl_a", "wl_b", "wl_c"].map((id) => db.waitlistRankOf(1, ts, id)),
    );
    expect(ranks).toEqual([1, 2, 3]);
  });

  it("waitlistRankOf 跨时间戳排序，且不计入其他 batch", async () => {
    const db = createMemoryConnectDb();
    await db.insertWaitlist({
      id: "wl_early",
      email: "early@x.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-25T00:00:00.000Z",
      survey_json: null,
    });
    await db.insertWaitlist({
      id: "wl_late",
      email: "late@x.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-27T00:00:00.000Z",
      survey_json: null,
    });
    await db.insertWaitlist({
      id: "wl_zzz_other",
      email: "other@x.com",
      batch: 2,
      status: "pending",
      created_at: "2026-07-25T00:00:00.000Z",
      survey_json: null,
    });

    expect(await db.waitlistRankOf(1, "2026-07-25T00:00:00.000Z", "wl_early")).toBe(1);
    expect(await db.waitlistRankOf(1, "2026-07-27T00:00:00.000Z", "wl_late")).toBe(2);
    expect(await db.waitlistRankOf(2, "2026-07-25T00:00:00.000Z", "wl_zzz_other")).toBe(1);
  });

  // TRIPWIRE — mirror of the same-named test in schema.test.ts, which runs
  // this scenario against real SQLite. Both exist on purpose: the two
  // waitlistRankOf implementations must stay semantically identical, so a
  // status filter added to only one of them has to fail somewhere. Read the
  // long comment in schema.test.ts before changing either.
  it("TRIPWIRE: ranking counts non-pending rows too — status is not filtered (memory mock)", async () => {
    const db = createMemoryConnectDb();
    const TS = "2026-07-26T00:00:00.000Z";
    await db.insertWaitlist({
      id: "wl_gone",
      email: "gone@x.com",
      batch: 1,
      status: "removed",
      created_at: "2026-07-25T00:00:00.000Z",
      survey_json: null,
    });
    await db.insertWaitlist({
      id: "wl_here",
      email: "here@x.com",
      batch: 1,
      status: "pending",
      created_at: TS,
      survey_json: null,
    });

    expect(await db.waitlistRankOf(1, TS, "wl_here")).toBe(2);
    expect(await db.waitlistRankOf(1, "2026-07-25T00:00:00.000Z", "wl_gone")).toBe(1);
  });

  // Mirror of the listWaitlist ordering tests in schema.test.ts. The mock
  // ordered by created_at alone while waitlistRankOf used (created_at, id),
  // so the row listed first could report position 3. Route tests run on this
  // backend, so the two must stay semantically identical.
  async function seedOutOfIdOrder(db: ReturnType<typeof createMemoryConnectDb>): Promise<void> {
    const TS = "2026-07-26T00:00:00.000Z";
    // Insertion order != id order; Map iteration is insertion-ordered, so an
    // unsorted (or partially sorted) implementation returns wl_c first.
    for (const { id, email } of [
      { id: "wl_c", email: "c@x.com" },
      { id: "wl_a", email: "a@x.com" },
      { id: "wl_b", email: "b@x.com" },
    ]) {
      await db.insertWaitlist({ id, email, batch: 1, status: "pending", created_at: TS, survey_json: null });
    }
  }

  it("listWaitlist 同一秒内按 id 排序，而非插入顺序（memory mock）", async () => {
    const db = createMemoryConnectDb();
    await seedOutOfIdOrder(db);

    expect((await db.listWaitlist(1)).map((r) => r.id)).toEqual(["wl_a", "wl_b", "wl_c"]);
  });

  it("CROSS-CONSISTENCY: listWaitlist[i] 的 rank 恰为 i+1（memory mock）", async () => {
    const db = createMemoryConnectDb();
    await seedOutOfIdOrder(db);

    const rows = await db.listWaitlist(1);
    const ranks = await Promise.all(rows.map((r) => db.waitlistRankOf(1, r.created_at, r.id)));

    expect(ranks).toEqual(rows.map((_, i) => i + 1));
  });

  it("CROSS-CONSISTENCY 在混合时间戳 + 同秒并列下仍成立（memory mock）", async () => {
    const db = createMemoryConnectDb();
    const TS = "2026-07-26T00:00:00.000Z";
    const LATER = "2026-07-27T00:00:00.000Z";
    for (const { id, email, created_at, batch } of [
      { id: "wl_m", email: "m@x.com", created_at: LATER, batch: 1 },
      { id: "wl_c", email: "c@x.com", created_at: TS, batch: 1 },
      { id: "wl_z", email: "z@x.com", created_at: LATER, batch: 1 },
      { id: "wl_a", email: "a@x.com", created_at: TS, batch: 1 },
      { id: "wl_aaa_other", email: "o@x.com", created_at: TS, batch: 2 },
    ]) {
      await db.insertWaitlist({ id, email, batch, status: "pending", created_at, survey_json: null });
    }

    const rows = await db.listWaitlist(1);
    expect(rows.map((r) => r.id)).toEqual(["wl_a", "wl_c", "wl_m", "wl_z"]);

    const ranks = await Promise.all(rows.map((r) => db.waitlistRankOf(1, r.created_at, r.id)));
    expect(ranks).toEqual([1, 2, 3, 4]);
  });
});

describe("endpoint cf_access_app_id 可空", () => {
  // NOTE: this only pins the in-memory ConnectDb contract. createMemoryConnectDb
  // is a plain Map with no constraint engine, so a green result here says
  // NOTHING about whether the real table accepts the NULL — it passed happily
  // the entire time schema.sql declared `cf_access_app_id TEXT NOT NULL` and
  // production 500'd on every provision. The authoritative coverage is
  // schema.test.ts, which runs this same insert against real SQLite built from
  // schema.sql. Do not treat this test as constraint verification.
  it("cf_access_app_id 为 null（去 Access 后）时正常插入", async () => {
    const db = createMemoryConnectDb();
    await db.insertInvite(makeInvite());
    const ep = await db.insertEndpoint(
      makeEndpoint({ cf_access_app_id: null, cf_access_policy_id: null }),
    );
    expect(ep.cf_access_app_id).toBeNull();
    expect(ep.cf_access_policy_id).toBeNull();
  });
});
