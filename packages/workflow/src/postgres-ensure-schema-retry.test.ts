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
});
