"use server";

import { headers } from "next/headers";
import { assertNotDemo } from "../lib/demo-mode";
import {
  hasLoginPassword,
  isMultiUserEnabled,
  resolveIsDesktop,
} from "../lib/workflow-runtime";
import { resolveCurrentIsOwner } from "../lib/settings-attention-server";
import {
  checkConnectSlug,
  createConnectCheckout,
  exchangeClaimCode,
  getConnectAccount,
  getConnectOrderStatus,
  issueClaimCode,
  pollInstanceLink,
  provisionConnectSlug,
  revokeInstanceLink,
  startInstanceLink,
} from "../lib/connect-client";
import {
  clearConnectAccountEmail,
  clearConnectInstanceCredential,
  clearConnectLinkPending,
  clearConnectPendingOrder,
  getConnectInstanceCredential,
  getConnectLinkPending,
  setConnectAccountEmail,
  setConnectBinding,
  setConnectInstanceCredential,
  setConnectLinkPending,
  setConnectPendingOrder,
} from "../lib/connect-link-store";
import { scoutConnectBaseUrl } from "../lib/remote-access";
import { startTunnel } from "../lib/updater-client";
import { resolveRequestOriginOrNull } from "../lib/request-origin";
import { testRemoteAccessConnectionAction } from "./actions";

type Refusal = { ok: false; message: string };

async function commonGuard(): Promise<Refusal | null> {
  try {
    assertNotDemo();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "演示站只读。" };
  }
  if (resolveIsDesktop()) return { ok: false, message: "桌面版不提供远程访问。" };
  if (!(await resolveCurrentIsOwner())) return { ok: false, message: "没有权限。" };
  return null;
}

function clientMessage(result: { message?: string; reason?: string }): string {
  return result.message || "操作没完成，请稍后再试。";
}

/** Forget the credential and everything tied to its account (email, the order being waited on). */
async function forgetConnectAccount(): Promise<void> {
  await clearConnectInstanceCredential();
  await clearConnectAccountEmail();
  await clearConnectPendingOrder();
}

export type ConnectStartLinkResult =
  | { ok: true; verifyCode: string; email: string; interval: number }
  | Refusal;

export async function connectStartLinkAction(email: string): Promise<ConnectStartLinkResult> {
  const refused = await commonGuard();
  if (refused) return refused;
  const normalized = email.trim().toLowerCase();
  const result = await startInstanceLink(normalized);
  if (!result.ok) return { ok: false, message: clientMessage(result) };
  await setConnectLinkPending({
    pollSecret: result.pollSecret,
    verifyCode: result.verifyCode,
    expiresAt: result.expiresAt,
    email: normalized,
  });
  return { ok: true, verifyCode: result.verifyCode, email: normalized, interval: result.interval };
}

export type ConnectPollLinkResult =
  | { state: "pending" | "slow_down" | "linked" | "expired" | "none" }
  | { state: "error"; message: string };

export async function connectPollLinkAction(): Promise<ConnectPollLinkResult> {
  const refused = await commonGuard();
  if (refused) return { state: "error", message: refused.message };
  const pending = await getConnectLinkPending();
  if (!pending) return { state: "none" };
  const result = await pollInstanceLink(pending.pollSecret);
  // Another tab may have started a newer link while this poll was in flight: an answer about
  // the request it replaced must neither store a credential nor clear the newer request.
  if ((await getConnectLinkPending())?.pollSecret !== pending.pollSecret) return { state: "pending" };
  if (!result.ok) {
    if (result.reason === "slow_down") return { state: "slow_down" };
    if (result.reason === "expired" || result.reason === "unknown" || result.reason === "delivered") {
      await clearConnectLinkPending();
      return { state: "expired" };
    }
    return { state: "error", message: clientMessage(result) };
  }
  if (result.status === "pending") return { state: "pending" };
  if (result.status === "approved") {
    await setConnectInstanceCredential(result.credential);
    await setConnectAccountEmail(result.email);
    await clearConnectLinkPending();
    return { state: "linked" };
  }
  await clearConnectLinkPending();
  return { state: "expired" };
}

export type ConnectAccountResult =
  | { state: "unlinked" }
  | { state: "linked"; account: ConnectAccountView }
  | { state: "error"; message: string };

export type ConnectAccountView = {
  email: string;
  active: boolean;
  expiresAt: string | null;
  endpoint: { slug: string; hostname: string; status: string } | null;
  checkoutOpen: boolean;
  tiers: Array<{ id: "quarter" | "year" | "two_years"; label: string; months: number; price: string; featured: boolean }>;
};

export async function connectAccountAction(): Promise<ConnectAccountResult> {
  const refused = await commonGuard();
  if (refused) return { state: "error", message: refused.message };
  const credential = await getConnectInstanceCredential();
  if (!credential) return { state: "unlinked" };
  const result = await getConnectAccount(credential);
  if (!result.ok) {
    if (result.reason === "unauthorized") {
      await forgetConnectAccount();
      return { state: "unlinked" };
    }
    return { state: "error", message: clientMessage(result) };
  }
  const { ok: _ok, ...account } = result;
  return { state: "linked", account };
}

export async function connectCheckoutAction(
  tier: "quarter" | "year" | "two_years",
): Promise<{ ok: true; checkoutUrl: string; orderId: string } | Refusal> {
  const refused = await commonGuard();
  if (refused) return refused;
  const credential = await getConnectInstanceCredential();
  if (!credential) return { ok: false, message: "请先连接 Mediary Connect。" };
  // Behind a reverse proxy (or the tunnel) the browser's address is the forwarded host,
  // not the internal Host header; without a usable host, Connect keeps its own success page.
  const origin = resolveRequestOriginOrNull(await headers());
  const returnUrl = origin ? `${origin}/settings?tab=remote` : undefined;
  const result = await createConnectCheckout(credential, tier, returnUrl);
  if (!result.ok) return { ok: false, message: clientMessage(result) };
  // A reload (or finishing payment in the other tab) must not lose the only handle that makes
  // this page check the order, and with it Connect's compensation path.
  await setConnectPendingOrder(result.orderId);
  return { ok: true, checkoutUrl: result.checkoutUrl, orderId: result.orderId };
}

export async function connectOrderStatusAction(orderId: string) {
  const refused = await commonGuard();
  if (refused) return { ok: false as const, message: refused.message };
  const credential = await getConnectInstanceCredential();
  if (!credential) return { ok: false as const, message: "请先连接 Mediary Connect。" };
  const result = await getConnectOrderStatus(credential, orderId);
  if (!result.ok) {
    if (result.reason === "unauthorized") {
      await forgetConnectAccount();
      return { ok: false as const, unlinked: true as const, message: "Mediary Connect 连接已失效，请重新连接。" };
    }
    return { ok: false as const, message: clientMessage(result) };
  }
  if (result.status === "fulfilled" || result.status === "closed" || result.status === "expired") {
    await clearConnectPendingOrder();
  }
  return { ok: true as const, status: result.status };
}

export async function connectSlugCheckAction(slug: string) {
  const refused = await commonGuard();
  if (refused) return { ok: false as const, message: refused.message };
  const credential = await getConnectInstanceCredential();
  if (!credential) return { ok: false as const, message: "请先连接 Mediary Connect。" };
  const result = await checkConnectSlug(credential, slug.trim().toLowerCase());
  if (!result.ok) return { ok: false as const, message: clientMessage(result) };
  return result.available
    ? { ok: true as const, available: true }
    : { ok: true as const, available: false, reason: result.reason, suggestions: result.suggestions };
}

export async function connectProvisionAction(slug: string) {
  const refused = await commonGuard();
  if (refused) return { ok: false as const, message: refused.message };
  const credential = await getConnectInstanceCredential();
  if (!credential) return { ok: false as const, message: "请先连接 Mediary Connect。" };
  const result = await provisionConnectSlug(credential, slug.trim().toLowerCase());
  if (result.ok) return { ok: true as const, hostname: result.hostname };
  return { ok: false as const, reason: result.reason, message: clientMessage(result) };
}

export type ConnectBindResult =
  | { ok: true }
  | { ok: false; reason: "password_required" | "no_updater" | "busy" | "invalid_input" | "pull_failed" | "compose_failed"; message?: string; command?: string };

const SAFE_CLAIM_CODE = /^[A-Za-z0-9_.-]+$/;

/** Only scheme + host of the Connect address go into a shell command, never a path or query. */
function connectOrigin(): string {
  return new URL(scoutConnectBaseUrl()).origin;
}

export async function connectBindAction(): Promise<ConnectBindResult> {
  const refused = await commonGuard();
  if (refused) return { ok: false, reason: "compose_failed", message: refused.message };
  if (!isMultiUserEnabled() && (await hasLoginPassword()) !== true) {
    return { ok: false, reason: "password_required" };
  }
  const credential = await getConnectInstanceCredential();
  if (!credential) return { ok: false, reason: "compose_failed", message: "请先连接 Mediary Connect。" };
  const claim = await issueClaimCode(credential);
  if (!claim.ok) return { ok: false, reason: "compose_failed", message: clientMessage(claim) };
  // The code may end up in a shell command (the connect.sh fallback below): only the signed-token
  // alphabet, same rule as the Connect console's prompt builder.
  if (!SAFE_CLAIM_CODE.test(claim.code)) {
    return { ok: false, reason: "compose_failed", message: "Mediary Connect 返回的接入码格式不对，请稍后再试。" };
  }
  const exchanged = await exchangeClaimCode(claim.code);
  if (!exchanged.ok) return { ok: false, reason: "compose_failed", message: clientMessage(exchanged) };
  const started = await startTunnel({ token: exchanged.token, hostname: exchanged.hostname });
  if (started.ok) {
    // Only now: a stored token makes the page report the tunnel as on. After a failed start
    // the wizard stays on 接入; after the connect.sh fallback, web reads the token from .env.
    await setConnectBinding({ token: exchanged.token, hostname: exchanged.hostname, boundAt: new Date().toISOString() });
    return { ok: true };
  }
  if (started.reason === "no_updater") {
    return {
      ok: false,
      reason: "no_updater",
      command: `curl -fsSL ${connectOrigin()}/connect.sh | sh -s -- ${claim.code}`,
    };
  }
  if (started.reason === "busy") return { ok: false, reason: "busy", message: "正在更新版本，等更新结束再接入。" };
  if (started.reason === "pull_failed") {
    return { ok: false, reason: "pull_failed", message: "拉取隧道镜像失败。可以在 .env 里加 DOCKER_MIRROR=docker.1ms.run 后再试。" };
  }
  if (started.reason === "invalid_input") {
    return { ok: false, reason: "invalid_input", message: "接入凭据格式不对，请点「重新接入」再试。" };
  }
  return { ok: false, reason: "compose_failed", message: "隧道没有启动成功，请稍后点「重新接入」再试。" };
}

export async function connectProbeAction() {
  const refused = await commonGuard();
  if (refused) return { ok: false as const, detail: "unreachable" as const, message: refused.message };
  return await testRemoteAccessConnectionAction();
}

export async function connectUnlinkAction(): Promise<{ ok: true } | Refusal> {
  const refused = await commonGuard();
  if (refused) return refused;
  const credential = await getConnectInstanceCredential();
  if (credential) {
    // Only forget the credential once Connect stopped honouring it (revoked now, or already
    // invalid): deleting the only copy while it still works would leave a live credential
    // nobody can revoke.
    const revoked = await revokeInstanceLink(credential);
    if (!revoked.ok && revoked.reason !== "unauthorized") {
      return { ok: false, message: `${clientMessage(revoked)}没有断开，稍后再点一次「断开」。` };
    }
  }
  // Including its pending order: the next account must not inherit it.
  await forgetConnectAccount();
  await clearConnectLinkPending();
  return { ok: true };
}
