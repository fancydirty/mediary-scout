import "server-only";
import pg from "pg";
import type { Pool } from "pg";
import {
  WORKFLOW_SCHEMA_ADVISORY_LOCK_KEY,
  type MediaSearchCache,
  type MediaSearchCandidate,
} from "@media-track/workflow";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h: TMDB search results barely change
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // reclaim dead rows at most every 10 min

/**
 * Durable TMDB search cache (tier 2 of the read path: tracked state -> this
 * cache -> live TMDB only on a miss). Survives restarts so casual searching
 * never becomes a TMDB API storm.
 *
 * A cache is just a fast store of expensive results, defined by three choices:
 *
 *  1. KEY — what identifies a request. Here: the normalized search query.
 *  2. FRESHNESS (TTL) — how long a stored result counts as still-good. Past its
 *     `expires_at` the row is STALE and must be re-fetched from TMDB. 6h here.
 *  3. EVICTION — how stale rows are removed. Two complementary mechanisms:
 *     - LAZY (on read): when we look up a key and it's expired, treat it as a
 *       miss and delete it. Cheap — only touches keys we actually read.
 *     - ACTIVE SWEEP (background): a row nobody ever reads again would linger
 *       forever, so a periodic `DELETE WHERE expired` reclaims it. Run on a time
 *       guard (at most once per interval), NOT on every write.
 *
 * No size cap / LRU is needed: the TTL plus the bounded set of distinct queries
 * keep the table naturally small (≈ "queries seen in the last 6h").
 */
export class PostgresMediaSearchCache implements MediaSearchCache {
  private readonly pool: Pool;
  private readonly ttlMs: number;
  private schemaReady: Promise<void> | undefined;
  private lastSweepAt = 0;

  constructor(options: { connectionString: string; ttlMs?: number }) {
    this.pool = new pg.Pool({ connectionString: options.connectionString });
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async get(query: string): Promise<MediaSearchCandidate[] | null> {
    await this.ensureSchema();
    const key = normalizeKey(query);
    const result = await this.pool.query<{ payload: MediaSearchCandidate[]; expires_at: Date }>(
      "SELECT payload, expires_at FROM tmdb_search_cache WHERE cache_key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) {
      return null; // cold miss
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      // Stale — evict lazily on read, then report a miss so the caller re-fetches.
      await this.pool.query("DELETE FROM tmdb_search_cache WHERE cache_key = $1 AND expires_at <= now()", [key]);
      return null;
    }
    return row.payload;
  }

  async set(query: string, candidates: MediaSearchCandidate[]): Promise<void> {
    await this.setJson(normalizeKey(query), candidates);
  }

  /**
   * Generic durable JSON cache over the same table — used by the title page to
   * persist a TMDB series target (season list + artwork) across restarts, so the
   * detail page renders from Postgres instead of paying a live TMDB round-trip on
   * every cold (per-process) load. Key is namespaced by the caller (e.g.
   * "series-target:1396") and stored verbatim (not query-normalized).
   */
  async getJson<T>(key: string): Promise<T | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ payload: T; expires_at: Date }>(
      "SELECT payload, expires_at FROM tmdb_search_cache WHERE cache_key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.pool.query("DELETE FROM tmdb_search_cache WHERE cache_key = $1 AND expires_at <= now()", [key]);
      return null;
    }
    return row.payload;
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    await this.ensureSchema();
    const expiresAt = new Date(Date.now() + (ttlMs ?? this.ttlMs));
    await this.pool.query(
      `INSERT INTO tmdb_search_cache (cache_key, payload, expires_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), expiresAt],
    );
    await this.sweepExpiredOccasionally();
  }

  private ensureSchema(): Promise<void> {
    return (this.schemaReady ??= this.createSchema());
  }

  // Same first-boot hazard as the workflow schema: concurrent `CREATE TABLE/INDEX
  // IF NOT EXISTS` against an empty DB races on the system catalogs (deadlock /
  // pg_type unique-violation). Serialize through the SAME advisory lock the
  // workflow schema uses, so every DDL path on this database is mutually ordered.
  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [WORKFLOW_SCHEMA_ADVISORY_LOCK_KEY]);
      await client.query(
        `CREATE TABLE IF NOT EXISTS tmdb_search_cache (
           cache_key text PRIMARY KEY,
           payload jsonb NOT NULL,
           expires_at timestamptz NOT NULL
         );
         CREATE INDEX IF NOT EXISTS tmdb_search_cache_expires_at_idx ON tmdb_search_cache (expires_at);`,
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Surface the original DDL error, not a secondary rollback failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Active eviction: drop rows no reader will ever expire lazily. Time-guarded
  // so it costs one bounded DELETE per interval, not one per write.
  private async sweepExpiredOccasionally(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepAt = now;
    await this.pool.query("DELETE FROM tmdb_search_cache WHERE expires_at < now()");
  }
}

function normalizeKey(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * The subset of the durable cache the title page's L2 depends on: a namespaced
 * JSON store with a per-entry TTL. `PostgresMediaSearchCache` implements it over
 * Postgres; the desktop (SQLite) build backs it with the in-memory variant below.
 */
export interface DurableJsonCache {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

/**
 * In-memory `DurableJsonCache` for the desktop (SQLite) build, which has no
 * Postgres to back the durable L2 cache. It is NOT durable — the store resets on
 * every process restart — which is fine: a cold load then pays one live TMDB
 * round-trip (the same trade-off the L1 map already makes), and we avoid adding a
 * second SQLite schema just for a best-effort cache. Expired entries are evicted
 * lazily on read.
 */
export class InMemoryJsonCache implements DurableJsonCache {
  private readonly ttlMs: number;
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.values.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.ttlMs) });
  }
}
