CREATE TABLE IF NOT EXISTS instance_link_requests (
  id TEXT PRIMARY KEY,                       -- "ilr_" + 16 random hex chars (8 bytes)
  poll_secret_sha256 TEXT NOT NULL UNIQUE,   -- sha256 hex of the poll secret
  email TEXT NOT NULL,                       -- normalized (trim + lowercase), same rules as magic link
  verify_code TEXT NOT NULL,                 -- 4 chars from "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  status TEXT NOT NULL CHECK (status IN ('pending','approved','delivered')),
  account_id TEXT,                           -- set on approval
  request_ip TEXT,                           -- CF-Connecting-IP of the instance's start call (display only)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                  -- created_at + 30 min
  approved_at TEXT,
  delivered_at TEXT,
  last_polled_at TEXT
);
-- The daily retention job deletes by expiry, oldest first.
CREATE INDEX IF NOT EXISTS idx_instance_link_requests_expires
  ON instance_link_requests(expires_at, id);

CREATE TABLE IF NOT EXISTS instance_credentials (
  id TEXT PRIMARY KEY,                       -- "icr_" + 16 random hex chars (8 bytes)
  account_id TEXT NOT NULL,
  credential_sha256 TEXT NOT NULL UNIQUE,
  link_request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_instance_credentials_account ON instance_credentials(account_id);
