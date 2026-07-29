import { CAPACITY_LIMIT } from "./capacity.js";
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

/** 判别联合:invite 分支必有 token/prompt(旧 reveal 流),account 分支在
 *  类型上就没有这些字段——token 只能经取件码换取(决策 #10/#12),把 token
 *  放进自助开通的响应等于绕过取件码的短命设计。编译期即杜绝误传播。 */
export type ProvisionResult =
  | {
      kind: "invite";
      endpointId: string;
      hostname: string;
      inviteCode: string;
      /** plaintext connector token — return value ONLY, never persisted */
      token: string;
      agentPrompt: string;
    }
  | { kind: "account"; endpointId: string; hostname: string };

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
  // rootDomain normalize:CONNECT_ROOT_DOMAIN 可能带空白/大小写(与 magic-link
  // / slug-check 各处同款处理),否则会生成畸形 hostname 误配 CF/DNS/查重。
  const rootDomain = deps.rootDomain.trim().toLowerCase();
  const hostname = `${slug}.${rootDomain}`;

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

  // 容量闸门。**必须在烧任何 CF 资源之前**:CF 隧道硬上限 1000/账号(所有套餐
  // 一致,含 Enterprise),撞上时 createTunnel 会失败,用户已付款却拿到
  // 「开通失败,请稍后重试」——而重试永远不会成功。放在这里(slug 查重之后、
  // createTunnel 之前)既不浪费一次查重,也保证零 CF 副作用。
  // 路由层把这条映射成 503(我方容量问题,不是用户请求错误)。
  //
  // **已知非原子(TOCTOU),有意如此。** 这是 COUNT 读后再建,并发下多个请求可能
  // 同时看到 live < CAPACITY_LIMIT 而全部放行。要真的突破 CF 的 1000 硬上限,
  // 需要 **11 个请求落在同一个毫秒级窗口内、且恰好都在第 990 条附近** ——
  // 990 阈值留的那 10 条余量正是为此(不只是给运维)。
  // 本产品是预付时长、单人自助开通,该并发在 1000 用户规模下不会出现。
  // 若真要硬保证,需引入预留机制(插一条 status='provisioning' 的短命行抢
  // UNIQUE),但那要求:新状态进容量白名单、僵尸预留的清理任务、以及改
  // idx_endpoints_account_live 部分唯一索引的语义 —— 改动面远大于收益。
  // 触发重新评估的信号:活跃 endpoint 数接近 900,或出现任何一次 createTunnel
  // 因配额失败的审计记录。
  const live = await db.countLiveEndpoints();
  if (live >= CAPACITY_LIMIT) {
    throw new Error("at capacity");
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

  // account 分支在类型上就不含 token/prompt:接入唯一路径是控制台取件码。
  if (origin.kind === "account") {
    return { kind: "account", endpointId, hostname };
  }
  return {
    kind: "invite",
    endpointId,
    // inviteCode 在 invite 分支的门禁里必然已赋值;这里的守卫让 TS 收窄,
    // 也把"不可能"变成 fail-fast 而不是把 null 序列化给客户端。
    inviteCode: inviteCode!,
    hostname,
    token,
    agentPrompt: buildAgentPromptOrManual({ hostname, tunnelToken: token }),
  };
}
