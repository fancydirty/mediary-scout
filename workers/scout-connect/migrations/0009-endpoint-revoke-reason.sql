-- 0009: why an endpoint was taken down, so renewal can restore only the ones the owner may get back.
-- 'expired' = grace period ended (cron), 'refunded' = refund revoked it, 'admin' = manual revoke
-- (abuse etc., never self-restorable). NULL on rows revoked before this migration unless backfilled below.
ALTER TABLE endpoints ADD COLUMN revoke_reason TEXT;

-- Rows taken down by a refund before this column existed: the account has a refunded order.
UPDATE endpoints
   SET revoke_reason = 'refunded'
 WHERE status IN ('revoked', 'revoke_failed')
   AND revoke_reason IS NULL
   AND account_id IS NOT NULL
   AND account_id IN (SELECT account_id FROM payment_orders WHERE status = 'refunded');
