import { assertSlug } from "./slug.js";
import { sha256Hex } from "./crypto-token.js";
import { buildAgentPromptOrManual } from "./agent-prompt.js";
import { isEntitlementActive, latestExpiry } from "./entitlement.js";
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

/** 开通来源:admin 邀请(旧,行为原样保留)或登录账号自助(0004)。 */
export type ProvisionOrigin =
  | { kind: "invite"; inviteId: string }
  | { kind: "account"; accountId: string };

export interface ProvisionResult {
  endpointId: string;
  hostname: string;
  /** invite 分支专属(旧 reveal 流)。account 分支恒为 null:token 只能经
   *  取件码换取(决策 #10/#12),把 token 放进自助开通的响应等于绕过取件码
   *  的短命设计。 */
  inviteCode: string | null;
  /** plaintext connector token — invite 分支 return 值 ONLY,never persisted;
   *  account 分支恒为 null。 */
  token: string | null;
  agentPrompt: string | null;
}

export async function provisionEndpoint(input: {
  origin: ProvisionOrigin;
  slug: string;
  deps: ProvisionDeps;
}): Promise<ProvisionResult> {
  const { deps, origin } = input;
  const { cf, db } = deps;

  // ── 来源门禁(CF 编排之前;402/409 级失败绝不烧 CF API 调用)──
  let inviteCode: string | null = null;
  let accountId: string | null = null;
  if (origin.kind === "invite") {
    const invite = await db.getInviteById(origin.inviteId);
    if (invite === null) {
      throw new Error("invite not found");
    }
    if (invite.status !== "pending") {
      throw new Error("invite not pending");
    }
    inviteCode = invite.code;
  } else {
    const account = await db.getAccountById(origin.accountId);
    if (account === null) {
      throw new Error("account not found");
    }
    // entitlement 门禁:无有效时长不给开(路由层映射 402)。
    const ents = await db.listEntitlements(account.id);
    if (!isEntitlementActive(latestExpiry(ents), deps.now())) {
      throw new Error("no active entitlement");
    }
    // 一账号一 live endpoint(数据库部分唯一索引兜底,这里是友好预检)。
    const existing = await db.getActiveEndpointByAccountId(account.id);
    if (existing !== null) {
      throw new Error("already provisioned");
    }
    accountId = account.id;
  }

  const slug = assertSlug(input.slug);
  const hostname = `${slug}.${deps.rootDomain}`;

  // Slug/hostname availability precheck: shrinks the window where a retry
  // would burn a full set of CF resources only to die on a UNIQUE constraint
  // at insert time. Targeted existence query; the UNIQUE constraints on
  // endpoints.slug/hostname remain the final authority.
  const conflict = await db.findEndpointBySlugOrHostname(slug, hostname);
  if (conflict !== null) {
    if (conflict.slug === slug) {
      throw new Error(`slug already in use: ${slug}`);
    }
    throw new Error(`hostname already in use: ${hostname}`);
  }

  const { tunnelId, token } = await cf.createTunnel(`scout-${slug}`);

  // Compensation invariant: deleteTunnel runs AT MOST once on any failure
  // path. The inner dns catch deletes it, then rethrows into the outer catch,
  // which must not delete it again.
  let tunnelDeleted = false;
  const deleteTunnelOnce = async (): Promise<void> => {
    if (!tunnelDeleted) {
      // Latch AFTER the await: a transient delete failure leaves the flag
      // unset so a later catch can still retry (404-idempotent = safe).
      await cf.deleteTunnel(tunnelId);
      tunnelDeleted = true;
    }
  };

  // Create tunnel ingress and DNS; no Access app.
  //
  // Compensation here is BEST EFFORT, matching the post-CF phase below: a
  // failing deleteTunnel must never displace the failure that triggered the
  // rollback, or the caller is told "delete tunnel boom" when the real problem
  // was "cf dns boom". Note deleteTunnelOnce() latches only AFTER a successful
  // await, so a transient failure in the inner catch leaves the flag unset and
  // the outer catch retries it — deletion is 404-idempotent, so that is free.
  let recordId: string;
  try {
    await cf.putTunnelIngress(tunnelId, hostname);
    try {
      ({ recordId } = await cf.createDnsCname(slug, tunnelId));
    } catch (e) {
      try {
        await deleteTunnelOnce();
      } catch {
        // best-effort compensation — original error is what matters
      }
      throw e;
    }
  } catch (e) {
    try {
      await deleteTunnelOnce();
    } catch {
      // best-effort compensation — original error is what matters
    }
    throw e;
  }

  // Post-CF phase (crypto + persistence): all CF resources
  // (tunnel/ingress/access/dns) exist now. If anything here fails — including
  // a misconfigured wrap key — the resources would dangle, potentially with no
  // db row (and thus unreachable by the revoke flow). Spec error-compensation
  // row: best-effort delete of dns → access → tunnel, remove a partially
  // inserted endpoint row, plus a best-effort `provision.orphan` audit row
  // (which may itself fail if D1 is down).
  const endpointId = deps.newEndpointId();
  const actor = origin.kind === "invite" ? "admin" : `account:${origin.accountId}`;
  try {
    // SECURITY: token 不落库(决策 #10/#11)。只存 sha256 供心跳按 token 反查
    // endpoint;明文既不加密存也不存明文——需要时按 cf_tunnel_id 向 CF 现取。
    const sha = await sha256Hex(token);

    await db.insertEndpoint({
      id: endpointId,
      invite_id: origin.kind === "invite" ? origin.inviteId : null,
      slug,
      hostname,
      cf_tunnel_id: tunnelId,
      cf_access_app_id: null,
      cf_access_policy_id: null,
      cf_dns_record_id: recordId,
      status: "active",
      token_sha256: sha,
      token_ciphertext: null,
      token_shown_at: null,
      last_seen_at: null,
      created_at: deps.now(),
      revoked_at: null,
      account_id: accountId,
      grace_until: null,
      suspended_at: null,
      purge_after: null,
    });

    if (origin.kind === "invite") {
      await db.updateInviteStatus(origin.inviteId, {
        status: "provisioned",
        slug,
        provisioned_at: deps.now(),
      });
    }

    await db.insertAudit({
      id: deps.newAuditId(),
      at: deps.now(),
      actor,
      action: "endpoint.provision",
      invite_id: origin.kind === "invite" ? origin.inviteId : null,
      endpoint_id: endpointId,
      detail_json: JSON.stringify({ hostname }),
    });
  } catch (e) {
    // A partially inserted endpoint row would be a phantom pointing at the
    // (about-to-be-deleted) CF resources and would block any retry via UNIQUE
    // constraints — remove it best-effort. Forensics live in the orphan audit.
    try {
      await db.deleteEndpoint(endpointId);
    } catch {
      // best-effort compensation — original error is what matters
    }
    // If updateInviteStatus already flipped the invite to `provisioned` before
    // a later write (insertAudit) failed, the invite would be stuck forever
    // (not pending → no re-provision; no endpoint → nothing to revoke). Roll
    // it back so the admin can retry — but ONLY when the surviving endpoint
    // row is NOT ours. In a same-invite double-provision race (admin
    // double-clicks 开通) the winner's row has a different endpointId; reverting
    // the invite would orphan that live endpoint (invitee link shows "waiting"
    // forever, reveal 409s, re-provision dies on UNIQUE). When the survivor is
    // OUR OWN row (our deleteEndpoint compensation failed above), roll back
    // anyway: the row points at CF resources the compensation below is about
    // to delete, so a provisioned invite would let reveal hand out a token for
    // a dead tunnel. The phantom row stays visible in the admin endpoints list
    // and revoke is 404-idempotent. (invite 分支专属:account 分支没有 invite
    // 状态机可回滚。)
    if (origin.kind === "invite") {
      try {
        const surviving = await db.getEndpointByInviteId(origin.inviteId);
        if (surviving === null || surviving.id === endpointId) {
          await db.updateInviteStatus(origin.inviteId, {
            status: "pending",
            slug: null,
            provisioned_at: null,
          });
        }
      } catch {
        // D1 may be the failing component — nothing more we can do
      }
    }
    try {
      await cf.deleteDnsRecord(recordId);
    } catch {
      // best-effort compensation — original error is what matters
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
        invite_id: origin.kind === "invite" ? origin.inviteId : null,
        endpoint_id: endpointId,
        detail_json: JSON.stringify({
          hostname,
          cf_tunnel_id: tunnelId,
          cf_dns_record_id: recordId,
        }),
      });
    } catch {
      // D1 itself may be the failing component — nothing more we can do
    }
    throw e;
  }

  // account 分支不返回 token/prompt:接入唯一路径是控制台取件码(决策 #10/#12)。
  if (origin.kind === "account") {
    return { endpointId, inviteCode: null, hostname, token: null, agentPrompt: null };
  }
  return {
    endpointId,
    inviteCode,
    hostname,
    token,
    agentPrompt: buildAgentPromptOrManual({ hostname, tunnelToken: token }),
  };
}
