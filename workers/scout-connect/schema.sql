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

-- code is already covered by the UNIQUE constraint above (SQLite auto-indexes it).
-- status index supports admin filtering by endpoint state (revoke_failed sweep).
CREATE INDEX idx_endpoints_status ON endpoints(status);
