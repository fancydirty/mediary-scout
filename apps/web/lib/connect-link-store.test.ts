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
  CONNECT_BOUND_AT_KEY,
  CONNECT_HOSTNAME_KEY,
  CONNECT_INSTANCE_CREDENTIAL_KEY,
  CONNECT_LINK_PENDING_KEY,
  CONNECT_PENDING_ORDER_KEY,
  CONNECT_TUNNEL_TOKEN_KEY,
  clearConnectAccountEmail,
  clearConnectInstanceCredential,
  clearConnectLinkPending,
  clearConnectPendingOrder,
  clearConnectHostname,
  clearConnectTunnelToken,
  getConnectAccountEmail,
  getConnectBoundAt,
  getConnectHostname,
  getConnectInstanceCredential,
  getConnectLinkPending,
  getConnectPendingOrder,
  getConnectTunnelToken,
  setConnectAccountEmail,
  setConnectBinding,
  setConnectInstanceCredential,
  setConnectLinkPending,
  setConnectPendingOrder,
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

describe("connect tunnel binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes token, hostname, then the bound time last, and reads the time back", async () => {
    await setConnectBinding({ token: " tok ", hostname: "a.example.com", boundAt: "2026-10-03T14:00:00.000Z" });
    expect(repository.setSetting.mock.calls).toEqual([
      [CONNECT_TUNNEL_TOKEN_KEY, "tok"],
      [CONNECT_HOSTNAME_KEY, "a.example.com"],
      [CONNECT_BOUND_AT_KEY, "2026-10-03T14:00:00.000Z"],
    ]);
    repository.getSetting.mockResolvedValueOnce(" 2026-10-03T14:00:00.000Z ");
    expect(await getConnectBoundAt()).toBe("2026-10-03T14:00:00.000Z");
  });
});

describe("pending link and order are single settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the whole pending request as one value and reads it back", async () => {
    const pending = { email: "a@b.c", pollSecret: "poll", verifyCode: "ABCD", expiresAt: "2026-10-03T00:30:00.000Z" };
    await setConnectLinkPending(pending);
    expect(repository.setSetting).toHaveBeenCalledTimes(1);
    const [key, value] = repository.setSetting.mock.calls[0]!;
    expect(key).toBe(CONNECT_LINK_PENDING_KEY);
    repository.getSetting.mockResolvedValueOnce(value);
    expect(await getConnectLinkPending()).toEqual(pending);
  });

  it("treats an unreadable pending value as no pending request", async () => {
    repository.getSetting.mockResolvedValueOnce("{not json");
    expect(await getConnectLinkPending()).toBeNull();
    repository.getSetting.mockResolvedValueOnce(JSON.stringify({ email: "a@b.c" }));
    expect(await getConnectLinkPending()).toBeNull();
  });

  it("clears the pending request with one delete and leaves the linked email alone", async () => {
    await clearConnectLinkPending();
    expect(repository.deleteSetting.mock.calls).toEqual([[CONNECT_LINK_PENDING_KEY]]);
  });

  it("remembers and forgets a pending order id", async () => {
    await setConnectPendingOrder("ord_1");
    expect(repository.setSetting).toHaveBeenCalledWith(CONNECT_PENDING_ORDER_KEY, "ord_1");
    repository.getSetting.mockResolvedValueOnce("ord_1");
    expect(await getConnectPendingOrder()).toBe("ord_1");
    await clearConnectPendingOrder();
    expect(repository.deleteSetting).toHaveBeenCalledWith(CONNECT_PENDING_ORDER_KEY);
  });
});
