import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

const mocks = vi.hoisted(() => ({ pool: null as Pool | null }));

// @ts-expect-error Vitest's runtime supports virtual mocks, but its v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

vi.mock("pg", () => {
  function Pool() {
    return mocks.pool;
  }
  return { default: { Pool } };
});

import { PostgresMediaSearchCache } from "./tmdb-cache";

describe("PostgresMediaSearchCache schema-init recovery", () => {
  beforeEach(() => {
    mocks.pool = null;
  });

  it("retries schema initialization after a transient connection failure", async () => {
    let connectAttempts = 0;
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient;
    mocks.pool = {
      connect: vi.fn(async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          const error = new Error("connect ECONNREFUSED 127.0.0.1:5432");
          (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
          throw error;
        }
        return client;
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const cache = new PostgresMediaSearchCache({ connectionString: "postgres://unused" });

    await expect(cache.get("boot")).rejects.toThrow(/ECONNREFUSED/);
    await expect(cache.get("boot")).resolves.toBeNull();

    expect(connectAttempts).toBe(2);
  });

  it("caches permanent schema initialization failures", async () => {
    let connectAttempts = 0;
    mocks.pool = {
      connect: vi.fn(async () => {
        connectAttempts += 1;
        const error = new Error('password authentication failed for user "mediatrack"');
        (error as NodeJS.ErrnoException).code = "28P01";
        throw error;
      }),
    } as unknown as Pool;
    const cache = new PostgresMediaSearchCache({ connectionString: "postgres://unused" });

    await expect(cache.get("boot")).rejects.toThrow(/password/);
    await expect(cache.get("boot")).rejects.toThrow(/password/);

    expect(connectAttempts).toBe(1);
  });
});
