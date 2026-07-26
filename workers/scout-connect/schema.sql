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
  -- Nullable since Access was removed: provision.ts writes NULL here. Existing
  -- installs get this via migrations/0001-drop-access-notnull-add-last-seen.sql.
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

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  invite_id TEXT,
  endpoint_id TEXT,
  detail_json TEXT
);

-- code is already covered by the UNIQUE constraint above (SQLite auto-indexes it).
-- status index supports admin filtering by endpoint state (revoke_failed sweep).
CREATE INDEX idx_endpoints_status ON endpoints(status);
-- Every /api/instance/status heartbeat (and every failed probe) looks up an
-- endpoint by token hash; without this it is a full table scan.
CREATE INDEX idx_endpoints_token_sha256 ON endpoints(token_sha256);

-- Waitlist for Scout Connect beta (阶段 1).
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 1,
  -- Must stay in sync with the literal routes.ts INSERTs. Nothing filters on
  -- this column today (the waitlist queries key off batch/created_at only);
  -- the default and the written literal must still agree so the column does
  -- not end up holding two words for one state. Note that the position math
  -- counts every row in a batch regardless of status — if you add a second
  -- status value, see the TRIPWIRE tests in src/schema.test.ts.
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  -- Optional post-signup survey answers (a JSON object holding only the keys
  -- the user actually filled), written by POST /waitlist/survey. NULL until
  -- the user answers; rows queued before migrations/0002-waitlist-survey.sql
  -- START as NULL after the ALTER but can be updated by a later survey submit.
  -- Appended last to mirror the ALTER.
  survey_json TEXT
);
CREATE UNIQUE INDEX idx_waitlist_email_batch ON waitlist(email, batch);
-- Backs the per-batch count on the POST /waitlist path (was a full scan).
-- `id` is the third column so that `ORDER BY created_at, id` — the composite
-- queue order listWaitlist and waitlistRankOf share — is read straight off the
-- index. On (batch, created_at) alone SQLite added a
-- "USE TEMP B-TREE FOR LAST TERM OF ORDER BY" to break the same-second ties.
CREATE INDEX idx_waitlist_batch_created ON waitlist(batch, created_at, id);

-- Schema changes need a matching file in ./migrations for already-deployed
-- instances — schema.sql alone only covers fresh installs. See README → Deploy.
