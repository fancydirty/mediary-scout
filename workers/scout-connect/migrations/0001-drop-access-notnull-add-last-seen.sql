-- Migration 0001 — drop the cf_access_app_id NOT NULL, add last_seen_at, add
-- the two hot-path indexes.
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the Worker version that removes Cloudflare
-- Access. It is not optional and it is not backwards-compatible in the other
-- direction:
--   * provision.ts writes `cf_access_app_id = NULL`, which the pre-migration
--     table rejects with `NOT NULL constraint failed: endpoints.cf_access_app_id`.
--     The provision handler creates the tunnel + ingress + DNS first, so the
--     failed INSERT rolls those back and returns 500 — every provision fails
--     until the table is rebuilt.
--   * POST /api/instance/status reads and writes `last_seen_at`, a column that
--     does not exist on an already-deployed instance.
--
-- How to run:
--   cd workers/scout-connect
--   npx wrangler d1 execute scout-connect --local \
--     --file=./migrations/0001-drop-access-notnull-add-last-seen.sql
--   npx wrangler d1 execute scout-connect --remote \
--     --file=./migrations/0001-drop-access-notnull-add-last-seen.sql
--   # then, and only then:
--   npx wrangler deploy
--
-- (If CF_API_TOKEN is exported in your shell, prefix with `env -u CF_API_TOKEN`
-- — see README. There is no `migrations_dir` / `d1 migrations apply` wiring for
-- this Worker; the file is applied explicitly with `d1 execute --file`.)
--
-- On transactions: this file deliberately has NO explicit transaction
-- statements. D1 rejects them outright — verified against wrangler 4.114.0,
-- which fails the whole file with "To execute a transaction, please use the
-- state.storage.transaction() ... instead of the SQL BEGIN/SAVEPOINT
-- statements." `wrangler d1 execute --file` already applies the statements as
-- one atomic unit: a mid-file failure leaves the database untouched (also
-- verified — a deliberately broken third statement rolled back the two
-- CREATE TABLEs preceding it).
--
-- Do NOT write the two words BEGIN and TRANSACTION adjacently anywhere in this
-- file, including inside a comment: wrangler's SQL splitter string-matches for
-- them and refuses the file with "contains several transactions" before any SQL
-- is parsed. schema.test.ts pins this.
--
-- On re-running: SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so
-- this migration is abort-safe rather than idempotent. Step 1 fails with
-- "duplicate column name: last_seen_at" on a second application, and because
-- the file is atomic the rebuild in steps 2-6 never starts. Re-running is safe
-- (it changes nothing); it is simply not silent.

-- 1. Additive: the column POST /api/instance/status needs. Also the re-run
--    guard described above — keep it first.
ALTER TABLE endpoints ADD COLUMN last_seen_at TEXT;

-- 2-6. SQLite cannot drop a NOT NULL in place, so rebuild the table.
--      https://sqlite.org/lang_altertable.html#otheralter

-- 2. Move the existing table aside. Its indexes follow it and are destroyed
--    with it in step 5, so step 6 recreates them.
ALTER TABLE endpoints RENAME TO endpoints_old;

-- 3. The target shape — identical to schema.sql except cf_access_app_id is
--    nullable.
CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL UNIQUE,
  cf_tunnel_id TEXT NOT NULL,
  cf_access_app_id TEXT,
  cf_access_policy_id TEXT,
  cf_dns_record_id TEXT NOT NULL,
  status TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  token_ciphertext TEXT,
  token_shown_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- 4. Columns named explicitly on BOTH sides. `SELECT *` would bind by position
--    and silently shuffle values into the wrong columns if the source table
--    ever drifted.
INSERT INTO endpoints (
  id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id,
  cf_access_policy_id, cf_dns_record_id, status, token_sha256,
  token_ciphertext, token_shown_at, last_seen_at, created_at, revoked_at
)
SELECT
  id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id,
  cf_access_policy_id, cf_dns_record_id, status, token_sha256,
  token_ciphertext, token_shown_at, last_seen_at, created_at, revoked_at
FROM endpoints_old;

-- 5. Drop the scratch table.
DROP TABLE endpoints_old;

-- 6. Recreate the index lost with the old table.
CREATE INDEX IF NOT EXISTS idx_endpoints_status ON endpoints(status);

-- 7. New index (HIGH-4). Without it every /api/instance/status heartbeat AND
--    every failed probe is a full scan of endpoints.
CREATE INDEX IF NOT EXISTS idx_endpoints_token_sha256 ON endpoints(token_sha256);

-- 8. MEDIUM-7: the waitlist default was 'waiting' while routes.ts inserts
--    'pending', so the column could hold two different words for one state
--    depending on whether the row came from the app or from the default.
--    Nothing filters on status today (the waitlist queries key off batch and
--    created_at only), so this is a coherence fix, not a
--    rows-are-being-missed fix. Converge on 'pending'. Changing a DEFAULT also
--    needs a rebuild, and the same explicit-column rule applies.
--
--    First, guarantee the rename below has something to rename. An instance
--    provisioned from a schema.sql that predates the waitlist table has no
--    such table, and a bare `ALTER TABLE waitlist RENAME` there fails with
--    "no such table: waitlist". Because this file is applied as ONE atomic
--    unit, that failure would also roll back the endpoints rebuild in steps
--    1-7 — the critical part — leaving such an instance unmigratable.
--    SQLite has no `ALTER TABLE ... IF EXISTS`, so the portable guard is to
--    conditionally materialise the OLD shape (note: status default 'waiting')
--    and let the normal rename/copy/drop path run over an empty table. On an
--    instance that DOES have the table this is a no-op and the real data is
--    preserved untouched.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL
);

ALTER TABLE waitlist RENAME TO waitlist_old;

CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

INSERT INTO waitlist (id, email, batch, status, created_at)
SELECT id, email, batch,
       -- Realign rows that were written with the orphaned literal.
       CASE WHEN status = 'waiting' THEN 'pending' ELSE status END,
       created_at
FROM waitlist_old;

DROP TABLE waitlist_old;

CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email_batch ON waitlist(email, batch);
CREATE INDEX IF NOT EXISTS idx_waitlist_batch_created ON waitlist(batch, created_at);
