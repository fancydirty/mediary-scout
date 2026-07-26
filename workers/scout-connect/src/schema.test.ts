import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createD1ConnectDb, type D1Database, type EndpointRow } from "./db.js";

// Why this file exists (CRITICAL-2 / HIGH-3):
// The rest of the suite exercises `createMemoryConnectDb`, a plain Map with no
// constraint engine — it accepted a NULL that the committed schema physically
// rejects, so 125 green tests coexisted with a control plane that 500s on the
// first provision after deploy. These tests run the REAL `createD1ConnectDb`
// SQL against a REAL SQLite database created from the REAL schema.sql, which
// is the only configuration that can catch a constraint/DDL drift.

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const MIGRATION_SQL = readFileSync(
  new URL("../migrations/0001-drop-access-notnull-add-last-seen.sql", import.meta.url),
  "utf8",
);

// The production shape BEFORE this Worker version: schema.sql as of 884f4c4.
// `cf_access_app_id` is NOT NULL and `last_seen_at` does not exist — exactly
// what an already-deployed D1 instance looks like when the migration runs.
const LEGACY_SCHEMA_SQL = `
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  invitee_label TEXT,
  email TEXT NOT NULL,
  slug TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  provisioned_at TEXT,
  revoked_at TEXT
);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL UNIQUE,
  cf_tunnel_id TEXT NOT NULL,
  cf_access_app_id TEXT NOT NULL,
  cf_access_policy_id TEXT,
  cf_dns_record_id TEXT NOT NULL,
  status TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  token_ciphertext TEXT,
  token_shown_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  invite_id TEXT,
  endpoint_id TEXT,
  detail_json TEXT
);

CREATE INDEX idx_endpoints_status ON endpoints(status);

CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_waitlist_email_batch ON waitlist(email, batch);
`;

type Sqlite = Database.Database;

/**
 * Minimal D1Database implemented over better-sqlite3 so the production
 * `createD1ConnectDb` statements execute verbatim against real SQLite.
 */
function d1Over(sqlite: Sqlite): D1Database {
  return {
    prepare(query: string) {
      const stmt = sqlite.prepare(query);
      let bound: unknown[] = [];
      const api = {
        bind(...values: unknown[]) {
          bound = values;
          return api;
        },
        async first<T>(): Promise<T | null> {
          return (stmt.get(...bound) as T | undefined) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: stmt.all(...bound) as T[] };
        },
        async run(): Promise<unknown> {
          const info = stmt.run(...bound);
          // D1 surfaces affected-row count under meta.changes; markTokenShown
          // depends on it.
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  };
}

function freshDb(sql: string): { sqlite: Sqlite; db: ReturnType<typeof createD1ConnectDb> } {
  const sqlite = new Database(":memory:");
  sqlite.exec(sql);
  return { sqlite, db: createD1ConnectDb(d1Over(sqlite)) };
}

/** The exact row provision.ts writes today: both Access columns are null. */
function postAccessEndpoint(overrides: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: "ep_1",
    invite_id: "inv_1",
    slug: "alice",
    hostname: "alice.mediaryconnect.app",
    cf_tunnel_id: "tun_1",
    cf_access_app_id: null,
    cf_access_policy_id: null,
    cf_dns_record_id: "dns_1",
    status: "active",
    token_sha256: "sha256hex",
    token_ciphertext: "ciphertext",
    token_shown_at: null,
    last_seen_at: null,
    created_at: "2026-07-26T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

function indexNames(sqlite: Sqlite): string[] {
  return (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as {
    name: string;
  }[]).map((r) => r.name);
}

function queryPlan(sqlite: Sqlite, sql: string, ...params: unknown[]): string {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return rows.map((r) => r.detail).join(" | ");
}

describe("schema.sql — fresh install against real SQLite", () => {
  it("CRITICAL-2: accepts the endpoint row provision.ts actually writes (Access ids null)", async () => {
    const { db } = freshDb(SCHEMA_SQL);
    const row = postAccessEndpoint();

    // Before the fix this threw: NOT NULL constraint failed:
    // endpoints.cf_access_app_id (SQLITE code 19).
    await expect(db.insertEndpoint(row)).resolves.toMatchObject({ id: "ep_1" });

    const stored = await db.getEndpointById("ep_1");
    expect(stored?.cf_access_app_id).toBeNull();
    expect(stored?.cf_access_policy_id).toBeNull();
  });

  it("CRITICAL-2: the DDL itself declares cf_access_app_id without NOT NULL", () => {
    const { sqlite } = freshDb(SCHEMA_SQL);
    const cols = sqlite.prepare(`PRAGMA table_info(endpoints)`).all() as {
      name: string;
      notnull: number;
    }[];
    expect(cols.find((c) => c.name === "cf_access_app_id")?.notnull).toBe(0);
  });

  it("HIGH-3: last_seen_at exists and updateEndpointLastSeen persists to it", async () => {
    const { db } = freshDb(SCHEMA_SQL);
    await db.insertEndpoint(postAccessEndpoint());

    await db.updateEndpointLastSeen("ep_1", "2026-07-26T10:00:00.000Z");

    expect((await db.getEndpointById("ep_1"))?.last_seen_at).toBe("2026-07-26T10:00:00.000Z");
  });

  it("HIGH-4: waitlist count and token_sha256 lookup are index-backed, not full scans", () => {
    const { sqlite } = freshDb(SCHEMA_SQL);

    const waitlistPlan = queryPlan(sqlite, `SELECT COUNT(*) as cnt FROM waitlist WHERE batch = ?`, 1);
    expect(waitlistPlan).toContain("idx_waitlist_batch_created");
    expect(waitlistPlan).not.toContain("SCAN waitlist");

    // The position query on the /waitlist hot path. The rank predicate is
    // written as `created_at <= ? AND (created_at < ? OR id <= ?)` rather than
    // the equivalent `created_at < ? OR (created_at = ? AND id <= ?)` on
    // purpose: only the former keeps the created_at range bound on the index.
    // Measured on this schema — the OR-first form degrades the plan to
    // `SEARCH waitlist USING INDEX idx_waitlist_batch_created (batch=?)`,
    // i.e. it walks the entire batch instead of stopping at created_at.
    const positionPlan = queryPlan(
      sqlite,
      `SELECT COUNT(*) as cnt FROM waitlist WHERE batch = ? AND created_at <= ? AND (created_at < ? OR id <= ?)`,
      1,
      "2026-07-26T00:00:00.000Z",
      "2026-07-26T00:00:00.000Z",
      "wl_zzzz",
    );
    expect(positionPlan).toContain("idx_waitlist_batch_created");
    expect(positionPlan).not.toContain("SCAN waitlist");
    // Pin the range bound itself, not merely "an index was used".
    expect(positionPlan).toContain("created_at<?");

    const tokenPlan = queryPlan(sqlite, `SELECT * FROM endpoints WHERE token_sha256 = ?`, "x");
    expect(tokenPlan).toContain("idx_endpoints_token_sha256");
    expect(tokenPlan).not.toContain("SCAN endpoints");
  });

  it("MEDIUM-7: waitlist.status default matches the literal the routes filter on", () => {
    const { sqlite } = freshDb(SCHEMA_SQL);
    sqlite
      .prepare(`INSERT INTO waitlist (id, email, created_at) VALUES (?, ?, ?)`)
      .run("w_default", "d@example.com", "2026-07-26T00:00:00.000Z");
    const row = sqlite.prepare(`SELECT status FROM waitlist WHERE id = 'w_default'`).get() as {
      status: string;
    };
    // A row created via the schema default must be visible to the position
    // math, which counts `status = 'pending'`.
    expect(row.status).toBe("pending");
  });

  it("does not carry a stale hand-migration comment now that a real migration exists", () => {
    expect(SCHEMA_SQL).not.toContain("部署时由运维脚本执行");
    expect(SCHEMA_SQL).not.toContain("endpoints_old");
  });
});

describe("waitlist rank against real SQLite — whole-second timestamp ties", () => {
  // Measured against this schema with three rows sharing one timestamp, the
  // old `WHERE batch = ? AND created_at <= ?` predicate returned:
  //   a@x.com -> 3, b@x.com -> 3, c@x.com -> 3
  // i.e. `<=` only converted "everybody is #1" into "everybody is #N". The
  // waitlist writes whole-second ISO timestamps, so same-second signups are
  // the normal case, not an edge case. The rank must therefore be total, which
  // requires a tiebreaker column — `id` is the PRIMARY KEY, so (created_at, id)
  // is unique and the resulting rank is distinct and stable across calls.
  const TS = "2026-07-26T00:00:00.000Z";

  function seedSameSecond(db: ReturnType<typeof createD1ConnectDb>): Promise<unknown> {
    // Inserted out of id order on purpose: rank must follow (created_at, id),
    // not physical insertion/rowid order.
    return Promise.all([
      db.insertWaitlist({ id: "wl_b", email: "b@x.com", batch: 1, status: "pending", created_at: TS }),
      db.insertWaitlist({ id: "wl_c", email: "c@x.com", batch: 1, status: "pending", created_at: TS }),
      db.insertWaitlist({ id: "wl_a", email: "a@x.com", batch: 1, status: "pending", created_at: TS }),
    ]);
  }

  it("gives 3 rows sharing one timestamp distinct positions 1,2,3 ordered by id", async () => {
    const { db } = freshDb(SCHEMA_SQL);
    await seedSameSecond(db);

    const ranks = await Promise.all(
      ["wl_a", "wl_b", "wl_c"].map((id) => db.waitlistRankOf(1, TS, id)),
    );

    expect(ranks).toEqual([1, 2, 3]);
    expect(new Set(ranks).size).toBe(3);
  });

  it("is stable: repeated calls return the same rank for the same row", async () => {
    const { db } = freshDb(SCHEMA_SQL);
    await seedSameSecond(db);

    const first = await db.waitlistRankOf(1, TS, "wl_b");
    const second = await db.waitlistRankOf(1, TS, "wl_b");
    expect(second).toBe(first);
    expect(first).toBe(2);
  });

  it("still orders across differing timestamps, and ignores other batches", async () => {
    const { db } = freshDb(SCHEMA_SQL);
    await db.insertWaitlist({
      id: "wl_early",
      email: "early@x.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-25T00:00:00.000Z",
    });
    await db.insertWaitlist({
      id: "wl_late",
      email: "late@x.com",
      batch: 1,
      status: "pending",
      created_at: "2026-07-27T00:00:00.000Z",
    });
    // A high id in another batch must not inflate batch 1 ranks.
    await db.insertWaitlist({
      id: "wl_zzz_other",
      email: "other@x.com",
      batch: 2,
      status: "pending",
      created_at: "2026-07-25T00:00:00.000Z",
    });

    expect(await db.waitlistRankOf(1, "2026-07-25T00:00:00.000Z", "wl_early")).toBe(1);
    expect(await db.waitlistRankOf(1, "2026-07-27T00:00:00.000Z", "wl_late")).toBe(2);
    expect(await db.waitlistRankOf(2, "2026-07-25T00:00:00.000Z", "wl_zzz_other")).toBe(1);
  });

  it("a same-second row with a lower id does not share the later row's rank", async () => {
    // The precise regression: under `created_at <= ?` both of these returned 2.
    const { db } = freshDb(SCHEMA_SQL);
    await db.insertWaitlist({ id: "wl_1", email: "one@x.com", batch: 1, status: "pending", created_at: TS });
    await db.insertWaitlist({ id: "wl_2", email: "two@x.com", batch: 1, status: "pending", created_at: TS });

    const a = await db.waitlistRankOf(1, TS, "wl_1");
    const b = await db.waitlistRankOf(1, TS, "wl_2");
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(a).not.toBe(b);
  });
});

describe("migration 0001 — existing install against real SQLite", () => {
  it("is not wrapped in BEGIN/COMMIT (D1 rejects explicit transactions)", () => {
    expect(MIGRATION_SQL).not.toMatch(/^\s*BEGIN\b/im);
    expect(MIGRATION_SQL).not.toMatch(/^\s*COMMIT\b/im);
  });

  it("never contains the literal wrangler's splitter string-matches on", () => {
    // Verified against wrangler 4.114.0: the adjacent words BEGIN + TRANSACTION
    // anywhere in the file — INCLUDING inside a `--` comment — make
    // `d1 execute --file` abort with "contains several transactions" before it
    // parses any SQL. This bit the first draft of migration 0001, whose header
    // quoted the D1 error message verbatim; better-sqlite3 executed that file
    // happily, so only the real wrangler run caught it. (A bare SAVEPOINT in a
    // comment was tested and is NOT rejected, so it is not asserted here; a
    // SAVEPOINT *statement* is caught by the leading-keyword check above.)
    for (const sql of [MIGRATION_SQL, SCHEMA_SQL]) {
      expect(sql).not.toMatch(/BEGIN\s+TRANSACTION/i);
      expect(sql).not.toMatch(/^\s*SAVEPOINT\b/im);
    }
  });

  it("never uses INSERT ... SELECT * (column order must be explicit)", () => {
    expect(MIGRATION_SQL).not.toMatch(/SELECT\s+\*\s+FROM\s+endpoints_old/i);
  });

  it("documents how to run it and that it precedes the deploy", () => {
    expect(MIGRATION_SQL).toContain("wrangler d1 execute");
    expect(MIGRATION_SQL).toMatch(/BEFORE/i);
  });

  it("CRITICAL-2 + HIGH-3: legacy table rejects the write; after migration it accepts it", async () => {
    // Prove the legacy shape really is broken, so the migration test below is
    // meaningful rather than vacuous. Two independent defects stack here, and
    // SQLite reports them in statement order: the missing column (HIGH-3)
    // errors before the NOT NULL (CRITICAL-2) is ever evaluated.
    const legacy = freshDb(LEGACY_SCHEMA_SQL);
    await expect(legacy.db.insertEndpoint(postAccessEndpoint())).rejects.toThrow(
      /no column named last_seen_at/i,
    );

    // Isolate CRITICAL-2: add only the missing column, and the NOT NULL on
    // cf_access_app_id is still what kills the insert.
    const halfMigrated = freshDb(LEGACY_SCHEMA_SQL);
    halfMigrated.sqlite.exec(`ALTER TABLE endpoints ADD COLUMN last_seen_at TEXT`);
    await expect(halfMigrated.db.insertEndpoint(postAccessEndpoint())).rejects.toThrow(
      /NOT NULL constraint failed: endpoints\.cf_access_app_id/i,
    );

    const { sqlite, db } = freshDb(LEGACY_SCHEMA_SQL);
    sqlite.exec(MIGRATION_SQL);

    await expect(db.insertEndpoint(postAccessEndpoint())).resolves.toMatchObject({ id: "ep_1" });
    await db.updateEndpointLastSeen("ep_1", "2026-07-26T10:00:00.000Z");
    const stored = await db.getEndpointById("ep_1");
    expect(stored?.cf_access_app_id).toBeNull();
    expect(stored?.last_seen_at).toBe("2026-07-26T10:00:00.000Z");
  });

  it("preserves every column of pre-existing rows through the table rebuild", () => {
    const { sqlite } = freshDb(LEGACY_SCHEMA_SQL);
    sqlite
      .prepare(
        `INSERT INTO endpoints (id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id,
           cf_access_policy_id, cf_dns_record_id, status, token_sha256, token_ciphertext,
           token_shown_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "ep_legacy",
        "inv_legacy",
        "bob",
        "bob.mediaryconnect.app",
        "tun_legacy",
        "app_legacy",
        "pol_legacy",
        "dns_legacy",
        "active",
        "legacy_sha",
        "legacy_ct",
        null,
        "2026-07-01T00:00:00.000Z",
        null,
      );

    sqlite.exec(MIGRATION_SQL);

    const row = sqlite.prepare(`SELECT * FROM endpoints WHERE id = 'ep_legacy'`).get() as Record<
      string,
      unknown
    >;
    // Column-by-column: a positional `INSERT ... SELECT *` mismatch would
    // silently shuffle these.
    expect(row).toMatchObject({
      id: "ep_legacy",
      invite_id: "inv_legacy",
      slug: "bob",
      hostname: "bob.mediaryconnect.app",
      cf_tunnel_id: "tun_legacy",
      cf_access_app_id: "app_legacy",
      cf_access_policy_id: "pol_legacy",
      cf_dns_record_id: "dns_legacy",
      status: "active",
      token_sha256: "legacy_sha",
      token_ciphertext: "legacy_ct",
      token_shown_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      revoked_at: null,
    });
    expect(row.last_seen_at).toBeNull();
    expect(sqlite.prepare(`SELECT COUNT(*) as c FROM endpoints`).get()).toEqual({ c: 1 });
  });

  it("drops the scratch table and recreates every index", () => {
    const { sqlite } = freshDb(LEGACY_SCHEMA_SQL);
    sqlite.exec(MIGRATION_SQL);

    const tables = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
      name: string;
    }[]).map((r) => r.name);
    expect(tables).not.toContain("endpoints_old");

    const idx = indexNames(sqlite);
    // Rebuilding a table silently drops its indexes — the status index must
    // come back or the revoke_failed sweep degrades to a scan.
    expect(idx).toContain("idx_endpoints_status");
    expect(idx).toContain("idx_endpoints_token_sha256");
    expect(idx).toContain("idx_waitlist_batch_created");
  });

  it("preserves the endpoints UNIQUE constraints after the rebuild", () => {
    const { sqlite } = freshDb(LEGACY_SCHEMA_SQL);
    sqlite.exec(MIGRATION_SQL);

    const insert = (id: string, inviteId: string, slug: string, hostname: string): void => {
      sqlite
        .prepare(
          `INSERT INTO endpoints (id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id,
             cf_access_policy_id, cf_dns_record_id, status, token_sha256, token_ciphertext,
             token_shown_at, last_seen_at, created_at, revoked_at)
           VALUES (?, ?, ?, ?, 't', NULL, NULL, 'd', 'active', 's', NULL, NULL, NULL, '2026-07-26T00:00:00.000Z', NULL)`,
        )
        .run(id, inviteId, slug, hostname);
    };
    insert("e1", "i1", "s1", "h1");
    expect(() => insert("e2", "i1", "s2", "h2")).toThrow(/UNIQUE/i);
    expect(() => insert("e3", "i2", "s1", "h3")).toThrow(/UNIQUE/i);
    expect(() => insert("e4", "i3", "s4", "h1")).toThrow(/UNIQUE/i);
  });

  it("migrated shape matches a fresh schema.sql install exactly", () => {
    const migrated = freshDb(LEGACY_SCHEMA_SQL);
    migrated.sqlite.exec(MIGRATION_SQL);
    const fresh = freshDb(SCHEMA_SQL);

    const shapeOf = (sqlite: Sqlite): unknown =>
      (sqlite.prepare(`PRAGMA table_info(endpoints)`).all() as {
        name: string;
        type: string;
        notnull: number;
      }[]).map((c) => `${c.name} ${c.type} notnull=${c.notnull}`);

    // Fresh installs and migrated installs must converge, or the next
    // migration is written against a shape that only exists in one of them.
    expect(shapeOf(migrated.sqlite)).toEqual(shapeOf(fresh.sqlite));
    expect(indexNames(migrated.sqlite).sort()).toEqual(indexNames(fresh.sqlite).sort());
  });

  it("aborts rather than double-rebuilding when applied twice", () => {
    const { sqlite } = freshDb(LEGACY_SCHEMA_SQL);
    sqlite.exec(MIGRATION_SQL);
    // SQLite has no `ADD COLUMN IF NOT EXISTS`; the guard is that the additive
    // step fails first, and `wrangler d1 execute --file` rolls the file back.
    expect(() => sqlite.exec(MIGRATION_SQL)).toThrow(/duplicate column name/i);
  });
});
