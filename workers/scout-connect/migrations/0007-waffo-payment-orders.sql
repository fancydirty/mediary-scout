-- Migration 0007 — allow Waffo checkout orders while retaining historical rows.
--
-- D1 rejects explicit transaction control in migration files. SQLite cannot
-- alter an existing CHECK constraint, so rebuild payment_orders and copy every
-- row before recreating its named indexes. The two Waffo ids are nullable so
-- existing Alipay rows remain byte-for-byte readable at the application layer.
--
-- Apply before deploying the Worker:
--   cd workers/scout-connect
--   npx wrangler d1 execute scout-connect --local \
--     --file=./migrations/0007-waffo-payment-orders.sql
--   npx wrangler d1 execute scout-connect --remote \
--     --file=./migrations/0007-waffo-payment-orders.sql

DROP INDEX IF EXISTS idx_payment_orders_account_created;
DROP INDEX IF EXISTS idx_payment_orders_status;

ALTER TABLE payment_orders RENAME TO payment_orders_old;

CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,
  checkout_token_sha256 TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK(provider IN ('alipay', 'waffo')),
  out_trade_no TEXT NOT NULL UNIQUE,
  trade_no TEXT UNIQUE,
  waffo_session_id TEXT,
  waffo_order_id TEXT,
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

INSERT INTO payment_orders (
  id, checkout_token_sha256, account_id, provider, out_trade_no, trade_no,
  waffo_session_id, waffo_order_id, months, total_amount, status, created_at,
  expires_at, paid_at, fulfilled_at, closed_at, refunded_at, refund_request_no,
  last_notify_id, last_queried_at
)
SELECT
  id, checkout_token_sha256, account_id, provider, out_trade_no, trade_no,
  NULL, NULL, months, total_amount, status, created_at, expires_at, paid_at,
  fulfilled_at, closed_at, refunded_at, refund_request_no, last_notify_id,
  last_queried_at
FROM payment_orders_old;

DROP TABLE payment_orders_old;

CREATE INDEX idx_payment_orders_account_created
  ON payment_orders(account_id, created_at DESC, id DESC);
CREATE INDEX idx_payment_orders_status
  ON payment_orders(status);
