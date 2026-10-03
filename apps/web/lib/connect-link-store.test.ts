import { beforeEach, describe, expect, it, vi } from "vitest";

const { repository } = vi.hoisted(() => ({
  repository: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    deleteSetting: vi.fn(),
  },
}));

vi.mock("./workflow-runtime", () => ({
  getWorkflowRepository: () => repository,
}));

import {
  CONNECT_ACCOUNT_EMAIL_KEY,
  CONNECT_HOSTNAME_KEY,
  CONNECT_INSTANCE_CREDENTIAL_KEY,
  CONNECT_LINK_EXPIRES_AT_KEY,
  CONNECT_LINK_POLL_SECRET_KEY,
  CONNECT_LINK_VERIFY_CODE_KEY,
  CONNECT_TUNNEL_TOKEN_KEY,
  clearConnectAccountEmail,
  clearConnectInstanceCredential,
  clearConnectLinkPending,
  clearConnectHostname,
  clearConnectTunnelToken,
  getConnectAccountEmail,
  getConnectHostname,
  getConnectInstanceCredential,
  getConnectLinkPending,
  getConnectTunnelToken,
  setConnectAccountEmail,
  setConnectInstanceCredential,
  setConnectLinkPending,
  setConnectHostname,
  setConnectTunnelToken,
} from "./connect-link-store";

describe("connect link instance settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.getSetting.mockResolvedValue(null);
    repository.setSetting.mockResolvedValue(undefined);
    repository.deleteSetting.mockResolvedValue(undefined);
  });

  it("reads and writes the seven instance-level settings through the global repository", async () => {
    repository.getSetting.mockImplementation(async (key: string) =>
      key === CONNECT_INSTANCE_CREDENTIAL_KEY ? " cred " : null,
    );

    expect(await getConnectInstanceCredential()).toBe("cred");
    expect(await getConnectAccountEmail()).toBeNull();
    await setConnectInstanceCredential(" cred ");
    await setConnectAccountEmail(" owner@example.com ");
    await setConnectTunnelToken(" tunnel ");
    await setConnectHostname("name.mediaryconnect.app");

    expect(repository.setSetting).toHaveBeenNthCalledWith(1, CONNECT_INSTANCE_CREDENTIAL_KEY, "cred");
    expect(repository.setSetting).toHaveBeenNthCalledWith(2, CONNECT_ACCOUNT_EMAIL_KEY, "owner@example.com");
    expect(repository.setSetting).toHaveBeenNthCalledWith(3, CONNECT_TUNNEL_TOKEN_KEY, "tunnel");
    expect(repository.setSetting).toHaveBeenNthCalledWith(4, CONNECT_HOSTNAME_KEY, "name.mediaryconnect.app");
  });

  it("stores and reads pending link fields, then clears them without touching a linked email", async () => {
    await setConnectLinkPending({
      email: "owner@example.com",
      pollSecret: "poll-secret",
      verifyCode: "123456",
      expiresAt: "2026-10-03T00:00:00.000Z",
    });
    expect(repository.setSetting).toHaveBeenCalledWith(CONNECT_ACCOUNT_EMAIL_KEY, "owner@example.com");

    repository.getSetting.mockImplementation(async (key: string) => {
      const values: Record<string, string> = {
        [CONNECT_ACCOUNT_EMAIL_KEY]: "owner@example.com",
        [CONNECT_LINK_POLL_SECRET_KEY]: "poll-secret",
        [CONNECT_LINK_VERIFY_CODE_KEY]: "123456",
        [CONNECT_LINK_EXPIRES_AT_KEY]: "2026-10-03T00:00:00.000Z",
      };
      return values[key] ?? null;
    });
    await expect(getConnectLinkPending()).resolves.toEqual({
      email: "owner@example.com",
      pollSecret: "poll-secret",
      verifyCode: "123456",
      expiresAt: "2026-10-03T00:00:00.000Z",
    });

    repository.getSetting.mockImplementation(async (key: string) =>
      key === CONNECT_INSTANCE_CREDENTIAL_KEY ? "credential" : null,
    );
    await clearConnectLinkPending();
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_LINK_POLL_SECRET_KEY);
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_LINK_VERIFY_CODE_KEY);
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_LINK_EXPIRES_AT_KEY);
    expect(repository.deleteSetting).not.toHaveBeenCalledWith(CONNECT_ACCOUNT_EMAIL_KEY);
  });

  it("clears the pending email too when no credential is linked", async () => {
    await clearConnectLinkPending();
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_ACCOUNT_EMAIL_KEY);
  });

  it("clears individual linked and tunnel values", async () => {
    await clearConnectInstanceCredential();
    await clearConnectAccountEmail();
    await clearConnectTunnelToken();
    await clearConnectHostname();
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_INSTANCE_CREDENTIAL_KEY);
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_ACCOUNT_EMAIL_KEY);
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_TUNNEL_TOKEN_KEY);
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_HOSTNAME_KEY);
    expect(await getConnectTunnelToken()).toBeNull();
    expect(await getConnectHostname()).toBeNull();
  });
});
