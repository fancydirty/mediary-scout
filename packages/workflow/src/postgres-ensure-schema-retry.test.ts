import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PostgresWorkflowRepository } from "./postgres.js";

/**
 * Regression for the 2026-07-21 incident: on a host reboot the web container
 * won the restart race against a still-recovering postgres, so the very first
 * schema-init at startup rejected with ECONNREFUSED. `ensureSchema` memoized
 * that rejected promise (`this.schemaReady ??= init(...)`) and every subsequent
 * repository call replayed the cached rejection forever — the process never
 * retried even after postgres came up seconds later, so the queue sat stuck for
 * 47 hours until a manual restart.
 *
 * The repository must SELF-HEAL: a failed schema init must not latch. The next
 * call has to re-attempt initialization so the app recovers on its own once the
 * database is reachable.
 */
describe("PostgresWorkflowRepository schema-init self-healing", () => {
  it("re-attempts schema init after a failed one instead of latching the rejection", async () => {
    let connectAttempts = 0;
    const fakeClient = {
      query: async () => ({ rows: [] }),
      release: () => {},
    } as unknown as PoolClient;

    const pool = {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          // Postgres still coming up — refuse the first connection.
          const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
          (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
          throw err;
        }
        return fakeClient;
      },
      query: async () => ({ rows: [] }),
    } as unknown as Pool;

    const repository = new PostgresWorkflowRepository(pool);

    // First query: schema init fails because postgres is not ready yet.
    await expect(repository.getSetting("boot")).rejects.toThrow(/ECONNREFUSED/);

    // Postgres is up now. The next query MUST re-run schema init and succeed,
    // not replay the cached rejection.
    await expect(repository.getSetting("boot")).resolves.toBeNull();
    expect(connectAttempts).toBe(2);
  });

  it("caches the rejection for an unambiguously-permanent error (bad password) instead of hammering", async () => {
    let connectAttempts = 0;
    const pool = {
      connect: async () => {
        connectAttempts += 1;
        // Wrong credentials in MEDIA_TRACK_POSTGRES_URL — retrying will never
        // succeed, so we must NOT re-attempt on every poll. Fail fast.
        const err = new Error('password authentication failed for user "mediatrack"');
        (err as NodeJS.ErrnoException).code = "28P01";
        throw err;
      },
      query: async () => ({ rows: [] }),
    } as unknown as Pool;

    const repository = new PostgresWorkflowRepository(pool);

    await expect(repository.getSetting("boot")).rejects.toThrow(/password/);
    // A permanent config error must stay cached — the second call must NOT open
    // another connection (no forever-hammering the DB with a doomed auth).
    await expect(repository.getSetting("boot")).rejects.toThrow(/password/);
    expect(connectAttempts).toBe(1);
  });

  it("retries on an unrecognized error code (default self-heal — never latch on unknown)", async () => {
    let connectAttempts = 0;
    const fakeClient = {
      query: async () => ({ rows: [] }),
      release: () => {},
    } as unknown as PoolClient;
    const pool = {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          const err = new Error("some unrecognized transient blip");
          (err as NodeJS.ErrnoException).code = "99999"; // not a known-permanent code
          throw err;
        }
        return fakeClient;
      },
      query: async () => ({ rows: [] }),
    } as unknown as Pool;

    const repository = new PostgresWorkflowRepository(pool);

    await expect(repository.getSetting("boot")).rejects.toThrow(/unrecognized/);
    // Unknown → treated as transient → retried, so it self-heals on the next call.
    await expect(repository.getSetting("boot")).resolves.toBeNull();
    expect(connectAttempts).toBe(2);
  });
});
