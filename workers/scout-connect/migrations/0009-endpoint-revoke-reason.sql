-- 0009: why an endpoint was taken down, so renewal can restore only the ones the owner may get back.
-- 'expired' = grace period ended (cron), 'refunded' = refund revoked it, 'admin' = manual revoke
-- (abuse etc., never self-restorable). NULL on rows revoked before this migration unless backfilled below.
--
-- A refund revoke is recognised by timing. applyWaffoRefund sets payment_orders.refunded_at and then
-- revokeEndpoint in the same request, so revoked_at is a few seconds after that order's refunded_at
-- (production: 05:14:43.963Z → 05:14:45.835Z). The window below is 10 minutes. An admin/abuse revoke
-- on an account that once had a refund falls outside it and stays NULL. A revoke_failed row has
-- revoked_at NULL, so it stays NULL too — not restorable, the conservative outcome.
ALTER TABLE endpoints ADD COLUMN revoke_reason TEXT;

UPDATE endpoints
   SET revoke_reason = 'refunded'
 WHERE status IN ('revoked', 'revoke_failed')
   AND revoke_reason IS NULL
   AND account_id IS NOT NULL
   AND revoked_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM payment_orders po
      WHERE po.account_id = endpoints.account_id
        AND po.status = 'refunded'
        AND po.refunded_at IS NOT NULL
        AND julianday(endpoints.revoked_at) >= julianday(po.refunded_at)
        AND julianday(endpoints.revoked_at) <= julianday(po.refunded_at) + 10.0 / 1440
   );
