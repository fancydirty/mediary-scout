import { getWorkflowRepository } from "./workflow-runtime";

/** Instance-level settings written by the in-app Mediary Connect flow. */
export const CONNECT_INSTANCE_CREDENTIAL_KEY = "connect_instance_credential";
export const CONNECT_ACCOUNT_EMAIL_KEY = "connect_account_email";
export const CONNECT_LINK_POLL_SECRET_KEY = "connect_link_poll_secret";
export const CONNECT_LINK_VERIFY_CODE_KEY = "connect_link_verify_code";
export const CONNECT_LINK_EXPIRES_AT_KEY = "connect_link_expires_at";
export const CONNECT_TUNNEL_TOKEN_KEY = "connect_tunnel_token";
export const CONNECT_HOSTNAME_KEY = "connect_hostname";
/** When the stored token/hostname were last bound from this page (ISO). */
export const CONNECT_BOUND_AT_KEY = "connect_bound_at";

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
  const [email, pollSecret, verifyCode, expiresAt] = await Promise.all([
    getValue(CONNECT_ACCOUNT_EMAIL_KEY),
    getValue(CONNECT_LINK_POLL_SECRET_KEY),
    getValue(CONNECT_LINK_VERIFY_CODE_KEY),
    getValue(CONNECT_LINK_EXPIRES_AT_KEY),
  ]);
  if (!email || !pollSecret || !verifyCode || !expiresAt) return null;
  return { email, pollSecret, verifyCode, expiresAt };
}

export async function setConnectLinkPending(value: ConnectLinkPending): Promise<void> {
  await Promise.all([
    setValue(CONNECT_ACCOUNT_EMAIL_KEY, value.email),
    setValue(CONNECT_LINK_POLL_SECRET_KEY, value.pollSecret),
    setValue(CONNECT_LINK_VERIFY_CODE_KEY, value.verifyCode),
    setValue(CONNECT_LINK_EXPIRES_AT_KEY, value.expiresAt),
  ]);
}

/** Clear a pending request. A linked email is retained while its credential exists. */
export async function clearConnectLinkPending(): Promise<void> {
  const repository = getWorkflowRepository();
  await Promise.all([
    repository.deleteSetting(CONNECT_LINK_POLL_SECRET_KEY),
    repository.deleteSetting(CONNECT_LINK_VERIFY_CODE_KEY),
    repository.deleteSetting(CONNECT_LINK_EXPIRES_AT_KEY),
  ]);
  // The same email setting records the linked account email after approval. Do not
  // erase it when clearing a stale pending request for an already-linked instance.
  if (!(await getValue(CONNECT_INSTANCE_CREDENTIAL_KEY))) {
    await repository.deleteSetting(CONNECT_ACCOUNT_EMAIL_KEY);
  }
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

export function getConnectBoundAt(): Promise<string | null> {
  return getValue(CONNECT_BOUND_AT_KEY);
}

/** A tunnel the updater just started. The time goes last: it is what lets these values
 *  supersede the env a running web process was started with (see remote-access.ts). */
export async function setConnectBinding(binding: { token: string; hostname: string; boundAt: string }): Promise<void> {
  await setValue(CONNECT_TUNNEL_TOKEN_KEY, binding.token);
  await setValue(CONNECT_HOSTNAME_KEY, binding.hostname);
  await setValue(CONNECT_BOUND_AT_KEY, binding.boundAt);
}
