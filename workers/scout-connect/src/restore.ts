import { AT_CAPACITY_MESSAGE, CAPACITY_LIMIT } from "./capacity.js";
import { sha256Hex } from "./crypto-token.js";
import { isEntitlementActive, latestExpiry } from "./entitlement.js";
import { revokeEndpoint } from "./revoke.js";
import { createTunnelResources } from "./tunnel-resources.js";
import type { CfApi } from "./cf-api.js";
import type { ConnectDb } from "./db.js";

export interface RestoreDeps {
  cf: CfApi;
  db: ConnectDb;
  now: () => string;
  newAuditId: () => string;
}

/**
 * Renewal brings back the address an account lost to expiry or a refund: same slug and hostname
 * (the row keeps them, so the UNIQUE columns never move), a new Cloudflare tunnel and DNS record.
 * The connector token is never returned: the instance fetches it with a claim code as usual.
 */
export async function restoreEndpoint(input: {
  accountId: string;
  deps: RestoreDeps;
}): Promise<{ endpointId: string; hostname: string }> {
  const { deps, accountId } = input;
  const { cf, db } = deps;
  const account = await db.getAccountById(accountId);
  if (account === null) throw new Error("account not found");
  if (!isEntitlementActive(latestExpiry(await db.listEntitlements(accountId)), deps.now())) {
    throw new Error("no active entitlement");
  }
  if ((await db.getActiveEndpointByAccountId(accountId)) !== null) throw new Error("already provisioned");
  let endpoint = await db.getRestorableEndpointByAccountId(accountId);
  if (endpoint === null) throw new Error("nothing to restore");
  const previousReason = endpoint.revoke_reason;

  if (endpoint.status === "revoke_failed") {
    // Cloudflare may still hold the old tunnel or DNS record; a second CNAME for the same name
    // would be refused. Finish that revoke first (deletes are 404-idempotent).
    try {
      await revokeEndpoint({
        endpointId: endpoint.id,
        reason: endpoint.revoke_reason ?? "expired",
        deps: { cf, db, now: deps.now, newAuditId: deps.newAuditId, actor: "system" },
      });
    } catch {
      throw new Error("restore cleanup failed");
    }
    endpoint = (await db.getEndpointById(endpoint.id)) ?? endpoint;
    if (endpoint.status !== "revoked") throw new Error("restore cleanup failed");
  }

  if ((await db.countLiveEndpoints()) >= CAPACITY_LIMIT) throw new Error(AT_CAPACITY_MESSAGE);

  const resources = await createTunnelResources(cf, endpoint.slug, endpoint.hostname);
  const tokenSha256 = await sha256Hex(resources.token);
  let restored = false;
  try {
    restored = await db.reactivateEndpoint({
      id: endpoint.id,
      accountId,
      cfTunnelId: resources.tunnelId,
      cfDnsRecordId: resources.recordId,
      tokenSha256,
    });
  } catch (e) {
    await resources.discard();
    throw e;
  }
  if (!restored) {
    await resources.discard();
    throw new Error("already provisioned");
  }
  // The row is the user's address. A failed audit must not roll it back: they paid and
  // the tunnel is already live. The operator still sees the error in the Worker logs.
  try {
    await db.insertAudit({
      id: deps.newAuditId(),
      at: deps.now(),
      actor: `account:${accountId}`,
      action: "endpoint.restore",
      invite_id: null,
      endpoint_id: endpoint.id,
      detail_json: JSON.stringify({
        hostname: endpoint.hostname,
        previous_tunnel_id: endpoint.cf_tunnel_id,
        tunnel_id: resources.tunnelId,
        previous_reason: previousReason,
      }),
    });
  } catch (e) {
    console.error("endpoint.restore audit failed:", e instanceof Error ? e.message : String(e));
  }
  return { endpointId: endpoint.id, hostname: endpoint.hostname };
}
