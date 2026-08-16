-- Migration 0006 — 支付渠道无关的权益账本 + 支付宝订单
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the Alipay Worker version. The new Worker
-- reads payment_provider/payment_transaction_id/refunded_at and the
-- payment_orders table on every checkout and payment callback.
--
-- How to run:
--   cd workers/scout-connect
--   npx wrangler d1 execute scout-connect --local \
--     --file=./migrations/0006-alipay-payment-orders.sql
--   npx wrangler d1 execute scout-connect --remote \
--     --file=./migrations/0006-alipay-payment-orders.sql
--   # then deploy the reviewed Worker commit
--
-- D1 applies a SQL file atomically and rejects explicit transaction control,
-- so this file intentionally contains none. SQLite cannot add columns with
-- IF NOT EXISTS: a second application stops at the first duplicate column and
-- leaves the existing migrated database unchanged.

-- Preserve the Paddle-specific column as historical evidence. New code uses
-- the provider-neutral pair below; existing non-null Paddle ids are backfilled.
ALTER TABLE entitlements ADD COLUMN payment_provider TEXT;
ALTER TABLE entitlements ADD COLUMN payment_transaction_id TEXT;
ALTER TABLE entitlements ADD COLUMN refunded_at TEXT;

UPDATE entitlements
   SET payment_provider = 'paddle',
       payment_transaction_id = paddle_transaction_id
 WHERE paddle_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX idx_ent_payment
  ON entitlements(payment_provider, payment_transaction_id)
  WHERE payment_provider IS NOT NULL AND payment_transaction_id IS NOT NULL;

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
  last_notify_id TEXT
);

CREATE INDEX idx_payment_orders_account_created
  ON payment_orders(account_id, created_at DESC, id DESC);
CREATE INDEX idx_payment_orders_status
  ON payment_orders(status);
