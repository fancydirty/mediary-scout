import type { CfApi } from "./cf-api.js";
import type { ConnectDb } from "./db.js";

export interface RevokeDeps {
  cf: CfApi;
  db: ConnectDb;
  now: () => string;
  newAuditId: () => string;
}

export interface RevokeResult {
  endpointId: string;
  hostname: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function revokeEndpoint(input: {
  endpointId: string;
  deps: RevokeDeps;
}): Promise<RevokeResult> {
  const { deps } = input;
  const { cf, db } = deps;
  const endpointId = input.endpointId;

  const endpoint = await db.getEndpointById(endpointId);
  if (endpoint === null) {
    throw new Error("endpoint not found");
  }
  // Idempotent: already revoked → no cf calls, no audit row. But self-heal a
  // partial crash window: if the isolate died between markEndpointRevoked and
  // updateInviteStatus, the invite is stuck `provisioned` (slug set) forever —
  // and revealByCode would still hand out the (deleted) tunnel's token. Flip
  // the invite here when it's not already revoked.
  if (endpoint.status === "revoked") {
    const invite = await db.getInviteById(endpoint.invite_id);
    if (invite !== null && invite.status !== "revoked") {
      await db.updateInviteStatus(invite.id, {
        status: "revoked",
        slug: null,
        revoked_at: deps.now(),
      });
    }
    return { endpointId, hostname: endpoint.hostname };
  }

  // Delete order: access app → dns record → tunnel. A failure on one step
  // must NOT prevent the remaining deletes from being attempted — e.g. a
  // failed access-app delete still leaves a deletable tunnel. Failures are
  // collected; the first one is what gets reported/rethrown.
  const failures: unknown[] = [];
  const attempt = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(e);
    }
  };

  await attempt(() => cf.deleteAccessApp(endpoint.cf_access_app_id));
  await attempt(() => cf.deleteDnsRecord(endpoint.cf_dns_record_id));
  await attempt(() => cf.deleteTunnel(endpoint.cf_tunnel_id));

  if (failures.length === 0) {
    await db.markEndpointRevoked(endpointId, deps.now());
    await db.updateInviteStatus(endpoint.invite_id, {
      status: "revoked",
      slug: null,
      revoked_at: deps.now(),
    });
    await db.insertAudit({
      id: deps.newAuditId(),
      at: deps.now(),
      actor: "admin",
      action: "endpoint.revoke",
      invite_id: endpoint.invite_id,
      endpoint_id: endpointId,
      detail_json: JSON.stringify({ hostname: endpoint.hostname }),
    });
    return { endpointId, hostname: endpoint.hostname };
  }

  // Partial failure: mark revoke_failed (NOT revoked) so the admin retries
  // later. Retrying is safe because cf-api deletes are 404-idempotent —
  // resources already deleted above simply come back as success.
  const firstError = failures[0];
  await db.markEndpointRevokeFailed(endpointId);
  await db.insertAudit({
    id: deps.newAuditId(),
    at: deps.now(),
    actor: "admin",
    action: "endpoint.revoke_failed",
    invite_id: endpoint.invite_id,
    endpoint_id: endpointId,
    detail_json: JSON.stringify({
      hostname: endpoint.hostname,
      errors: failures.map(errorMessage),
    }),
  });
  throw firstError;
}
