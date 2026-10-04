import { AT_CAPACITY_MESSAGE, CAPACITY_LIMIT } from "./capacity.js";
import { sha256Hex } from "./crypto-token.js";
import { isEntitlementActive, latestExpiry } from "./entitlement.js";
import { createTunnelResources, type TunnelResources } from "./tunnel-resources.js";
import type { CfApi } from "./cf-api.js";
import type { ConnectDb } from "./db.js";

export interface RestoreDeps {
  cf: CfApi;
  db: ConnectDb;
  now: () => string;
  newAuditId: () => string;
  /** Pause between re-reads after a lost CNAME race. Defaults to setTimeout; tests inject their own. */
  sleep?: (ms: number) => Promise<void>;
}

// A winner may already own the CNAME but not have run its D1 update yet: re-read a few times
// before deciding the failure was our own (about 1.5 s on a real Cloudflare error).
const LOST_RACE_REREADS = 3;
const LOST_RACE_DELAY_MS = 500;

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
  const endpoint = await db.getRestorableEndpointByAccountId(accountId);
  if (endpoint === null) throw new Error("nothing to restore");
  const previousReason = endpoint.revoke_reason;
  const previousStatus = endpoint.status;

  if (endpoint.status === "revoke_failed") {
    // Cloudflare may still hold the old tunnel or DNS record; a second CNAME for the same name
    // would be refused. Delete only the ids this request captured. revokeEndpoint re-reads the
    // row and would delete a tunnel a concurrent restore has already installed.
    // Deletes are 404-idempotent in the cf client. Attempt every captured resource; one failure
    // must not skip the rest, and any failure leaves the row revoke_failed.
    const accessAppId = endpoint.cf_access_app_id;
    const dnsRecordId = endpoint.cf_dns_record_id;
    const tunnelId = endpoint.cf_tunnel_id;
    const failures: unknown[] = [];
    const attempt = async (fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        failures.push(e);
      }
    };
    if (accessAppId) await attempt(() => cf.deleteAccessApp(accessAppId));
    await attempt(() => cf.deleteDnsRecord(dnsRecordId));
    await attempt(() => cf.deleteTunnel(tunnelId));
    if (failures.length > 0) throw new Error("restore cleanup failed");
    const finished = await db.finishFailedRevoke({
      id: endpoint.id,
      cfTunnelId: tunnelId,
      at: deps.now(),
    });
    if (!finished) {
      const current = await db.getEndpointById(endpoint.id);
      // Another request finished this same cleanup. Carry on and install a new tunnel.
      if (current === null || current.status !== "revoked" || current.cf_tunnel_id !== tunnelId) {
        throw new Error("already provisioned");
      }
    }
  }

  if ((await db.countLiveEndpoints()) >= CAPACITY_LIMIT) throw new Error(AT_CAPACITY_MESSAGE);

  let resources: TunnelResources;
  try {
    resources = await createTunnelResources(cf, endpoint.slug, endpoint.hostname);
  } catch (e) {
    // A concurrent restore of this row that got there first owns the CNAME, so ours fails on the
    // duplicate. createTunnelResources already deleted our tunnel; report the lost race as such.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let reread = 0; reread <= LOST_RACE_REREADS; reread++) {
      if ((await db.getEndpointById(endpoint.id))?.status === "active") throw new Error("already provisioned");
      if (reread < LOST_RACE_REREADS) await sleep(LOST_RACE_DELAY_MS);
    }
    throw e;
  }
  // discard() swallows delete failures. Like provision.orphan, leave the new ids in an audit row so
  // an operator can find leftovers; D1 may be what failed, so this is best effort too.
  const rollBack = async (created: TunnelResources): Promise<void> => {
    await created.discard();
    try {
      await db.insertAudit({
        id: deps.newAuditId(),
        at: deps.now(),
        actor: "system",
        action: "restore.orphan",
        invite_id: null,
        endpoint_id: endpoint.id,
        detail_json: JSON.stringify({
          hostname: endpoint.hostname,
          cf_tunnel_id: created.tunnelId,
          cf_dns_record_id: created.recordId,
        }),
      });
    } catch {
      // nothing more we can do
    }
  };
  let restored = false;
  try {
    // Same post-CF invariant as provisionEndpoint: hashing sits inside the rollback,
    // so a rejection discards the DNS record and tunnel that already exist.
    const tokenSha256 = await sha256Hex(resources.token);
    restored = await db.reactivateEndpoint({
      id: endpoint.id,
      accountId,
      cfTunnelId: resources.tunnelId,
      cfDnsRecordId: resources.recordId,
      tokenSha256,
    });
  } catch (e) {
    await rollBack(resources);
    throw e;
  }
  if (!restored) {
    await rollBack(resources);
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
        previous_status: previousStatus,
      }),
    });
  } catch (e) {
    console.error("endpoint.restore audit failed:", e instanceof Error ? e.message : String(e));
  }
  return { endpointId: endpoint.id, hostname: endpoint.hostname };
}
