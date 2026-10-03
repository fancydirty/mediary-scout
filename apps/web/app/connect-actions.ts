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
  getConnectInstanceCredential,
  getConnectLinkPending,
  setConnectAccountEmail,
  setConnectHostname,
  setConnectInstanceCredential,
  setConnectLinkPending,
  setConnectTunnelToken,
} from "../lib/connect-link-store";
import { scoutConnectBaseUrl } from "../lib/remote-access";
import { startTunnel } from "../lib/updater-client";
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

export type ConnectStartLinkResult =
  | { ok: true; verifyCode: string; email: string }
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
  await setConnectAccountEmail(normalized);
  return { ok: true, verifyCode: result.verifyCode, email: normalized };
}

export type ConnectPollLinkResult =
  | { state: "pending" | "linked" | "expired" | "none" }
  | { state: "error"; message: string };

export async function connectPollLinkAction(): Promise<ConnectPollLinkResult> {
  const refused = await commonGuard();
  if (refused) return { state: "error", message: refused.message };
  const pending = await getConnectLinkPending();
  if (!pending) return { state: "none" };
  const result = await pollInstanceLink(pending.pollSecret);
  if (!result.ok) {
    if (result.reason === "slow_down") return { state: "pending" };
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
      await clearConnectInstanceCredential();
      await clearConnectAccountEmail();
      return { state: "unlinked" };
    }
    return { state: "error", message: clientMessage(result) };
  }
  const { ok: _ok, ...account } = result;
  return { state: "linked", account };
}

function validHostHeader(host: string | null): host is string {
  if (!host || host.length > 255 || /\s|[/\\]/.test(host)) return false;
  const match = host.match(/^(.*?)(?::(\d{1,5}))?$/);
  if (!match || !match[1] || (match[2] && Number(match[2]) > 65535)) return false;
  const name = match[1];
  if (name === "localhost") return true;
  if (/^\d+(?:\.\d+){3}$/.test(name)) return name.split(".").every((part) => Number(part) <= 255);
  if (/^\[[0-9a-fA-F:]+\]$/.test(name)) return true;
  return name.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

export async function connectCheckoutAction(
  tier: "quarter" | "year" | "two_years",
): Promise<{ ok: true; checkoutUrl: string; orderId: string } | Refusal> {
  const refused = await commonGuard();
  if (refused) return refused;
  const credential = await getConnectInstanceCredential();
  if (!credential) return { ok: false, message: "请先连接 Mediary Connect。" };
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const proto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const returnUrl = validHostHeader(host) && (proto === "http" || proto === "https")
    ? `${proto}://${host}/settings?tab=remote`
    : undefined;
  const result = await createConnectCheckout(credential, tier, returnUrl);
  if (!result.ok) return { ok: false, message: clientMessage(result) };
  return { ok: true, checkoutUrl: result.checkoutUrl, orderId: result.orderId };
}

export async function connectOrderStatusAction(orderId: string) {
  const refused = await commonGuard();
  if (refused) return { ok: false as const, message: refused.message };
  const credential = await getConnectInstanceCredential();
  if (!credential) return { ok: false as const, message: "请先连接 Mediary Connect。" };
  const result = await getConnectOrderStatus(credential, orderId);
  return result.ok ? { ok: true as const, status: result.status } : { ok: false as const, message: clientMessage(result) };
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
  const exchanged = await exchangeClaimCode(claim.code);
  if (!exchanged.ok) return { ok: false, reason: "compose_failed", message: clientMessage(exchanged) };
  await setConnectTunnelToken(exchanged.token);
  await setConnectHostname(exchanged.hostname);
  const started = await startTunnel({ token: exchanged.token, hostname: exchanged.hostname });
  if (started.ok) return { ok: true };
  if (started.reason === "no_updater") {
    return {
      ok: false,
      reason: "no_updater",
      command: `curl -fsSL ${scoutConnectBaseUrl()}/connect.sh | sh -s -- ${claim.code}`,
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
    try {
      await revokeInstanceLink(credential);
    } catch {
      // Best effort: local unlink must still work if Connect is unavailable.
    }
  }
  await clearConnectInstanceCredential();
  await clearConnectAccountEmail();
  await clearConnectLinkPending();
  return { ok: true };
}
