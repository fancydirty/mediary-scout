import { assertSlug } from "./slug.js";
import { sha256Hex, wrapToken } from "./crypto-token.js";
import { buildAgentPrompt } from "./agent-prompt.js";
import type { CfApi } from "./cf-api.js";
import type { ConnectDb } from "./db.js";

export interface ProvisionDeps {
  cf: CfApi;
  db: ConnectDb;
  rootDomain: string; // e.g. "mediaryconnect.app"
  tokenWrapKeyHex: string; // 64 hex chars
  now: () => string; // ISO timestamp
  newEndpointId: () => string;
  newAuditId: () => string;
}

export interface ProvisionResult {
  endpointId: string;
  inviteCode: string;
  hostname: string;
  /** plaintext connector token — return value ONLY, never persisted */
  token: string;
  agentPrompt: string;
}

export async function provisionEndpoint(input: {
  inviteId: string;
  slug: string;
  deps: ProvisionDeps;
}): Promise<ProvisionResult> {
  const { deps } = input;
  const { cf, db } = deps;

  const invite = await db.getInviteById(input.inviteId);
  if (invite === null) {
    throw new Error("invite not found");
  }
  if (invite.status !== "pending") {
    throw new Error("invite not pending");
  }

  const slug = assertSlug(input.slug);
  const hostname = `${slug}.${deps.rootDomain}`;

  // Slug-availability precheck: shrinks the window where a retry would burn a
  // full set of CF resources only to die on a UNIQUE constraint at insert time.
  for (const existing of await db.listEndpoints()) {
    if (existing.slug === slug || existing.hostname === hostname) {
      throw new Error(`slug already in use: ${slug}`);
    }
  }

  const { tunnelId, token } = await cf.createTunnel(`scout-${slug}`);

  // Compensation invariant: deleteTunnel runs AT MOST once on any failure
  // path. The inner dns catch deletes it, then rethrows into the outer catch,
  // which must not delete it again.
  let tunnelDeleted = false;
  const deleteTunnelOnce = async (): Promise<void> => {
    if (!tunnelDeleted) {
      tunnelDeleted = true;
      await cf.deleteTunnel(tunnelId);
    }
  };

  // Order matters: Access BEFORE DNS, so the hostname never resolves to an
  // unprotected origin.
  let appId: string;
  let policyId: string | undefined;
  let recordId: string;
  try {
    await cf.putTunnelIngress(tunnelId, hostname);
    const app = await cf.createAccessApp({
      name: `scout-${slug}`,
      domain: hostname,
      email: invite.email.trim().toLowerCase(),
    });
    appId = app.appId;
    policyId = app.policyId;
    try {
      ({ recordId } = await cf.createDnsCname(slug, tunnelId));
    } catch (e) {
      await cf.deleteAccessApp(appId);
      await deleteTunnelOnce();
      throw e;
    }
  } catch (e) {
    await deleteTunnelOnce();
    throw e;
  }

  // SECURITY: only ciphertext + sha256 persist. The plaintext token is
  // returned to the caller once and never touches the db or the audit log.
  const ciphertext = await wrapToken(token, deps.tokenWrapKeyHex);
  const sha = await sha256Hex(token);
  const endpointId = deps.newEndpointId();

  // Post-CF persistence phase: all CF resources (tunnel/ingress/access/dns)
  // exist now. If a D1 write fails, the resources would dangle with no db row
  // (and thus be unreachable by the revoke flow) — spec error-compensation
  // row: best-effort delete of dns → access → tunnel, plus a best-effort
  // `provision.orphan` audit row (which may itself fail if D1 is down).
  try {
    await db.insertEndpoint({
      id: endpointId,
      invite_id: invite.id,
      slug,
      hostname,
      cf_tunnel_id: tunnelId,
      cf_access_app_id: appId,
      cf_access_policy_id: policyId ?? null,
      cf_dns_record_id: recordId,
      status: "active",
      token_sha256: sha,
      token_ciphertext: ciphertext,
      token_shown_at: null,
      created_at: deps.now(),
      revoked_at: null,
    });

    await db.updateInviteStatus(invite.id, {
      status: "provisioned",
      slug,
      provisioned_at: deps.now(),
    });

    await db.insertAudit({
      id: deps.newAuditId(),
      at: deps.now(),
      actor: "admin",
      action: "endpoint.provision",
      invite_id: invite.id,
      endpoint_id: endpointId,
      detail_json: JSON.stringify({ hostname }),
    });
  } catch (e) {
    try {
      await cf.deleteDnsRecord(recordId);
    } catch {
      // best-effort compensation — original error is what matters
    }
    try {
      await cf.deleteAccessApp(appId);
    } catch {
      // best-effort compensation
    }
    try {
      await deleteTunnelOnce();
    } catch {
      // best-effort compensation
    }
    try {
      await db.insertAudit({
        id: deps.newAuditId(),
        at: deps.now(),
        actor: "system",
        action: "provision.orphan",
        invite_id: invite.id,
        endpoint_id: endpointId,
        detail_json: JSON.stringify({ hostname }),
      });
    } catch {
      // D1 itself may be the failing component — nothing more we can do
    }
    throw e;
  }

  return {
    endpointId,
    inviteCode: invite.code,
    hostname,
    token,
    agentPrompt: buildAgentPrompt({ hostname, tunnelToken: token }),
  };
}
