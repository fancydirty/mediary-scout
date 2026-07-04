# Mediary Scout macOS Desktop App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Mediary Scout as a signed, notarized macOS `.dmg` that "downloads and runs" with no Docker/Postgres — by reusing the existing engine verbatim and adding only three things: a SQLite data-layer implementation, an Electron shell that launches the existing standalone server, and packaging.

**Architecture:** The product logic (`apps/web` + `packages/workflow`) is **not touched**. Electron's main process spawns the existing Next standalone server (`apps/web/server.js`) as a child using `ELECTRON_RUN_AS_NODE=1`, points a `BrowserWindow` at `http://127.0.0.1:<port>`, and adds a Tray + single-instance lock + close-to-tray lifecycle. The only new production code paths are: a `SqliteWorkflowRepository` behind the existing `WorkflowRepository` interface (locked to Postgres semantics by a **shared contract test suite**), a factory branch that selects it via `MEDIA_TRACK_SQLITE_PATH`, and a pure-date patrol gate (`ignoreTimeGate`) so "first open of the day" triggers the sweep regardless of wall-clock.

**Tech Stack:** Electron + electron-builder, `better-sqlite3` (synchronous, native — ABI must match Electron via `@electron/rebuild`/`npmRebuild`), the existing Next.js standalone server, npm workspaces, Vitest, TypeScript.

---

## Reading list (read before starting — do NOT port from memory)

- `packages/workflow/src/repository.ts` — the `WorkflowRepository` interface (~40 methods) and the complete `InMemoryWorkflowRepository` reference implementation. **This is the behavior oracle.**
- `packages/workflow/src/postgres.ts` — `PostgresWorkflowRepository` (the SQL you translate), `initializeWorkflowPostgresSchema`, `createPostgresWorkflowRepositorySync`. Schema DDL is at the top (~lines 50–165).
- `apps/web/lib/workflow-runtime.ts` — `getWorkflowRepository()` (line ~112), `postgresConnectionString()` (line ~104), `runScheduledType3()` (line ~1152), `beijingDateTime()` (line ~1130), `LAST_SWEEP_DATE_SETTING_KEY`.
- `apps/web/lib/background-worker.ts` — the in-process worker loop that already provides "first-tick sweep + resume + always-on".
- `apps/web/instrumentation.ts` — server startup (proxy → validateRuntimeConfig → migrations → worker).
- `apps/web/lib/tmdb-cache.ts` — `PostgresMediaSearchCache`; and `InMemoryMediaSearchCache` (exported from `@media-track/workflow`, used in demo mode).
- `Dockerfile` (CMD `node apps/web/server.js`) — the launch symmetry the Electron shell mirrors.
- Spec: `docs/superpowers/specs/2026-07-04-desktop-app-design.md`.

## PG→SQLite translation rules (apply verbatim in every repository task)

| Postgres | SQLite (better-sqlite3) |
|---|---|
| `payload jsonb` column | `payload text` column (store `JSON.stringify(obj)`) |
| node-pg returns jsonb already-parsed | rows come back as strings → `JSON.parse(row.payload)` in a `hydrate()` helper |
| `$1, $2::jsonb` params | `?` placeholders, positional; pass the JSON **string** for payload |
| `payload->>'x'` / `payload->'x'` | `json_extract(payload, '$.x')` |
| `ON CONFLICT (k) DO UPDATE SET c = EXCLUDED.c` | identical syntax — SQLite ≥3.24 supports it |
| `... RETURNING ...` | identical — SQLite ≥3.35 (bundled better-sqlite3 is newer) |
| `now()` / `timestamptz` | store ISO-8601 **text**; compare with string `<`/`>=` (ISO sorts lexically). Never use SQLite date funcs. |
| `pool.query(sql, params)` async | `db.prepare(sql).all(...params)` / `.get(...)` / `.run(...)` — **synchronous** |
| `withTransaction(async client => …)` | `db.transaction(fn)()` — synchronous; wrap in the async method and `return` |
| advisory lock for concurrent DDL | not needed — one process, one connection. Just `db.exec(DDL)` once in the constructor. |

**Async wrapper rule:** every `WorkflowRepository` method is `async` in the interface. better-sqlite3 is synchronous, so each method body runs synchronous SQLite calls and returns the value (implicitly wrapped in a resolved promise). Do **not** add fake `await`. Enable WAL once in the constructor: `db.pragma('journal_mode = WAL')`.

---

## File structure

**Create:**
- `packages/workflow/src/sqlite.ts` — `SqliteWorkflowRepository implements WorkflowRepository` + `createSqliteWorkflowRepository({ path })` + `SQLITE_SCHEMA` DDL.
- `packages/workflow/tests/repository-contract.ts` — the shared, factory-parametrized behavior suite (`runRepositoryContract`).
- `packages/workflow/tests/repository-contract-inmemory.test.ts` — runs the suite against `InMemoryWorkflowRepository` (oracle; proves the suite is faithful).
- `packages/workflow/tests/repository-contract-sqlite.test.ts` — runs the suite against `SqliteWorkflowRepository` (drives the port; always runs, temp file).
- `apps/desktop/package.json`, `apps/desktop/tsconfig.json`
- `apps/desktop/src/server-launch.ts` — **pure, testable**: `pickFreePort()`, `waitForHealthy(url, opts)`, `resolveServerEntry(env)`, `buildServerEnv(...)`.
- `apps/desktop/src/lifecycle.ts` — **pure, testable**: Tray menu state + close/quit state machine helpers.
- `apps/desktop/src/main.ts` — Electron entry: single-instance lock, spawn server, window, tray, wiring (thin glue over the two pure modules).
- `apps/desktop/tests/server-launch.test.ts`, `apps/desktop/tests/lifecycle.test.ts`
- `apps/desktop/electron-builder.yml` — mac dmg + sign + notarize config.
- `apps/desktop/build/entitlements.mac.plist` — hardened-runtime entitlements.

**Modify:**
- `apps/web/lib/workflow-runtime.ts` — `getWorkflowRepository()` gains a SQLite branch; `getDurableSearchCache`/`title-hub` degrade to in-memory when SQLite is active; `runScheduledType3` gains `ignoreTimeGate`.
- `apps/web/lib/search-page.ts` + `apps/web/lib/title-hub.ts` — pick in-memory cache when `MEDIA_TRACK_SQLITE_PATH` set.
- `packages/workflow/package.json` — add `better-sqlite3` dependency.
- Root `package.json` — add `apps/desktop` to workspaces; add `@electron/rebuild` dev step docs.

---

# Phase A — SQLite data layer (behind the contract suite)

> The contract suite is the safety net that makes "no divergence" real. Build it first, prove it green against InMemory (the oracle), then let it drive the SQLite port cluster by cluster.

### Task 1: Contract-suite scaffold, proven against InMemory

**Files:**
- Create: `packages/workflow/tests/repository-contract.ts`
- Create: `packages/workflow/tests/repository-contract-inmemory.test.ts`

- [ ] **Step 1: Write the shared suite skeleton with the first behavior (settings round-trip)**

```typescript
// packages/workflow/tests/repository-contract.ts
import { describe, it, expect } from "vitest";
import type { WorkflowRepository } from "../src/repository.js";

/** A factory that yields a FRESH, empty repository and a teardown. Postgres/SQLite
 *  return async; InMemory is sync — accept both. */
export interface RepoHarness {
  make: () => Promise<WorkflowRepository> | WorkflowRepository;
  teardown?: (repo: WorkflowRepository) => Promise<void> | void;
}

export function runRepositoryContract(name: string, harness: RepoHarness): void {
  describe(`WorkflowRepository contract: ${name}`, () => {
    async function fresh(): Promise<WorkflowRepository> {
      return await harness.make();
    }

    describe("settings", () => {
      it("round-trips an instance setting and returns null for unknown keys", async () => {
        const repo = await fresh();
        expect(await repo.getSetting("missing")).toBeNull();
        await repo.setSetting("daily_sweep_time", "06:00");
        expect(await repo.getSetting("daily_sweep_time")).toBe("06:00");
        await repo.setSetting("daily_sweep_time", "07:30"); // upsert overwrites
        expect(await repo.getSetting("daily_sweep_time")).toBe("07:30");
      });

      it("scopes account settings per account", async () => {
        const repo = await fresh();
        await repo.setAccountSetting("acct_a", "llm_key", "A");
        await repo.setAccountSetting("acct_b", "llm_key", "B");
        expect(await repo.getAccountSetting("acct_a", "llm_key")).toBe("A");
        expect(await repo.getAccountSetting("acct_b", "llm_key")).toBe("B");
        expect(await repo.getAccountSetting("acct_a", "missing")).toBeNull();
      });
    });
  });
}
```

- [ ] **Step 2: Wire the InMemory oracle run**

```typescript
// packages/workflow/tests/repository-contract-inmemory.test.ts
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { runRepositoryContract } from "./repository-contract.js";

runRepositoryContract("InMemory", { make: () => new InMemoryWorkflowRepository() });
```

- [ ] **Step 3: Run the oracle — it MUST pass (InMemory already implements settings)**

Run: `npx vitest run packages/workflow/tests/repository-contract-inmemory.test.ts`
Expected: PASS. (Green here is correct — it proves the suite faithfully describes existing behavior. If it fails, the suite has a bug; fix the suite, not InMemory.)

- [ ] **Step 4: Commit**

```bash
git add packages/workflow/tests/repository-contract.ts packages/workflow/tests/repository-contract-inmemory.test.ts
git commit -m "test(workflow): shared WorkflowRepository contract suite (settings) proven vs InMemory"
```

---

### Task 2: SQLite dependency + empty repository skeleton + failing SQLite contract run

**Files:**
- Modify: `packages/workflow/package.json`
- Create: `packages/workflow/src/sqlite.ts`
- Create: `packages/workflow/tests/repository-contract-sqlite.test.ts`

- [ ] **Step 1: Add better-sqlite3**

```bash
npm install better-sqlite3 --workspace packages/workflow
npm install --save-dev @types/better-sqlite3 --workspace packages/workflow
```

- [ ] **Step 2: Write the schema + constructor + a throwing skeleton**

The schema mirrors `packages/workflow/src/postgres.ts` (~lines 50–165) with `payload text` instead of `jsonb`. Include every table used by the Postgres repo: `media_titles, tracked_seasons, workflow_runs, episode_states, resource_snapshots, agent_decisions, agent_steps, transfer_attempts, notifications, app_settings, dead_links, accounts, sessions, connected_storages, account_settings`. Match column names and composite keys exactly (read postgres.ts for the precise PK/columns — e.g. `episode_states (tracked_season_id, connected_storage_id, episode_code)`, `connected_storages` UNIQUE `(provider, provider_uid)`, `account_settings (account_id, key)`).

```typescript
// packages/workflow/src/sqlite.ts
import Database from "better-sqlite3";
import type { WorkflowRepository /* + all the input/return types */ } from "./repository.js";
// (import the same domain/value types postgres.ts imports)

export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_titles (id text PRIMARY KEY, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS tracked_seasons (id text PRIMARY KEY, media_title_id text NOT NULL, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS workflow_runs (id text PRIMARY KEY, tracked_season_id text NOT NULL, account_id text NOT NULL, connected_storage_id text NOT NULL, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS episode_states (tracked_season_id text NOT NULL, connected_storage_id text NOT NULL, episode_code text NOT NULL, payload text NOT NULL, PRIMARY KEY (tracked_season_id, connected_storage_id, episode_code));
  CREATE TABLE IF NOT EXISTS resource_snapshots (id text PRIMARY KEY, workflow_run_id text NOT NULL, ordinal integer NOT NULL, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS agent_decisions (workflow_run_id text NOT NULL, ordinal integer NOT NULL, snapshot_id text NOT NULL, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS agent_steps (workflow_run_id text NOT NULL, ordinal integer NOT NULL, payload text NOT NULL, PRIMARY KEY (workflow_run_id, ordinal));
  CREATE TABLE IF NOT EXISTS transfer_attempts (id text PRIMARY KEY, workflow_run_id text NOT NULL, ordinal integer NOT NULL, candidate_id text NOT NULL, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications (id text PRIMARY KEY, workflow_run_id text NOT NULL, ordinal integer NOT NULL, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value text NOT NULL);
  CREATE TABLE IF NOT EXISTS account_settings (account_id text NOT NULL, key text NOT NULL, value text NOT NULL, PRIMARY KEY (account_id, key));
  CREATE TABLE IF NOT EXISTS dead_links (key text PRIMARY KEY, kind text NOT NULL, reason text NOT NULL, permanent integer NOT NULL, expires_at text, recorded_at text NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (id text PRIMARY KEY, username text UNIQUE, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, account_id text NOT NULL, payload text NOT NULL);
  CREATE TABLE IF NOT EXISTS connected_storages (id text PRIMARY KEY, account_id text NOT NULL, provider text NOT NULL, provider_uid text NOT NULL, label text, payload text NOT NULL, root_cid text, movies_cid text, tv_cid text, anime_cid text, status text NOT NULL DEFAULT 'active', frozen_reason text, frozen_at text, created_at text NOT NULL, UNIQUE (provider, provider_uid));
`;
// NOTE: confirm each column/PK against postgres.ts before finalizing — this table
// list must match what the port's queries read/write.

export function createSqliteWorkflowRepository(options: { path: string }): SqliteWorkflowRepository {
  return new SqliteWorkflowRepository(new Database(options.path));
}

export class SqliteWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Database.Database) {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SQLITE_SCHEMA);
  }
  // All methods throw until their cluster task implements them.
  async getSetting(): Promise<string | null> { throw new Error("not implemented"); }
  // ... declare the rest as throwing stubs so the file type-checks against the interface.
}
```

> To make the file compile against the full interface immediately, add every method signature as a throwing stub. TypeScript will tell you exactly which methods are missing — that list IS the port checklist.

- [ ] **Step 3: Wire the SQLite contract run (temp file per suite)**

```typescript
// packages/workflow/tests/repository-contract-sqlite.test.ts
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSqliteWorkflowRepository, SqliteWorkflowRepository } from "../src/sqlite.js";
import { runRepositoryContract } from "./repository-contract.js";

const dirs: string[] = [];
runRepositoryContract("SQLite", {
  make: () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-sqlite-"));
    dirs.push(dir);
    return createSqliteWorkflowRepository({ path: join(dir, "test.db") });
  },
  teardown: (repo) => { (repo as SqliteWorkflowRepository).close?.(); },
});
// after all: clean temp dirs (afterAll in the suite or rely on os tmp reaping)
```

Add a `close()` method to `SqliteWorkflowRepository` that calls `this.db.close()`.

- [ ] **Step 4: Run it — settings tests MUST FAIL (not implemented)**

Run: `npx vitest run packages/workflow/tests/repository-contract-sqlite.test.ts`
Expected: FAIL with "not implemented" on the settings tests. This is the RED that drives Task 3.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/package.json packages/workflow/src/sqlite.ts packages/workflow/tests/repository-contract-sqlite.test.ts
git commit -m "feat(workflow): SqliteWorkflowRepository skeleton + schema + failing contract run"
```

---

### Task 3: Implement settings + account_settings (make first contract slice green)

**Files:**
- Modify: `packages/workflow/src/sqlite.ts`

- [ ] **Step 1: Implement the four methods**

```typescript
async getSetting(key: string): Promise<string | null> {
  const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
async setSetting(key: string, value: string): Promise<void> {
  this.db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
async getAccountSetting(accountId: string, key: string): Promise<string | null> {
  const row = this.db.prepare("SELECT value FROM account_settings WHERE account_id = ? AND key = ?").get(accountId, key) as { value: string } | undefined;
  return row?.value ?? null;
}
async setAccountSetting(accountId: string, key: string, value: string): Promise<void> {
  this.db.prepare(
    "INSERT INTO account_settings (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value",
  ).run(accountId, key, value);
}
```

- [ ] **Step 2: Run both contract runs — settings green on BOTH engines**

Run: `npx vitest run packages/workflow/tests/repository-contract-sqlite.test.ts packages/workflow/tests/repository-contract-inmemory.test.ts`
Expected: PASS (settings suite green for InMemory and SQLite).

- [ ] **Step 3: Commit**

```bash
git add packages/workflow/src/sqlite.ts
git commit -m "feat(workflow): SQLite settings + account_settings (contract green)"
```

---

### Task 4: Accounts + sessions cluster

**Files:**
- Modify: `packages/workflow/tests/repository-contract.ts`, `packages/workflow/src/sqlite.ts`

- [ ] **Step 1: Add the accounts/sessions behaviors to the suite**

Cover: `createAccount` then `getAccountByUsername`/`getAccountById`/`listAccounts`; duplicate username throws `DuplicateUsernameError`; `createSession`/`getSession`/`deleteSession`; `adoptDefaultAccount` (requires a seeded `acct_default` — see below); `setAccountPassword`; `deleteSessionsForAccount(acct, exceptId)`.

```typescript
// inside runRepositoryContract, new describe block
import { DuplicateUsernameError } from "../src/repository.js";

describe("accounts + sessions", () => {
  const account = (over = {}) => ({
    id: "acct_1", username: "alice", passwordHash: "h", isOwner: true,
    createdAt: "2026-07-04T00:00:00.000Z", ...over,
  });
  it("creates and reads back an account", async () => {
    const repo = await fresh();
    await repo.createAccount(account());
    expect((await repo.getAccountByUsername("alice"))?.id).toBe("acct_1");
    expect((await repo.getAccountById("acct_1"))?.username).toBe("alice");
    expect(await repo.getAccountByUsername("nobody")).toBeNull();
  });
  it("rejects a duplicate username", async () => {
    const repo = await fresh();
    await repo.createAccount(account());
    await expect(repo.createAccount(account({ id: "acct_2" }))).rejects.toBeInstanceOf(DuplicateUsernameError);
  });
  it("round-trips and deletes a session", async () => {
    const repo = await fresh();
    const s = { id: "sess_1", accountId: "acct_1", createdAt: "2026-07-04T00:00:00.000Z", expiresAt: "2026-08-04T00:00:00.000Z" };
    await repo.createSession(s);
    expect((await repo.getSession("sess_1"))?.accountId).toBe("acct_1");
    await repo.deleteSession("sess_1");
    expect(await repo.getSession("sess_1")).toBeNull();
  });
});
```

> Read `packages/workflow/src/account-credentials.ts` for the exact `Account`/`Session` shapes and adjust the fixtures to match. `adoptDefaultAccount` needs `acct_default` present — either seed it via `createAccount` in the test, or gate that one assertion; mirror how `postgres.ts` seeds `acct_default` (its schema `INSERT ... ON CONFLICT (id) DO NOTHING` at ~line 160). If SQLite doesn't seed `acct_default` in the schema, add the same seed insert to `SQLITE_SCHEMA` so `adoptDefaultAccount` behaves identically.

- [ ] **Step 2: Run the suite — accounts/sessions FAIL on SQLite, PASS on InMemory**

Run: `npx vitest run packages/workflow/tests/repository-contract-sqlite.test.ts packages/workflow/tests/repository-contract-inmemory.test.ts`
Expected: InMemory PASS, SQLite FAIL (not implemented).

- [ ] **Step 3: Implement the cluster in sqlite.ts**

Port from `postgres.ts` (search it for `createAccount`, `getAccountByUsername`, `createSession`, `adoptDefaultAccount`, `deleteSessionsForAccount`). Store the account object as `payload` JSON with `username` also written to its own column (for the UNIQUE constraint + lookups). Representative:

```typescript
async createAccount(account: Account): Promise<void> {
  try {
    this.db.prepare("INSERT INTO accounts (id, username, payload) VALUES (?, ?, ?)")
      .run(account.id, account.username, JSON.stringify(account));
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: accounts.username/.test(e.message)) {
      throw new DuplicateUsernameError(account.username);
    }
    throw e;
  }
}
async getAccountByUsername(username: string): Promise<Account | null> {
  const row = this.db.prepare("SELECT payload FROM accounts WHERE username = ?").get(username) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Account : null;
}
```

Add a private `hydrate<T>(row): T` = `JSON.parse(row.payload)` used across the port.

- [ ] **Step 4: Run — accounts/sessions green on both engines**

Run: `npx vitest run packages/workflow/tests/repository-contract-sqlite.test.ts packages/workflow/tests/repository-contract-inmemory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/sqlite.ts packages/workflow/tests/repository-contract.ts
git commit -m "feat(workflow): SQLite accounts + sessions (contract green)"
```

---

### Task 5: connected_storages cluster

**Files:** Modify `packages/workflow/tests/repository-contract.ts`, `packages/workflow/src/sqlite.ts`

- [ ] **Step 1: Suite** — cover `upsertConnectedStorage` (insert + conflict-refresh that does NOT overwrite `status`), `listConnectedStorages(accountId)`, `findConnectedStorageByUid`, `setConnectedStorageStatus` (frozen carries reason+at, active clears), `deleteConnectedStorage` (fail-closed on accountId), and the **ownership guard**: a second `upsertConnectedStorage` with the same `(provider, providerUid)` but a different `accountId` is a no-op (must NOT steal ownership — mirror InMemory lines ~355 and postgres `ON CONFLICT (provider, provider_uid) DO UPDATE`). Read `UpsertConnectedStorageInput` in `account-credentials.ts` for fields (`rootCid/moviesCid/tvCid/animeCid/label/payload/createdAt`).

```typescript
it("refuses to let a different account overwrite an existing drive binding", async () => {
  const repo = await fresh();
  const base = { id: "cs_1", accountId: "acct_a", provider: "pan115", providerUid: "uid1", payload: { cookie: "A" }, createdAt: "2026-07-04T00:00:00.000Z" };
  await repo.upsertConnectedStorage(base);
  await repo.upsertConnectedStorage({ ...base, id: "cs_2", accountId: "acct_b", payload: { cookie: "B" } });
  const a = await repo.listConnectedStorages("acct_a");
  const b = await repo.listConnectedStorages("acct_b");
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(0); // acct_b could NOT take it
});
```

- [ ] **Step 2: Run — FAIL on SQLite.** Run: `npx vitest run packages/workflow/tests/repository-contract-sqlite.test.ts` → FAIL.
- [ ] **Step 3: Implement** the five methods (port from postgres.ts `upsertConnectedStorage` etc.). For the ownership guard: `INSERT ... ON CONFLICT (provider, provider_uid) DO UPDATE SET ... WHERE connected_storages.account_id = excluded.account_id` (only refresh when the same account owns it), matching the Postgres upsert's WHERE. Confirm the exact WHERE against postgres.ts.
- [ ] **Step 4: Run — green on both.** Run: `npx vitest run packages/workflow/tests/repository-contract-sqlite.test.ts packages/workflow/tests/repository-contract-inmemory.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(workflow): SQLite connected_storages (contract green)`

---

### Task 6: dead_links cluster

**Files:** Modify `packages/workflow/tests/repository-contract.ts`, `packages/workflow/src/sqlite.ts`

- [ ] **Step 1: Suite** — `recordDeadLink` is idempotent (first record wins); `listDeadLinkKeys({ now })` returns permanent + not-yet-expired keys, hides expired. Drive time with an explicit `now`/`ttlMs` (both InMemory and the port accept them) so the test is deterministic.

```typescript
it("hides expired non-permanent dead links but keeps permanent ones", async () => {
  const repo = await fresh();
  await repo.recordDeadLink({ key: "k_temp", kind: "magnet", reason: "r", permanent: false, ttlMs: 1000, now: "2026-07-04T00:00:00.000Z" });
  await repo.recordDeadLink({ key: "k_perm", kind: "magnet", reason: "r", permanent: true, now: "2026-07-04T00:00:00.000Z" });
  const soon = await repo.listDeadLinkKeys({ now: "2026-07-04T00:00:00.500Z" });
  expect(new Set(soon)).toEqual(new Set(["k_temp", "k_perm"]));
  const later = await repo.listDeadLinkKeys({ now: "2026-07-04T00:00:02.000Z" });
  expect(new Set(later)).toEqual(new Set(["k_perm"]));
});
```

- [ ] **Step 2: Run — FAIL on SQLite.**
- [ ] **Step 3: Implement** (`permanent` stored as `0/1` integer; `expires_at` null for permanent). Port from postgres `recordDeadLink` (`ON CONFLICT (key) DO NOTHING`) + `listDeadLinkKeys`.
- [ ] **Step 4: Run — green on both.**
- [ ] **Step 5: Commit** `feat(workflow): SQLite dead_links (contract green)`

---

### Task 7: Snapshot persist + reserve (the transactional core)

**Files:** Modify `packages/workflow/tests/repository-contract.ts`, `packages/workflow/src/sqlite.ts`

This is the largest cluster: `saveWorkflowRunSnapshot` and `reserveWorkflowRun` write across `media_titles, tracked_seasons, workflow_runs, episode_states, resource_snapshots, agent_decisions, transfer_attempts, notifications` in one transaction, then the read-back methods surface them.

- [ ] **Step 1: Suite** — build a minimal valid snapshot (reuse `packages/workflow/src/fakes.ts` if it has a builder; otherwise construct the smallest object that passes `validateWorkflowRunSnapshot`). Assert:
  - after `saveWorkflowRunSnapshot`, `getWorkflowRunSnapshot(runId)` returns it with derived `obtainedEpisodes`/`providerAheadEpisodes`;
  - `reserveWorkflowRun` returns `{status:"reserved"}` the first time and `{status:"already_active"}` when a queued/running run for the same (season, kind, scope) exists;
  - `blockIfEpisodeStatesExist` returns `already_has_episode_state` when the scoped bucket is non-empty;
  - the **cross-drive isolation** invariant: a snapshot on `cs_A` does not block reserving the same title on `cs_B` (mirror InMemory line ~582).
  - the `saveWorkflowRunSnapshot` connected-storage PRESERVE-on-repersist rule (InMemory lines ~524–527): re-persisting with `connectedStorageId` omitted keeps the original storage.

```typescript
it("reserves once, then reports already_active for the same season+scope", async () => {
  const repo = await fresh();
  const snap = makeSnapshot({ runId: "run_1", seasonId: "s_1", accountId: "acct_1", connectedStorageId: "cs_A" });
  expect((await repo.reserveWorkflowRun(snap)).status).toBe("reserved");
  const again = await repo.reserveWorkflowRun({ ...snap, workflowRun: { ...snap.workflowRun, id: "run_2" } });
  expect(again.status).toBe("already_active");
});
```

> Put `makeSnapshot` in `repository-contract.ts` (shared) so both engine runs use identical fixtures. Reuse `validateWorkflowRunSnapshot`, `withDerivedEpisodeSummaries`, `workflowSnapshotFromReservation`, `isActiveWorkflowStatus`, `claimWorkflowRun` — they're exported from `repository.ts` and are engine-agnostic; the SQLite port should call the same helpers rather than re-derive logic.

- [ ] **Step 2: Run — FAIL on SQLite.**
- [ ] **Step 3: Implement** `saveWorkflowRunSnapshot` + `reserveWorkflowRun` in a `this.db.transaction(...)`. Port the multi-table writes from postgres.ts (`persistSnapshotWithin`, the `upsert` helper, `INSERT INTO episode_states ...`). Reuse `validateWorkflowRunSnapshot` (call it first, exactly like InMemory/Postgres). Key SQLite specifics: `db.transaction(fn)()` is synchronous; build one prepared statement per table and loop. `connected_storage_id` is NOT NULL in the schema → collapse null to the `UNSCOPED_STORAGE` sentinel (import it from `repository.ts`) exactly as the tree-model docs describe.
- [ ] **Step 4: Run — green on both.**
- [ ] **Step 5: Commit** `feat(workflow): SQLite snapshot persist + reserve (contract green)`

---

### Task 8: Claim / requeue / find / listActive / getSnapshot cluster

**Files:** Modify suite + `sqlite.ts`

- [ ] **Step 1: Suite** — `claimNextQueuedWorkflowRun({kind, now})` claims oldest queued → running (and returns null when none); `requeueRunningWorkflowRuns()` resets running→queued and returns the count; `findActiveWorkflowRun` finds queued/running for (season, kind, scope); `listActiveWorkflowRuns(scope)` returns queued+running newest-first; `getWorkflowRunSnapshot(id, scope)` is fail-closed (returns null for a mismatched scope). Assert the **claimable ordering** matches `claimableQueuedRuns` semantics (respect `nextAttemptAt` gating — a requeued run with a future `nextAttemptAt` is NOT claimed).

- [ ] **Step 2: Run — FAIL on SQLite.**
- [ ] **Step 3: Implement**, porting from postgres.ts. Use `claimWorkflowRun`/`claimableQueuedRuns` from `repository.ts`. For the claim, do it inside a transaction (SELECT candidate → UPDATE to running) so two ticks can't double-claim; SQLite's single-writer + WAL makes this safe.
- [ ] **Step 4: Run — green on both.**
- [ ] **Step 5: Commit** `feat(workflow): SQLite claim/requeue/find/listActive (contract green)`

---

### Task 9: Tracked-season & episode queries cluster

**Files:** Modify suite + `sqlite.ts`

- [ ] **Step 1: Suite** — `getTrackedSeasonState`, `listTrackedSeasonStates(scope)`, `listAllTrackedSeasonStates()` (cross-account), `listEpisodeStates(seasonId, scope)`. Assert: latest-by-season dedup + `compareTrackedSeasonStates` ordering; account-only scope (null storage) merges across the account's drives; concrete-drive scope reads only that drive's bucket (mirror InMemory lines ~909–936).
- [ ] **Step 2: Run — FAIL on SQLite.**
- [ ] **Step 3: Implement**, porting from postgres.ts. Reuse `seasonScopeKey`, `normalizeScope`, `scopeMatches`, `compareTrackedSeasonStates` from `repository.ts`/`workflow-scope.ts`.
- [ ] **Step 4: Run — green on both.**
- [ ] **Step 5: Commit** `feat(workflow): SQLite tracked-season + episode queries (contract green)`

---

### Task 10: agent_steps + progress cluster

**Files:** Modify suite + `sqlite.ts`

- [ ] **Step 1: Suite** — `appendAgentStep` then `listAgentSteps` returns ordered by `ordinal`; `listAgentSteps(id, scope)` is fail-closed; `clearAgentSteps` empties them; `updateWorkflowRunProgress` clamps `percent` monotonically (a lower percent never rewinds the bar — mirror InMemory lines ~691–704). Append with `ON CONFLICT (workflow_run_id, ordinal) DO NOTHING` (idempotent, matching postgres line ~474).
- [ ] **Step 2: Run — FAIL on SQLite.**
- [ ] **Step 3: Implement**, porting from postgres.ts.
- [ ] **Step 4: Run — green on both.**
- [ ] **Step 5: Commit** `feat(workflow): SQLite agent_steps + progress (contract green)`

---

### Task 11: notifications + lifecycle mutations + backfill (finish the interface)

**Files:** Modify suite + `sqlite.ts`

- [ ] **Step 1: Suite** — `listNotifications({scope, since, limit})` newest-first + `since` cutoff; `listRecentNotificationsWithAccount` tags each with its owning account; `cancelQueuedWorkflowRun` deletes a queued run + its scoped episode bucket (and returns `not_cancellable` once running); `untrackTitle(tmdbId, scope, mediaKind, seasonNumber?)` deletes the scope's seasons (in_flight guard when a target season has a running run; mediaKind movie/tv namespace correctness); `retryFailedWorkflowRun` (failed→queued, `not_retriable` otherwise); `backfillConnectedStorageId()` pins null-storage rows to the account's earliest drive and returns the count.
- [ ] **Step 2: Run — FAIL on SQLite.**
- [ ] **Step 3: Implement** the remaining methods, porting from postgres.ts. Reuse `retriedWorkflowRun`, `UNSCOPED_STORAGE`, `seasonScopeKey`.
- [ ] **Step 4: Run FULL suite — every contract slice green on both engines**

Run: `npx vitest run packages/workflow/tests/repository-contract-sqlite.test.ts packages/workflow/tests/repository-contract-inmemory.test.ts`
Expected: PASS, identical test count on both.

- [ ] **Step 5: Verify no method is still a throwing stub**

Run: `grep -n "not implemented" packages/workflow/src/sqlite.ts`
Expected: no matches. Then `npx tsc --project packages/workflow/tsconfig.json` → exit 0.

- [ ] **Step 6: Commit** `feat(workflow): SQLite notifications + lifecycle mutations + backfill — full WorkflowRepository contract green`

---

### Task 12: Full workflow test + PG contract opt-in

**Files:** Modify `packages/workflow/tests/repository-contract-sqlite.test.ts` (add a PG variant behind skipIf) — optional but recommended for the anti-divergence guarantee.

- [ ] **Step 1: Add a PG contract run gated on reachability** (mirror `postgres-schema-init.test.ts` lines 19–35). It runs the SAME `runRepositoryContract` against a fresh Postgres schema when `MEDIA_TRACK_POSTGRES_URL` (or the default localhost) is reachable, skips otherwise. This makes "PG and SQLite are semantically identical" machine-checked whenever a DB is present.

```typescript
// repository-contract-postgres.test.ts
import net from "node:net";
const PG_URL = process.env.MEDIA_TRACK_POSTGRES_URL ?? "postgresql://mediatrack:mediatrack@localhost:5432/postgres";
const reachable = await canConnect(PG_URL); // small tcp probe like postgres-schema-init.test.ts
(reachable ? runRepositoryContract : (() => {}))("Postgres", {
  make: async () => { /* fresh schema-per-run: unique schema or truncate; createPostgresWorkflowRepositorySync */ },
});
```

- [ ] **Step 2: Run the whole workflow package suite** — nothing regressed.

Run: `npm run test -- packages/workflow`
Expected: PASS (PG contract skipped if no DB; SQLite + InMemory green).

- [ ] **Step 3: Commit** `test(workflow): PG contract run (opt-in) — semantics locked across all three engines`

---

# Phase B — Wire the engine to SQLite + pure-date patrol gate

### Task 13: `getWorkflowRepository` SQLite branch + cache degrade

**Files:** Modify `apps/web/lib/workflow-runtime.ts`, `apps/web/lib/search-page.ts`, `apps/web/lib/title-hub.ts`
**Test:** `apps/web/lib/workflow-runtime.test.ts`

- [ ] **Step 1: Write a failing test for the factory branch**

```typescript
// in workflow-runtime.test.ts
it("selects the SQLite repository when MEDIA_TRACK_SQLITE_PATH is set", async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  vi.resetModules();
  const { getWorkflowRepository } = await import("./workflow-runtime");
  const repo = getWorkflowRepository();
  expect(repo.constructor.name).toBe("SqliteWorkflowRepository");
});
```

- [ ] **Step 2: Run — FAIL** (`MEDIA_TRACK_POSTGRES_URL is required`). Run: `npx vitest run apps/web/lib/workflow-runtime.test.ts -t "SQLite repository"` → FAIL.

- [ ] **Step 3: Implement the branch**

```typescript
// workflow-runtime.ts, near line 112
import { createSqliteWorkflowRepository } from "@media-track/workflow";

export function getWorkflowRepository(): WorkflowRepository {
  if (!repository) {
    const sqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH?.trim();
    repository = sqlitePath
      ? createSqliteWorkflowRepository({ path: sqlitePath })
      : createPostgresWorkflowRepositorySync({ connectionString: postgresConnectionString() });
  }
  return repository;
}
```

Export `createSqliteWorkflowRepository` + `SqliteWorkflowRepository` from `packages/workflow/src/index.ts` (add to the barrel).

- [ ] **Step 4: Degrade the durable search caches to in-memory under SQLite**

In `search-page.ts` (~line 42) and `title-hub.ts` (~line 95), when `MEDIA_TRACK_SQLITE_PATH` is set, use `new InMemoryMediaSearchCache()` instead of `new PostgresMediaSearchCache(...)`. Add a failing test asserting the desktop path doesn't call `postgresConnectionString()` (which throws without PG), then implement.

```typescript
const durableSearchCache = process.env.MEDIA_TRACK_SQLITE_PATH
  ? (inMemorySearchCache ??= new InMemoryMediaSearchCache())
  : (durablePgCache ??= new PostgresMediaSearchCache({ connectionString: postgresConnectionString() }));
```

> Rationale (from spec): the search cache is a throwaway accelerator; losing it on restart is fine, and this avoids a second SQLite schema. This is the approved "degrade" choice.

- [ ] **Step 5: Run — factory + cache tests green; typecheck apps/web**

Run: `npx vitest run apps/web/lib/workflow-runtime.test.ts && npx tsc -p apps/web/tsconfig.json`
Expected: PASS + exit 0. (tsc on apps/web is required — the root typecheck does NOT cover apps/web.)

- [ ] **Step 6: Commit** `feat(web): select SQLite repository + in-memory search cache when MEDIA_TRACK_SQLITE_PATH set`

---

### Task 14: `ignoreTimeGate` pure-date patrol gate

**Files:** Modify `apps/web/lib/workflow-runtime.ts`
**Test:** `apps/web/lib/workflow-runtime.test.ts`

- [ ] **Step 1: Failing test** — with `ignoreTimeGate: true`, the sweep runs even when the current Beijing time is before the configured sweep time, but STILL no-ops if it already swept today.

```typescript
it("ignoreTimeGate runs before the scheduled time but still respects once-per-day", async () => {
  // arrange a repo whose daily_sweep_time is far in the future vs "now",
  // and stub runScheduledType3Monitoring to a spy.
  const first = await runScheduledType3({ ignoreTimeGate: true });
  expect(first.skipped).toBeUndefined();            // ran despite before-time
  const second = await runScheduledType3({ ignoreTimeGate: true });
  expect(second.skipped).toBe("already_swept_today"); // day gate still holds
});
```

> Inspect the existing `workflow-runtime.test.ts` for how `runScheduledType3` is currently tested (what it stubs for `runScheduledType3Monitoring`, repository, cookie hydration) and follow that harness so the new test doesn't need a real drive/agent.

- [ ] **Step 2: Run — FAIL** (option not honored). Run: `npx vitest run apps/web/lib/workflow-runtime.test.ts -t "ignoreTimeGate"` → FAIL.

- [ ] **Step 3: Implement** — add the option and skip ONLY the wall-clock branch (keep the once-per-day claim):

```typescript
export async function runScheduledType3(options?: { force?: boolean; ignoreTimeGate?: boolean }): Promise<{ ... }> {
  const repository = getWorkflowRepository();
  let claimedDay = false;
  if (!options?.force) {
    const target = await getDailySweepTime(repository);
    const { date, hhmm } = beijingDateTime();
    const lastDate = (await repository.getSetting(LAST_SWEEP_DATE_SETTING_KEY))?.trim();
    if (date === lastDate) {
      return { skipped: "already_swept_today", outcomes: [] };
    }
    if (!options?.ignoreTimeGate && hhmm < target) {   // <-- only the time gate is bypassed
      return { skipped: "before_scheduled_time", scheduledFor: target, outcomes: [] };
    }
    await repository.setSetting(LAST_SWEEP_DATE_SETTING_KEY, date);
    claimedDay = true;
  }
  // ...unchanged...
}
```

- [ ] **Step 4: Thread the flag from the desktop worker path** — the desktop server sets `MEDIA_TRACK_PATROL_IGNORE_TIME_GATE=1`; `background-worker.ts`'s `defaultRuntime()` reads it and calls `runScheduledType3({ ignoreTimeGate: process.env.MEDIA_TRACK_PATROL_IGNORE_TIME_GATE === "1" })`. Add a test in `background-worker.test.ts` asserting the flag propagates, then implement (this keeps container behavior — flag unset — identical).

- [ ] **Step 5: Run — green + typecheck**

Run: `npx vitest run apps/web/lib/workflow-runtime.test.ts apps/web/lib/background-worker.test.ts && npx tsc -p apps/web/tsconfig.json`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit** `feat(web): ignoreTimeGate pure-date patrol gate for desktop (container behavior unchanged)`

---

# Phase C — Electron shell (`apps/desktop`)

### Task 15: Desktop package scaffold + workspace wiring

**Files:** Create `apps/desktop/package.json`, `apps/desktop/tsconfig.json`; Modify root `package.json` (workspaces).

- [ ] **Step 1: Create the package**

```jsonc
// apps/desktop/package.json
{
  "name": "@media-track/desktop",
  "private": true,
  "version": "0.0.0",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "electron .",
    "dist": "electron-builder --config electron-builder.yml"
  },
  "dependencies": { "better-sqlite3": "*" },
  "devDependencies": { "electron": "^33.0.0", "electron-builder": "^25.0.0", "@electron/rebuild": "^3.6.0" }
}
```

Add `"apps/desktop"` to root `package.json` `workspaces`. Run `npm install`.

- [ ] **Step 2: tsconfig** — extend the repo base, `outDir: dist`, `module: commonjs` (Electron main is CJS), `types: ["node", "electron"]`.

- [ ] **Step 3: Verify the workspace installs + typechecks empty**

Run: `npm install && npx tsc -p apps/desktop/tsconfig.json`
Expected: exit 0 (no source files yet is fine, or add an empty `src/main.ts`).

- [ ] **Step 4: Commit** `chore(desktop): scaffold apps/desktop Electron package`

---

### Task 16: `server-launch.ts` — pure, testable launch logic

**Files:** Create `apps/desktop/src/server-launch.ts`, `apps/desktop/tests/server-launch.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// server-launch.test.ts
import { pickFreePort, waitForHealthy, buildServerEnv } from "../src/server-launch.js";

it("pickFreePort returns a usable port", async () => {
  const port = await pickFreePort();
  expect(port).toBeGreaterThan(0);
});

it("buildServerEnv sets SQLite path, loopback host, port, and patrol gate", () => {
  const env = buildServerEnv({ port: 4123, sqlitePath: "/data/app.db", baseEnv: {} });
  expect(env.MEDIA_TRACK_SQLITE_PATH).toBe("/data/app.db");
  expect(env.PORT).toBe("4123");
  expect(env.HOSTNAME).toBe("127.0.0.1");
  expect(env.MEDIA_TRACK_PATROL_IGNORE_TIME_GATE).toBe("1");
  expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
});

it("waitForHealthy resolves when the probe returns ok and rejects on timeout", async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 20);
  await expect(waitForHealthy({ probe: async () => ready, timeoutMs: 500, intervalMs: 5 })).resolves.toBeUndefined();
  await expect(waitForHealthy({ probe: async () => false, timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(/timed out/);
});
```

- [ ] **Step 2: Run — FAIL** (module missing). Run: `npx vitest run apps/desktop/tests/server-launch.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```typescript
// server-launch.ts
import net from "node:net";

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export function buildServerEnv(input: { port: number; sqlitePath: string; baseEnv: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return {
    ...input.baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(input.port),
    MEDIA_TRACK_SQLITE_PATH: input.sqlitePath,
    MEDIA_TRACK_PATROL_IGNORE_TIME_GATE: "1",
  };
}

export async function waitForHealthy(input: { probe: () => Promise<boolean>; timeoutMs: number; intervalMs: number }): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    if (await input.probe().catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error("server health check timed out");
    await new Promise((r) => setTimeout(r, input.intervalMs));
  }
}

/** Default HTTP probe against the loopback server root. */
export function httpProbe(url: string): () => Promise<boolean> {
  return async () => {
    try { const res = await fetch(url); return res.status >= 200 && res.status < 500; }
    catch { return false; }
  };
}

/** Resolve the Next standalone entry: packaged → resources/app path; dev → repo build. */
export function resolveServerEntry(input: { isPackaged: boolean; resourcesPath: string; repoRoot: string }): string {
  return input.isPackaged
    ? `${input.resourcesPath}/app/apps/web/server.js`
    : `${input.repoRoot}/apps/web/.next/standalone/apps/web/server.js`;
}
```

- [ ] **Step 4: Run — green.** Run: `npx vitest run apps/desktop/tests/server-launch.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): pure server-launch logic (port pick, env, health wait, entry resolve)`

---

### Task 17: `lifecycle.ts` — pure Tray/close state machine

**Files:** Create `apps/desktop/src/lifecycle.ts`, `apps/desktop/tests/lifecycle.test.ts`

- [ ] **Step 1: Failing tests** — model the two decisions that matter:
  - closing the window hides it (server keeps running) UNLESS the app is quitting;
  - the tray menu reflects `openAtLogin` and server state.

```typescript
import { onWindowClose, trayMenuState } from "../src/lifecycle.js";

it("hides on close but allows real close when quitting", () => {
  expect(onWindowClose({ isQuitting: false })).toEqual({ preventDefault: true, hideWindow: true });
  expect(onWindowClose({ isQuitting: true })).toEqual({ preventDefault: false, hideWindow: false });
});

it("tray menu reflects login-item and server status", () => {
  const s = trayMenuState({ openAtLogin: true, serverReady: true });
  expect(s.items.find((i) => i.id === "openAtLogin")?.checked).toBe(true);
  expect(s.items.find((i) => i.id === "status")?.label).toMatch(/运行中|Running/);
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `onWindowClose` and `trayMenuState` as pure functions returning plain descriptors (no Electron imports — `main.ts` maps them onto real Menu/Tray). Items: 打开 Mediary Scout, status (disabled label), openAtLogin (checkbox), 退出.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit** `feat(desktop): pure lifecycle/tray state machine`

---

### Task 18: `main.ts` — Electron glue (single-instance, spawn, window, tray)

**Files:** Create `apps/desktop/src/main.ts`

> This file is thin Electron binding over the two tested pure modules; per the spec, Electron bindings are too thin to unit-test — it's verified by the packaged e2e (Task 20).

- [ ] **Step 1: Implement** (no test step — verified in Task 20):

```typescript
// main.ts (sketch — fill in against the pure helpers)
import { app, BrowserWindow, Tray, Menu, dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { pickFreePort, buildServerEnv, waitForHealthy, httpProbe, resolveServerEntry } from "./server-launch.js";
import { onWindowClose, trayMenuState } from "./lifecycle.js";

if (!app.requestSingleInstanceLock()) { app.quit(); }

let serverProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

app.on("second-instance", () => { win?.show(); win?.focus(); });

async function startServer(): Promise<string> {
  const port = await pickFreePort();
  const sqlitePath = path.join(app.getPath("userData"), "mediary.db");
  const entry = resolveServerEntry({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: path.resolve(__dirname, "../../..") });
  serverProc = spawn(process.execPath, [entry], {
    env: buildServerEnv({ port, sqlitePath, baseEnv: process.env }),
    stdio: "inherit",
  });
  const url = `http://127.0.0.1:${port}/`;
  await waitForHealthy({ probe: httpProbe(url), timeoutMs: 60_000, intervalMs: 250 });
  return url;
}

app.whenReady().then(async () => {
  let url: string;
  try { url = await startServer(); }
  catch (e) { dialog.showErrorBox("Mediary Scout", `服务未能启动：${(e as Error).message}`); app.quit(); return; }

  win = new BrowserWindow({ width: 1200, height: 800, title: "Mediary Scout" });
  win.on("close", (ev) => { const d = onWindowClose({ isQuitting }); if (d.preventDefault) ev.preventDefault(); if (d.hideWindow) win?.hide(); });
  await win.loadURL(url);

  tray = new Tray(/* template icon */);
  const rebuildTray = () => {
    const state = trayMenuState({ openAtLogin: app.getLoginItemSettings().openAtLogin, serverReady: true });
    tray!.setContextMenu(Menu.buildFromTemplate(state.items.map((i) => ({
      id: i.id, label: i.label, type: i.type, checked: i.checked, enabled: i.enabled,
      click: () => onTrayClick(i.id, rebuildTray),
    }))));
  };
  rebuildTray();
}).catch((e) => { dialog.showErrorBox("Mediary Scout", String(e)); app.quit(); });

function onTrayClick(id: string, rebuild: () => void) {
  if (id === "open") { win?.show(); win?.focus(); }
  if (id === "openAtLogin") { app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin }); rebuild(); }
  if (id === "quit") { isQuitting = true; app.quit(); }
}

app.on("before-quit", () => { isQuitting = true; });
app.on("will-quit", () => { serverProc?.kill("SIGTERM"); });
```

- [ ] **Step 2: Build the desktop package**

Run: `npx tsc -p apps/desktop/tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Commit** `feat(desktop): Electron main — single-instance, spawn server, window, tray, close-to-tray`

---

# Phase D — Packaging, signing, notarization

### Task 19: electron-builder config + native-module ABI rebuild + signed dmg

**Files:** Create `apps/desktop/electron-builder.yml`, `apps/desktop/build/entitlements.mac.plist`

> Native-module reality: `better-sqlite3` is loaded by the server child, which runs under the **Electron** binary (`ELECTRON_RUN_AS_NODE`). Its `.node` must be built for **Electron's** ABI, not system Node's. electron-builder's `npmRebuild: true` handles this at package time; for `npm start` dev runs, run `npx electron-rebuild -f -w better-sqlite3` once after install.

- [ ] **Step 1: Build the web standalone bundle to embed**

Run: `npm run build:web`
Expected: `apps/web/.next/standalone/apps/web/server.js` exists. Confirm: `test -f apps/web/.next/standalone/apps/web/server.js && echo OK`.

- [ ] **Step 2: electron-builder.yml** — package the Electron `dist/` + the Next standalone output + static + public into `resources/app/`, target `dmg`, `mac.hardenedRuntime: true`, `mac.notarize: true`, entitlements file, `npmRebuild: true`. `extraResources` maps `apps/web/.next/standalone` → `app/`, `apps/web/.next/static` → `app/apps/web/.next/static`, `apps/web/public` → `app/apps/web/public` (mirror the Dockerfile's COPY layout so `resolveServerEntry` finds `app/apps/web/server.js`).

- [ ] **Step 3: entitlements.mac.plist** — hardened-runtime entitlements for a spawned Node child: `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation` (the last is required so the Electron binary can load `better-sqlite3`'s unsigned-by-Apple native module).

- [ ] **Step 4: Sign + notarize env** (NOT committed) — document in `apps/desktop/README.md`: `CSC_LINK`/`CSC_KEY_PASSWORD` (or keychain identity) + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for notarization. These come from the user's Apple Developer account and live only in the local shell/keychain.

- [ ] **Step 5: Rebuild native module for Electron ABI, then package**

Run:
```bash
npx electron-rebuild -f -w better-sqlite3 --module-dir apps/desktop
npm run dist --workspace @media-track/desktop
```
Expected: a signed, notarized `.dmg` in `apps/desktop/dist/`. (Notarization requires the Apple env above; without it, build unsigned locally first to validate layout, then do the signed build.)

- [ ] **Step 6: Commit** `build(desktop): electron-builder dmg with hardened-runtime signing + notarization + native ABI rebuild`

---

# Phase E — Real-machine end-to-end verification (the only proof that counts)

### Task 20: Install-and-run e2e on macOS

> Per verification-before-completion: unit green ≠ product works. Do this on a real Mac, from the built `.app`, and record actual observations.

- [ ] **Step 1: Fresh launch** — install the `.dmg`, open the app (Gatekeeper must accept it silently → proves signing/notarization). Confirm: window loads the connect page (empty library, no error dialog), and `~/Library/Application Support/MediaryScout/mediary.db` was created (WAL files present).

- [ ] **Step 2: Real acquisition** — connect a 115 drive, search a title, click 获取, confirm the card flips to 获取中 and the workflow runs to completion (media library shows the new card). This exercises the SQLite repository end-to-end under the real agent/worker.

- [ ] **Step 3: Close-to-tray keeps the worker alive** — close the window; confirm the tray icon remains and the server process is still running (`pgrep -f apps/web/server.js`); trigger/observe a queued run completing while the window is closed. Only 退出 from the tray stops the process.

- [ ] **Step 4: Pure-date patrol gate** — with `daily_sweep_time` set LATER than the current wall-clock, quit and relaunch: the sweep should run on the first tick (because `ignoreTimeGate` is on for desktop). Relaunch again the same day: it must NOT re-run (once-per-day day gate holds — check `last_sweep_date` in the db / logs).

- [ ] **Step 5: Open-at-login** — toggle the tray "开机自启" and confirm `app.getLoginItemSettings().openAtLogin` flips and the Login Items entry appears in System Settings.

- [ ] **Step 6: Record results** — write the observed outcomes (with the actual db path, pgrep output, and log lines) into `docs/PROJECT-STATUS.md` and update the desktop spec's status. Do NOT claim done without these observations.

- [ ] **Step 7: Commit** `docs(desktop): record real-machine e2e verification results`

---

## Self-Review (run against the spec before handing off)

**1. Spec coverage**
- 防代码分裂/数据层唯一缝 → Tasks 1–12 (contract suite locks PG≡SQLite). ✅
- Electron 壳(spawn server / window / tray / 单实例 / 关窗保活)→ Tasks 16–18. ✅
- 数据层 SqliteWorkflowRepository + 工厂 → Tasks 2–13. ✅
- ignoreTimeGate 纯日期门 → Task 14. ✅
- tmdb-cache 降级 → Task 13 Step 4 (in-memory, the spec's approved二选一). ✅
- 打包/签名/公证 dmg + native ABI → Task 19. ✅
- 生命周期/首次打开触发/续跑 → reuses existing worker (Tasks 14, 18) + verified in Task 20 Steps 3–4. ✅
- 真机 e2e → Task 20. ✅
- v1 out-of-scope (Windows/Telegram/auto-update/container-SQLite/PG→SQLite migration) → not planned, correctly. ✅

**2. Placeholder scan** — no "TBD/TODO"; the repository-port tasks give complete schema + mapping rules + a fully-worked representative method + complete contract tests per cluster (the tests, not prose, are the completeness guarantee for a mechanical translation). Each task has concrete run commands + expected results.

**3. Type consistency** — factory returns `WorkflowRepository`; `createSqliteWorkflowRepository`/`SqliteWorkflowRepository`/`SQLITE_SCHEMA` names are used identically in Tasks 2, 3, 13; `MEDIA_TRACK_SQLITE_PATH` and `MEDIA_TRACK_PATROL_IGNORE_TIME_GATE` env names are consistent across Tasks 13, 14, 16; `runScheduledType3({ ignoreTimeGate })` signature matches between Task 14 and the worker call.
