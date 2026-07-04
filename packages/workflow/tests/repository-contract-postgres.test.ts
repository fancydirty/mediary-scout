import { afterAll, describe, it } from "vitest";
import pg from "pg";
import { createPostgresWorkflowRepositorySync } from "../src/postgres.js";
import { runRepositoryContract } from "./repository-contract.js";
import type { WorkflowRepository } from "../src/repository.js";

/**
 * The anti-divergence ARBITER: run the SAME shared contract against a REAL
 * Postgres, proving SQLite ≡ Postgres for every behavior the contract asserts
 * (Postgres is production truth). Skips cleanly when no Postgres is reachable so
 * DB-less CI stays green; run locally against the dev Postgres to verify parity.
 */
const ADMIN_URL =
  process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL ??
  process.env.MEDIA_TRACK_POSTGRES_URL ??
  "postgresql://mediatrack:mediatrack@localhost:5432/postgres";

// Every table the workflow schema owns — TRUNCATE between make()s for a fresh repo.
const TABLES = [
  "media_titles",
  "tracked_seasons",
  "workflow_runs",
  "episode_states",
  "resource_snapshots",
  "agent_decisions",
  "agent_steps",
  "transfer_attempts",
  "notifications",
  "app_settings",
  "dead_links",
  "accounts",
  "sessions",
  "connected_storages",
  "account_settings",
];

async function postgresReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const reachable = await postgresReachable();

if (!reachable) {
  describe.skip("WorkflowRepository contract: Postgres (no DB reachable)", () => {
    it("skipped — set MEDIA_TRACK_POSTGRES_URL to a reachable Postgres to run", () => {});
  });
} else {
  // A dedicated throwaway database so the contract never touches dev data.
  const dbName = `wf_contract_${Date.now()}`.toLowerCase();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const dbUrl = (() => {
    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    return u.toString();
  })();

  const repository = createPostgresWorkflowRepositorySync({ connectionString: dbUrl });
  // A private pool for the TRUNCATE reset (the repository owns its own pool).
  const resetPool = new pg.Pool({ connectionString: dbUrl });

  async function truncateAll(): Promise<void> {
    await resetPool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    // Re-seed acct_default exactly like the schema DDL does (mirrors SQLite, which
    // also seeds it), so all engines start each test from identical state.
    await resetPool.query(
      "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) " +
        "VALUES ('acct_default', 'default', '', true, '1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING",
    );
  }

  afterAll(async () => {
    await resetPool.end();
    // The repository pool must close before the DB can be dropped.
    await (repository as unknown as { pool: pg.Pool }).pool.end();
    const dropAdmin = new pg.Client({ connectionString: ADMIN_URL });
    await dropAdmin.connect();
    await dropAdmin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await dropAdmin.end();
  });

  runRepositoryContract("Postgres", {
    make: async (): Promise<WorkflowRepository> => {
      // First call also lazily creates the schema (repository.ensureSchema on first query).
      // A no-op query forces schema init before the truncate.
      await repository.getSetting("__schema_init__");
      await truncateAll();
      return repository;
    },
  });
}
