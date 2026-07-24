import { unwrapToken } from "./crypto-token.js";
import { buildAgentPrompt } from "./agent-prompt.js";
import type { ConnectDb } from "./db.js";

export interface RevealDeps {
  db: ConnectDb;
  tokenWrapKeyHex: string;
  now: () => string;
  newAuditId: () => string;
}

export type RevealOutcome =
  | { kind: "not_found" } // unknown or revoked code — indistinguishable
  | { kind: "not_ready" } // invite pending (no endpoint yet)
  | { kind: "already_shown"; hostname: string } // token_shown_at already set (or ciphertext gone)
  | { kind: "revealed"; hostname: string; token: string; agentPrompt: string };

export async function revealByCode(input: {
  code: string;
  deps: RevealDeps;
}): Promise<RevealOutcome> {
  const { deps } = input;
  const { db } = deps;

  const invite = await db.getInviteByCode(input.code);
  // Revoked invites must be indistinguishable from never-existing ones —
  // do not leak that the code was ever valid.
  if (invite === null || invite.status === "revoked") {
    return { kind: "not_found" };
  }
  if (invite.status === "pending") {
    return { kind: "not_ready" };
  }

  // provisioned
  const endpoint = await db.getEndpointByInviteId(invite.id);
  if (endpoint === null) {
    // Edge: provisioning half-done (invite flipped, endpoint row missing).
    return { kind: "not_ready" };
  }
  // A revoked / revoke_failed endpoint must never hand out its (deleted)
  // tunnel's token — and must not leak that the code was ever valid. Treat
  // exactly like an unknown code, before any token logic.
  if (endpoint.status !== "active") {
    return { kind: "not_found" };
  }
  // One-time reveal: either already shown, or ciphertext gone (corrupt
  // state — defensively refuse to attempt a decrypt). No audit row here:
  // page refreshes must not spam the audit log unboundedly.
  if (endpoint.token_shown_at !== null || endpoint.token_ciphertext === null) {
    return { kind: "already_shown", hostname: endpoint.hostname };
  }

  // SECURITY: the plaintext token is returned to the caller ONLY — never
  // persisted, never written to the audit log (hostname only there).
  const token = await unwrapToken(endpoint.token_ciphertext, deps.tokenWrapKeyHex);
  // Atomic burn is the commit point: conditional UPDATE wins exactly one
  // concurrent reveal. A loser gets already_shown and discards its decrypted
  // copy — the "只显示这一次" promise holds even under racing requests.
  const burned = await db.markTokenShown(endpoint.id, deps.now());
  if (!burned) {
    return { kind: "already_shown", hostname: endpoint.hostname };
  }
  // Audit is best-effort: the ciphertext is already burned, so a failed audit
  // insert must never block delivery of the one-time token.
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
    agentPrompt: buildAgentPrompt({ hostname: endpoint.hostname, tunnelToken: token }),
  };
}
