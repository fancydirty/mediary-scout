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

-- Waitlist for Scout Connect beta (阶段 1).
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_waitlist_email_batch ON waitlist(email, batch);

-- Migration note: cf_access_app_id 改为可空（去 Access 后新数据写 NULL）。
-- SQLite 不支持 ALTER COLUMN，实际迁移需要：
--   1. ALTER TABLE endpoints RENAME TO endpoints_old;
--   2. CREATE TABLE endpoints (..., cf_access_app_id TEXT, ...);  -- 去掉 NOT NULL
--   3. INSERT INTO endpoints SELECT * FROM endpoints_old;
--   4. DROP TABLE endpoints_old;
-- 部署时由运维脚本执行；schema.sql 此处仅文档化意图。
