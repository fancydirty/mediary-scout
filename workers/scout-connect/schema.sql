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
  -- Nullable since self-serve provisioning (migrations/0004): a paid account's
  -- endpoint has no invite. UNIQUE still holds for invite rows (SQLite UNIQUE
  -- ignores NULLs, so self-serve rows coexist freely).
  invite_id TEXT UNIQUE,
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
  revoked_at TEXT,
  -- P3: 关联付费账号(自助开通);内测期邀请制的行为 NULL。migrations/0003.
  account_id TEXT REFERENCES accounts(id),
  -- P3: 到期处置三阶段时间戳(决策 #14)。migrations/0003.
  grace_until TEXT,
  suspended_at TEXT,
  purge_after TEXT
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
-- 一账号最多一个 live endpoint(live = status 'active';grace/suspended 是时间戳
-- 态,status 仍 'active' 所以天然算占用)。挡「同账号并发双开」烧 CF 隧道配额。
-- migrations/0004.
CREATE UNIQUE INDEX idx_endpoints_account_live ON endpoints(account_id)
  WHERE account_id IS NOT NULL AND status = 'active';

-- Waitlist for Mediary Connect beta (阶段 1).
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

-- P3: 付费账号 + 预付时长账本。migrations/0003-accounts-entitlements.sql。
-- endpoints.account_id 外键引用 accounts,故这两表逻辑上先于 endpoints,
-- 但 SQLite 建表时不强制外键目标已存在,放文件末尾亦可。
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  paddle_customer_id TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
-- accounts.email 已由 UNIQUE 约束自动建索引,不再重复建。
CREATE INDEX idx_accounts_paddle_customer ON accounts(paddle_customer_id);

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL,
  source TEXT NOT NULL,
  paddle_transaction_id TEXT,
  months INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- Provider-neutral payment identity. Historical Paddle rows are backfilled
  -- by migration 0006; paddle_transaction_id remains read-only history.
  payment_provider TEXT,
  payment_transaction_id TEXT,
  -- Full refund tombstone: rows stay in the audit ledger but no longer grant time.
  refunded_at TEXT
);
CREATE INDEX idx_entitlements_account ON entitlements(account_id);
CREATE UNIQUE INDEX idx_ent_txn ON entitlements(paddle_transaction_id)
  WHERE paddle_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ent_payment ON entitlements(payment_provider, payment_transaction_id)
  WHERE payment_provider IS NOT NULL AND payment_transaction_id IS NOT NULL;
CREATE INDEX idx_endpoints_account ON endpoints(account_id);

-- Durable checkout and payment state. Browser-visible ids are high entropy;
-- only the server-owned tier determines months and total_amount.
CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,
  checkout_token_sha256 TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK(provider = 'alipay'),
  out_trade_no TEXT NOT NULL UNIQUE,
  trade_no TEXT UNIQUE,
  months INTEGER NOT NULL CHECK(months IN (3, 12, 24)),
  total_amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'created', 'form_issued', 'pending', 'paid', 'fulfilled', 'closed', 'refunded'
  )),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  fulfilled_at TEXT,
  closed_at TEXT,
  refunded_at TEXT,
  refund_request_no TEXT UNIQUE,
  last_notify_id TEXT,
  last_queried_at TEXT
);
CREATE INDEX idx_payment_orders_account_created
  ON payment_orders(account_id, created_at DESC, id DESC);
CREATE INDEX idx_payment_orders_status ON payment_orders(status);

-- Schema changes need a matching file in ./migrations for already-deployed
-- instances — schema.sql alone only covers fresh installs. See README → Deploy.

-- ── 跨实例限流(migration 0005)──────────────────────────────────────────
-- 一行 = 一次被计数的请求。按 (bucket, key) 分组、按 at 做滑动窗口。
-- **刻意没有唯一约束**:同一 key 在窗口内本就该有多行(每次请求一行)。
-- 为什么用 D1 而不是内存:Worker 多隔离实例各有一份内存计数,
-- 生产实测同一邮箱 5 次得到 `429 202 429 202 202`(拦截率约 40%)。
CREATE TABLE rate_limits (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  at TEXT NOT NULL
);

-- 计数查询是 WHERE bucket=? AND key=? AND at>? —— at 必须在复合索引末尾
-- (等值列在前、范围列在后)才用得上。
CREATE INDEX idx_rate_limits_lookup ON rate_limits (bucket, key, at);
-- 刻意**不**建 (at) 单列索引:每次请求的清理是
-- `DELETE ... WHERE bucket=? AND key=? AND at<=?`,已被上面的复合索引覆盖。
-- 多一条索引只会让每次 INSERT 多付一次索引维护(写放大),没有读收益。
-- 将来若真要做「全表扫过期行」的周期性 sweep,再加。
