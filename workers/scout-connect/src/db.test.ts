import { describe, it, expect } from "vitest";
import {
  createMemoryConnectDb,
  createD1ConnectDb,
  type D1Database,
  type D1PreparedStatement,
  type InviteRow,
  type EndpointRow,
  type AuditRow,
  type EntitlementRow,
  type PaymentOrderRow,
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
    revoked_at: null, account_id: null, grace_until: null, suspended_at: null, purge_after: null,
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

  it("0004: many NULL invite_id rows coexist (SQLite UNIQUE ignores NULLs — memory must match)", async () => {
    const db = createMemoryConnectDb();
    await db.insertEndpoint(
      makeEndpoint({ id: "ep_a", invite_id: null, slug: "sa", hostname: "sa.x", account_id: "act_a" }),
    );
    await db.insertEndpoint(
      makeEndpoint({ id: "ep_b", invite_id: null, slug: "sb", hostname: "sb.x", account_id: "act_b" }),
    );
    expect(await db.getEndpointById("ep_a")).not.toBeNull();
    expect(await db.getEndpointById("ep_b")).not.toBeNull();
  });

  it("0004: one live endpoint per account — second active row dies, revoked row frees the slot", async () => {
    const db = createMemoryConnectDb();
    await db.insertEndpoint(
      makeEndpoint({ id: "ep_1", invite_id: null, slug: "s1", hostname: "s1.x", account_id: "act_1" }),
    );
    await expect(
      db.insertEndpoint(
        makeEndpoint({ id: "ep_2", invite_id: null, slug: "s2", hostname: "s2.x", account_id: "act_1" }),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed: endpoints\.account_id/);
    await db.markEndpointRevoked("ep_1", "2026-07-28T03:00:00.000Z");
    await db.insertEndpoint(
      makeEndpoint({ id: "ep_3", invite_id: null, slug: "s3", hostname: "s3.x", account_id: "act_1" }),
    );
    expect((await db.getActiveEndpointByAccountId("act_1"))?.id).toBe("ep_3");
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

  it("updateWaitlistSurvey binds the JSON without leaking it into SQL text", async () => {
    const { d1, calls } = createSpyD1();
    const db = createD1ConnectDb(d1);
    await db.updateWaitlistSurvey("w1", `{"feedback":"加长版"}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("run");
    expect(calls[0]?.query).toBe("UPDATE waitlist SET survey_json = ? WHERE id = ?");
    expect(calls[0]?.query).not.toContain("加长版");
    expect(calls[0]?.binds).toEqual([`{"feedback":"加长版"}`, "w1"]);
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

  it("getWaitlistById 返回匹配行或 null", async () => {
    const db = createMemoryConnectDb();
    await db.insertWaitlist({
      id: "w1",
      email: "b@y.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-25T00:00:00Z",
      survey_json: null,
    });
    expect(await db.getWaitlistById("w1")).toMatchObject({ id: "w1", email: "b@y.com" });
    expect(await db.getWaitlistById("missing")).toBeNull();
  });

  it("updateWaitlistSurvey persists survey_json and overwrites on re-submit", async () => {
    const db = createMemoryConnectDb();
    await db.insertWaitlist({
      id: "w1",
      email: "b@y.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-25T00:00:00Z",
      survey_json: null,
    });
    expect((await db.getWaitlistById("w1"))?.survey_json).toBeNull();

    await db.updateWaitlistSurvey("w1", `{"donate":true}`);
    expect((await db.getWaitlistById("w1"))?.survey_json).toBe(`{"donate":true}`);

    await db.updateWaitlistSurvey("w1", `{"donate":false,"feedback":"x"}`);
    expect((await db.getWaitlistById("w1"))?.survey_json).toBe(`{"donate":false,"feedback":"x"}`);
  });

  it("updateWaitlistSurvey on a nonexistent id is a silent no-op (D1 UPDATE parity)", async () => {
    const db = createMemoryConnectDb();
    await expect(db.updateWaitlistSurvey("nope", `{}`)).resolves.toBeUndefined();
    expect(await db.getWaitlistById("nope")).toBeNull();
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

describe("insertWaitlist 迁移窗口降级", () => {
  /** D1 stub：含 survey_json 的 INSERT 抛 "no such column"，legacy INSERT 放行。 */
  function createPreMigrationD1() {
    const calls: { query: string; binds: unknown[] }[] = [];
    const d1: D1Database = {
      prepare(query: string): D1PreparedStatement {
        const binds: unknown[] = [];
        const stmt: D1PreparedStatement = {
          bind(...values: unknown[]) {
            binds.push(...values);
            return stmt;
          },
          async first<T>(): Promise<T | null> { return null as T | null; },
          async all<T>(): Promise<{ results: T[] }> { return { results: [] as T[] }; },
          async run(): Promise<unknown> {
            calls.push({ query, binds: [...binds] });
            if (query.includes("survey_json")) {
              throw new Error("no such column: survey_json");
            }
            return {};
          },
        };
        return stmt;
      },
    };
    return { d1, calls };
  }

  it("列不存在时退化为 legacy INSERT，报名不挂", async () => {
    const { d1, calls } = createPreMigrationD1();
    const db = createD1ConnectDb(d1);
    const row = await db.insertWaitlist({
      id: "w1", email: "a@x.com", batch: 1, status: "pending",
      created_at: "2026-07-25T00:00:00Z", survey_json: null,
    });
    expect(row.id).toBe("w1");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query).toContain("survey_json");
    expect(calls[1]!.query).not.toContain("survey_json");
    expect(calls[1]!.binds).toEqual(["w1", "a@x.com", 1, "pending", "2026-07-25T00:00:00Z"]);
  });

  it("另一种缺列措辞（no column named）同样触发降级", async () => {
    // SQLite/D1 不同版本的报错文案可能是 "no such column" 或 "no column named"——
    // 匹配过窄会让降级在它唯一存在的窗口期失灵（Copilot PR #181 round 4）。
    const calls: string[] = [];
    const d1: D1Database = {
      prepare(query: string): D1PreparedStatement {
        const stmt: D1PreparedStatement = {
          bind() { return stmt; },
          async first<T>(): Promise<T | null> { return null as T | null; },
          async all<T>(): Promise<{ results: T[] }> { return { results: [] as T[] }; },
          async run(): Promise<unknown> {
            calls.push(query);
            if (query.includes("survey_json")) {
              throw new Error("no column named survey_json");
            }
            return {};
          },
        };
        return stmt;
      },
    };
    const db = createD1ConnectDb(d1);
    const row = await db.insertWaitlist({
      id: "w1", email: "a@x.com", batch: 1, status: "pending",
      created_at: "t", survey_json: null,
    });
    expect(row.id).toBe("w1");
    expect(calls).toHaveLength(2);
  });

  it("其它错误（如 UNIQUE 冲突）原样上抛，绝不降级吞掉", async () => {
    const d1: D1Database = {
      prepare(): D1PreparedStatement {
        const stmt: D1PreparedStatement = {
          bind() { return stmt; },
          async first<T>(): Promise<T | null> { return null as T | null; },
          async all<T>(): Promise<{ results: T[] }> { return { results: [] as T[] }; },
          async run(): Promise<unknown> {
            throw new Error("UNIQUE constraint failed: waitlist.email");
          },
        };
        return stmt;
      },
    };
    const db = createD1ConnectDb(d1);
    await expect(
      db.insertWaitlist({
        id: "w1", email: "a@x.com", batch: 1, status: "pending",
        created_at: "t", survey_json: null,
      }),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe("waitlist survey_json 兼容", () => {
  it("老 schema（无 survey_json 列）的行映射为 null 而非 undefined", async () => {
    // 迁移 0002 执行前的窗口期：老表 SELECT * 根本不会返回 survey_json 列。
    // 用 spy D1 直接喂一个「缺键」的原始行（memory backend 测不到这条路径——
    // 它的行总是带键）。映射必须落成 null：undefined 会破坏 WaitlistRow 契约，
    // 且 JSON.stringify 会把整个键丢掉（API 响应形状在迁移前后不一致）。
    const legacyRow = {
      id: "w1",
      email: "a@x.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-25T00:00:00Z",
      // 故意没有 survey_json 键 —— 这就是迁移前的行形状
    };
    const { d1 } = createSpyD1({ first: legacyRow });
    const db = createD1ConnectDb(d1);
    const row = await db.getWaitlistByEmail("a@x.com", 1);
    expect(row).not.toBeNull();
    expect(row!.survey_json).toBeNull(); // 不是 undefined
    expect("survey_json" in row!).toBe(true);
    expect(JSON.parse(JSON.stringify(row))).toHaveProperty("survey_json", null);
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

// Copilot round-1:hitAndCount 是发信限流的关键路径,却没有单测覆盖
// (batch 与回退两条路径、语句顺序、COUNT 结果解析)。
describe("hitAndCount(限流计数)", () => {
  it("d1.batch 存在时:按 [DELETE, INSERT, COUNT] 一次往返,从最后一条读 cnt", async () => {
    const seen: Array<{ query: string; binds: unknown[] }> = [];
    const mkStmt = (query: string): D1PreparedStatement => {
      const binds: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...v: unknown[]) { binds.push(...v); seen.push({ query, binds }); return stmt; },
        async first<T>() { return null as T | null; },
        async all<T>() { return { results: [] as T[] }; },
        async run() { return undefined; },
      };
      return stmt;
    };
    let batched: D1PreparedStatement[] | null = null;
    const d1: D1Database = {
      prepare: mkStmt,
      async batch(stmts) {
        batched = stmts;
        // 只有最后一条(COUNT)有 results
        return [{}, {}, { results: [{ cnt: 4 }] }];
      },
    };
    const db = createD1ConnectDb(d1);
    const n = await db.hitAndCount("signup_ip", "1.2.3.4", "2026-08-01T00:00:10Z", "2026-08-01T00:00:00Z");
    expect(n).toBe(4);
    expect(batched).not.toBeNull();
    expect(batched!.length).toBe(3);
    // 语句顺序:先删过期、再写本次、最后数(所以返回值含本次)
    const qs = seen.map((c) => c.query);
    expect(qs[0]).toContain("DELETE FROM rate_limits");
    expect(qs[1]).toContain("INSERT INTO rate_limits");
    expect(qs[2]).toContain("SELECT COUNT(*)");
    // DELETE 用 <= windowStart(含边界),COUNT 用 > windowStart —— 两者互补,
    // 不会把恰好落在边界上的行既删掉又数进去。
    expect(qs[0]).toContain("at <= ?");
    expect(qs[2]).toContain("at > ?");
  });

  it("d1.batch 缺失时:回退成 run/run/first,顺序与 binds 不变", async () => {
    const order: string[] = [];
    const mkStmt = (query: string): D1PreparedStatement => {
      const binds: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...v: unknown[]) { binds.push(...v); return stmt; },
        async first<T>() { order.push(`first:${query.slice(0, 12)}`); return { cnt: 2 } as unknown as T; },
        async all<T>() { return { results: [] as T[] }; },
        async run() { order.push(`run:${query.trim().slice(0, 6)}`); return undefined; },
      };
      return stmt;
    };
    // 刻意不给 batch —— 走回退路径
    const d1: D1Database = { prepare: mkStmt };
    const db = createD1ConnectDb(d1);
    const n = await db.hitAndCount("signup_email", "a@b.c", "2026-08-01T00:00:10Z", "2026-08-01T00:00:00Z");
    expect(n).toBe(2);
    expect(order[0]).toContain("run:DELETE");
    expect(order[1]).toContain("run:INSERT");
    expect(order[2]).toContain("first:SELECT COUNT");
  });

  it("COUNT 返回非数字(异常响应)时算 0,不抛", async () => {
    const d1: D1Database = {
      prepare: () => {
        const stmt: D1PreparedStatement = {
          bind() { return stmt; },
          async first<T>() { return { cnt: "oops" } as unknown as T; },
          async all<T>() { return { results: [] as T[] }; },
          async run() { return undefined; },
        };
        return stmt;
      },
    };
    const db = createD1ConnectDb(d1);
    expect(await db.hitAndCount("b", "k", "2026-08-01T00:00:10Z", "2026-08-01T00:00:00Z")).toBe(0);
  });
});

function paymentOrder(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id: "ord_1",
    checkout_token_sha256: "sha_checkout_1",
    account_id: "act_1",
    provider: "alipay",
    out_trade_no: "MC202608160001",
    trade_no: null,
    months: 3,
    total_amount: "45.00",
    status: "created",
    created_at: "2026-08-16T00:00:00.000Z",
    expires_at: "2026-08-16T00:20:00.000Z",
    paid_at: null,
    fulfilled_at: null,
    closed_at: null,
    refunded_at: null,
    refund_request_no: null,
    last_notify_id: null,
    ...overrides,
  };
}

function entitlement(overrides: Partial<EntitlementRow> = {}): EntitlementRow {
  return {
    id: "ent_1",
    account_id: "act_1",
    expires_at: "2026-11-16T00:00:00.000Z",
    source: "alipay",
    paddle_transaction_id: null,
    payment_provider: "alipay",
    payment_transaction_id: "MC202608160001",
    refunded_at: null,
    months: 3,
    created_at: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("payment-order and provider-neutral entitlement persistence", () => {
  it("round-trips and updates an Alipay order by every server-owned key", async () => {
    const db = createMemoryConnectDb();
    const row = paymentOrder();
    expect(await db.insertPaymentOrder(row)).toEqual(row);
    expect(await db.getPaymentOrderById(row.id)).toEqual(row);
    expect(await db.getPaymentOrderByCheckoutHash(row.checkout_token_sha256)).toEqual(row);
    expect(await db.getPaymentOrderByOutTradeNo(row.out_trade_no)).toEqual(row);

    await db.updatePaymentOrder(row.id, {
      status: "paid",
      trade_no: "2026081622000000000001",
      paid_at: "2026-08-16T00:03:00.000Z",
      last_notify_id: "notify_1",
    });
    expect(await db.getPaymentOrderById(row.id)).toMatchObject({
      status: "paid",
      trade_no: "2026081622000000000001",
      paid_at: "2026-08-16T00:03:00.000Z",
      last_notify_id: "notify_1",
    });
  });

  it("rejects duplicate order capability, merchant order, trade, and refund request ids", async () => {
    const db = createMemoryConnectDb();
    await db.insertPaymentOrder(paymentOrder());
    for (const duplicate of [
      paymentOrder({ id: "ord_2", out_trade_no: "MC2" }),
      paymentOrder({ id: "ord_2", checkout_token_sha256: "sha_2" }),
    ]) {
      await expect(db.insertPaymentOrder(duplicate)).rejects.toThrow(/UNIQUE/i);
    }
    await db.updatePaymentOrder("ord_1", {
      trade_no: "trade_1",
      refund_request_no: "refund_1",
    });
    await db.insertPaymentOrder(
      paymentOrder({ id: "ord_2", checkout_token_sha256: "sha_2", out_trade_no: "MC2" }),
    );
    await expect(db.updatePaymentOrder("ord_2", { trade_no: "trade_1" })).rejects.toThrow(/UNIQUE/i);
    await expect(
      db.updatePaymentOrder("ord_2", { refund_request_no: "refund_1" }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("deduplicates a provider transaction but permits repeated manual grants", async () => {
    const db = createMemoryConnectDb();
    expect(await db.insertEntitlement(entitlement())).toBe(true);
    expect(await db.insertEntitlement(entitlement({ id: "ent_2" }))).toBe(false);
    expect(
      await db.insertEntitlement(
        entitlement({
          id: "ent_manual_1",
          source: "manual",
          payment_provider: null,
          payment_transaction_id: null,
        }),
      ),
    ).toBe(true);
    expect(
      await db.insertEntitlement(
        entitlement({
          id: "ent_manual_2",
          source: "manual",
          payment_provider: null,
          payment_transaction_id: null,
        }),
      ),
    ).toBe(true);
    expect((await db.listEntitlements("act_1"))[0]).toMatchObject({
      id: "ent_1",
    });
  });

  it("rejects a half-populated provider idempotency pair", async () => {
    const db = createMemoryConnectDb();
    await expect(
      db.insertEntitlement(
        entitlement({ payment_provider: "alipay", payment_transaction_id: null }),
      ),
    ).rejects.toThrow(/supplied together/i);
    await expect(
      db.insertEntitlement(
        entitlement({ payment_provider: null, payment_transaction_id: "MC-orphan" }),
      ),
    ).rejects.toThrow(/supplied together/i);
  });

  it("marks only the selected provider transaction refunded", async () => {
    const db = createMemoryConnectDb();
    await db.insertEntitlement(entitlement());
    await db.insertEntitlement(
      entitlement({
        id: "ent_2",
        payment_transaction_id: "MC202608160002",
        created_at: "2026-08-16T00:01:00.000Z",
      }),
    );

    expect(
      await db.markEntitlementRefunded(
        "alipay",
        "MC202608160001",
        "2026-08-17T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      await db.markEntitlementRefunded(
        "alipay",
        "MC202608160001",
        "2026-08-18T00:00:00.000Z",
      ),
    ).toBe(false);
    const rows = await db.listEntitlements("act_1");
    expect(rows.find((row) => row.id === "ent_1")?.refunded_at).toBe(
      "2026-08-17T00:00:00.000Z",
    );
    expect(rows.find((row) => row.id === "ent_2")?.refunded_at).toBeNull();
  });

  it("does not expose refunded time to the endpoint expiry sweep", async () => {
    const db = createMemoryConnectDb();
    await db.insertAccount({
      id: "act_1",
      email: "sweep@example.com",
      paddle_customer_id: null,
      created_at: "2026-08-16T00:00:00.000Z",
      last_login_at: null,
    });
    await db.insertEndpoint(
      makeEndpoint({
        id: "ep_paid",
        invite_id: null,
        account_id: "act_1",
        slug: "paid",
        hostname: "paid.connect.example.com",
      }),
    );
    await db.insertEntitlement(
      entitlement({ refunded_at: "2026-08-17T00:00:00.000Z" }),
    );

    expect(await db.listActiveEndpointsForSweep()).toMatchObject([{ latestExpiry: null }]);
  });
});
