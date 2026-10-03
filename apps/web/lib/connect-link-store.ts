import { getWorkflowRepository } from "./workflow-runtime";

/** Instance-level settings written by the in-app Mediary Connect flow. */
export const CONNECT_INSTANCE_CREDENTIAL_KEY = "connect_instance_credential";
export const CONNECT_ACCOUNT_EMAIL_KEY = "connect_account_email";
/** The pending link request as one JSON value: its fields belong together, and two tabs
 *  starting a link at once must not leave one request's poll secret next to another's code. */
export const CONNECT_LINK_PENDING_KEY = "connect_link_pending";
/** The checkout order this page is waiting on (id and payment page, as one JSON value), so a
 *  reload keeps checking it and can still open its payment page. */
export const CONNECT_PENDING_ORDER_KEY = "connect_pending_order";
export const CONNECT_TUNNEL_TOKEN_KEY = "connect_tunnel_token";
export const CONNECT_HOSTNAME_KEY = "connect_hostname";
/** Fingerprint of the env web was running with when the stored token/hostname were bound. */
export const CONNECT_BOUND_ENV_KEY = "connect_bound_env";

export interface ConnectPendingOrder {
  orderId: string;
  checkoutUrl: string;
}

export interface ConnectLinkPending {
  email: string;
  pollSecret: string;
  verifyCode: string;
  expiresAt: string;
}

function normalized(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

async function getValue(key: string): Promise<string | null> {
  return normalized(await getWorkflowRepository().getSetting(key));
}

async function setValue(key: string, value: string): Promise<void> {
  const repository = getWorkflowRepository();
  const trimmed = value.trim();
  if (!trimmed) {
    await repository.deleteSetting(key);
    return;
  }
  await repository.setSetting(key, trimmed);
}

async function clearValue(key: string): Promise<void> {
  await getWorkflowRepository().deleteSetting(key);
}

export function getConnectInstanceCredential(): Promise<string | null> {
  return getValue(CONNECT_INSTANCE_CREDENTIAL_KEY);
}

export function setConnectInstanceCredential(value: string): Promise<void> {
  return setValue(CONNECT_INSTANCE_CREDENTIAL_KEY, value);
}

export function clearConnectInstanceCredential(): Promise<void> {
  return clearValue(CONNECT_INSTANCE_CREDENTIAL_KEY);
}

export function getConnectAccountEmail(): Promise<string | null> {
  return getValue(CONNECT_ACCOUNT_EMAIL_KEY);
}

export function setConnectAccountEmail(value: string): Promise<void> {
  return setValue(CONNECT_ACCOUNT_EMAIL_KEY, value);
}

export function clearConnectAccountEmail(): Promise<void> {
  return clearValue(CONNECT_ACCOUNT_EMAIL_KEY);
}

export async function getConnectLinkPending(): Promise<ConnectLinkPending | null> {
  const raw = await getValue(CONNECT_LINK_PENDING_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { email, pollSecret, verifyCode, expiresAt } = value as Record<string, unknown>;
    if ([email, pollSecret, verifyCode, expiresAt].some((field) => typeof field !== "string" || field.trim() === "")) {
      return null;
    }
    return { email, pollSecret, verifyCode, expiresAt } as ConnectLinkPending;
  } catch {
    return null;
  }
}

export async function setConnectLinkPending(value: ConnectLinkPending): Promise<void> {
  await getWorkflowRepository().setSetting(
    CONNECT_LINK_PENDING_KEY,
    JSON.stringify({ email: value.email, pollSecret: value.pollSecret, verifyCode: value.verifyCode, expiresAt: value.expiresAt }),
  );
}

/** Clear a pending request. The linked account's email is a separate setting and stays. */
export async function clearConnectLinkPending(): Promise<void> {
  await clearValue(CONNECT_LINK_PENDING_KEY);
}

export async function getConnectPendingOrder(): Promise<ConnectPendingOrder | null> {
  const raw = await getValue(CONNECT_PENDING_ORDER_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { orderId, checkoutUrl } = value as Record<string, unknown>;
    if ([orderId, checkoutUrl].some((field) => typeof field !== "string" || field.trim() === "")) return null;
    return { orderId, checkoutUrl } as ConnectPendingOrder;
  } catch {
    return null;
  }
}

export async function setConnectPendingOrder(value: ConnectPendingOrder): Promise<void> {
  await getWorkflowRepository().setSetting(
    CONNECT_PENDING_ORDER_KEY,
    JSON.stringify({ orderId: value.orderId, checkoutUrl: value.checkoutUrl }),
  );
}

export function clearConnectPendingOrder(): Promise<void> {
  return clearValue(CONNECT_PENDING_ORDER_KEY);
}

export function getConnectTunnelToken(): Promise<string | null> {
  return getValue(CONNECT_TUNNEL_TOKEN_KEY);
}

export function setConnectTunnelToken(value: string): Promise<void> {
  return setValue(CONNECT_TUNNEL_TOKEN_KEY, value);
}

export function clearConnectTunnelToken(): Promise<void> {
  return clearValue(CONNECT_TUNNEL_TOKEN_KEY);
}

export function getConnectHostname(): Promise<string | null> {
  return getValue(CONNECT_HOSTNAME_KEY);
}

export function setConnectHostname(value: string): Promise<void> {
  return setValue(CONNECT_HOSTNAME_KEY, value);
}

export function clearConnectHostname(): Promise<void> {
  return clearValue(CONNECT_HOSTNAME_KEY);
}

export function getConnectBoundEnv(): Promise<string | null> {
  return getValue(CONNECT_BOUND_ENV_KEY);
}

/** A tunnel the updater just started. The fingerprint goes last: it is what lets these values
 *  supersede the env web is running with (see remote-access.ts). */
export async function setConnectBinding(binding: { token: string; hostname: string; envFingerprint: string }): Promise<void> {
  await setValue(CONNECT_TUNNEL_TOKEN_KEY, binding.token);
  await setValue(CONNECT_HOSTNAME_KEY, binding.hostname);
  await setValue(CONNECT_BOUND_ENV_KEY, binding.envFingerprint);
}
