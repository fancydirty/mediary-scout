-- Migration 0004 — 自助开通:invite_id 放开 NOT NULL + 一账号一 live endpoint 索引
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the Worker version with POST /api/provision.
-- 自助开通的行没有 invite(invite_id = NULL),pre-migration 表的 NOT NULL
-- 会让 INSERT 失败——而 provision 是先建 CF 隧道/DNS 再落库,失败即触发全套
-- CF 资源补偿回滚,所以每次自助开通都会 500 直到本迁移应用。
--
-- How to run:
--   cd workers/scout-connect
--   npx wrangler d1 execute scout-connect --local \
--     --file=./migrations/0004-self-serve-provision.sql
--   npx wrangler d1 execute scout-connect --remote \
--     --file=./migrations/0004-self-serve-provision.sql
--   # then, and only then:
--   npx wrangler deploy
--
-- (If CF_API_TOKEN is exported in your shell, prefix with `env -u CF_API_TOKEN`.)
--
-- On transactions: NO explicit transaction statements — D1 rejects them, and
-- `wrangler d1 execute --file` already applies the file as one atomic unit
-- (see 0001's header for the verification notes). Do NOT write the two words
-- BEGIN and TRANSACTION adjacently anywhere in this file, including comments.
--
-- On re-running: unlike 0001 (whose ADD COLUMN aborts a second run), this file
-- is a pure rename→rebuild→copy→drop cycle, so re-running it is a safe no-op
-- rebuild: the table's indexes follow it through the RENAME and die with the
-- DROP, and steps 4-5 recreate them fresh. Verified against --local.

-- 1. Move the existing table aside (its indexes are destroyed with it in
--    step 3's DROP; steps 5-6 recreate them).
ALTER TABLE endpoints RENAME TO endpoints_old;

-- 2. Target shape — identical to the post-0003 table except invite_id is
--    nullable. SQLite UNIQUE ignores NULLs, so many self-serve rows (all with
--    invite_id NULL) coexist while invite rows keep their one-endpoint-per-
--    invite guarantee.
CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  invite_id TEXT UNIQUE,
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
  revoked_at TEXT,
  account_id TEXT REFERENCES accounts(id),
  grace_until TEXT,
  suspended_at TEXT,
  purge_after TEXT
);

-- 3. Columns named explicitly on BOTH sides (a `SELECT *` binds by position
--    and silently shuffles values if the source drifted — 0001's rule).
INSERT INTO endpoints (
  id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id,
  cf_access_policy_id, cf_dns_record_id, status, token_sha256,
  token_ciphertext, token_shown_at, last_seen_at, created_at, revoked_at,
  account_id, grace_until, suspended_at, purge_after
)
SELECT
  id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id,
  cf_access_policy_id, cf_dns_record_id, status, token_sha256,
  token_ciphertext, token_shown_at, last_seen_at, created_at, revoked_at,
  account_id, grace_until, suspended_at, purge_after
FROM endpoints_old;

DROP TABLE endpoints_old;

-- 4. 一账号最多一个 live endpoint(live = status 'active';grace/suspended 是
--    时间戳态,status 仍 'active',所以它们天然被算作占用——suspended 用户续费
--    恢复原 endpoint,不能另开新行)。这是「一账号一实例」的数据库级执行:
--    没有它,同账号并发双击「开通」会各建一条 CF 隧道,烧 1000 隧道硬配额。
CREATE UNIQUE INDEX idx_endpoints_account_live ON endpoints(account_id)
  WHERE account_id IS NOT NULL AND status = 'active';

-- 5. Recreate the indexes lost with the old table (definitions from
--    schema.sql / 0001 / 0003).
CREATE INDEX IF NOT EXISTS idx_endpoints_status ON endpoints(status);
CREATE INDEX IF NOT EXISTS idx_endpoints_token_sha256 ON endpoints(token_sha256);
CREATE INDEX IF NOT EXISTS idx_endpoints_account ON endpoints(account_id);
