import { buildAgentPromptOrManual } from "./agent-prompt.js";
import type { ConnectDb } from "./db.js";
import type { CfApi } from "./cf-api.js";

export interface RevealDeps {
  db: ConnectDb;
  cf: CfApi;
  now: () => string;
  newAuditId: () => string;
}

export type RevealOutcome =
  | { kind: "not_found" } // unknown or revoked code — indistinguishable
  | { kind: "not_ready" } // invite pending (no endpoint yet)
  | { kind: "revealed"; hostname: string; token: string; agentPrompt: string };

/**
 * 揭示接入信息。P4 起 token 不再落库(决策 #10/#11):按 cf_tunnel_id 向
 * Cloudflare 现取 connector token —— 该 API 已实测幂等(同隧道恒返回同 token,
 * 不踢已连接实例)。因此揭示也变成幂等的:换机器、重装、重试都能再取,
 * 不再有「只显示一次」的 burn,也不需要密钥包装。
 */
export async function revealByCode(input: {
  code: string;
  deps: RevealDeps;
}): Promise<RevealOutcome> {
  const { deps } = input;
  const { db } = deps;

  const invite = await db.getInviteByCode(input.code);
  // 撤销的邀请必须与从不存在的不可区分——不泄露该 code 曾经有效。
  if (invite === null || invite.status === "revoked") {
    return { kind: "not_found" };
  }
  if (invite.status === "pending") {
    return { kind: "not_ready" };
  }

  const endpoint = await db.getEndpointByInviteId(invite.id);
  if (endpoint === null) {
    // provisioning 半途(invite 已翻 provisioned 但 endpoint 行缺失)。
    return { kind: "not_ready" };
  }
  // 撤销/撤销失败的 endpoint 决不能交出其(已删)隧道的 token,也不泄露
  // code 曾有效。当作未知 code。
  if (endpoint.status !== "active") {
    return { kind: "not_found" };
  }

  // SECURITY: token 只作返回值,绝不落库、绝不进审计(审计只记 hostname)。
  const token = await deps.cf.getTunnelToken(endpoint.cf_tunnel_id);

  // 审计尽力而为:取到 token 才是主目的,审计失败不阻断交付。
  try {
    await db.insertAudit({
      id: deps.newAuditId(),
      at: deps.now(),
      actor: "invitee",
      action: "token.reveal",
      invite_id: invite.id,
      endpoint_id: endpoint.id,
      detail_json: JSON.stringify({ hostname: endpoint.hostname }),
    });
  } catch {
    // audit lost — delivering the token takes precedence
  }

  return {
    kind: "revealed",
    hostname: endpoint.hostname,
    token,
    agentPrompt: buildAgentPromptOrManual({
      hostname: endpoint.hostname,
      tunnelToken: token,
    }),
  };
}
