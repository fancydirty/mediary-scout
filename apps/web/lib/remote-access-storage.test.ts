import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({
  store: {
    getConnectTunnelToken: vi.fn(),
    getConnectHostname: vi.fn(),
    getConnectBoundAt: vi.fn(),
  },
}));

vi.mock("./connect-link-store", () => store);

import { instanceConnectHostname, instanceTunnelToken, resolveInstanceConnectHostname, resolveInstanceTunnelToken } from "./remote-access";

const previousToken = process.env.TUNNEL_TOKEN;
const previousHostname = process.env.MEDIARY_CONNECT_HOSTNAME;

beforeEach(() => {
  delete process.env.TUNNEL_TOKEN;
  delete process.env.MEDIARY_CONNECT_HOSTNAME;
  store.getConnectTunnelToken.mockResolvedValue(null);
  store.getConnectHostname.mockResolvedValue(null);
  store.getConnectBoundAt.mockResolvedValue(null);
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.TUNNEL_TOKEN;
  else process.env.TUNNEL_TOKEN = previousToken;
  if (previousHostname === undefined) delete process.env.MEDIARY_CONNECT_HOSTNAME;
  else process.env.MEDIARY_CONNECT_HOSTNAME = previousHostname;
  vi.clearAllMocks();
});

describe("instance connect env and stored value resolution", () => {
  it("keeps existing synchronous readers env-only", () => {
    process.env.TUNNEL_TOKEN = " env-token ";
    process.env.MEDIARY_CONNECT_HOSTNAME = "Env.Example.COM";
    expect(instanceTunnelToken()).toBe("env-token");
    expect(instanceConnectHostname()).toBe("env.example.com");
    expect(store.getConnectTunnelToken).not.toHaveBeenCalled();
    expect(store.getConnectHostname).not.toHaveBeenCalled();
  });

  it("uses stored values when the corresponding env value is empty", async () => {
    store.getConnectTunnelToken.mockResolvedValue(" db-token ");
    store.getConnectHostname.mockResolvedValue(" Db.Example.COM ");
    expect(await resolveInstanceTunnelToken()).toBe("db-token");
    expect(await resolveInstanceConnectHostname()).toBe("db.example.com");
  });

  it("prefers the env this process started with over a binding made before it started", async () => {
    process.env.TUNNEL_TOKEN = "env-token";
    process.env.MEDIARY_CONNECT_HOSTNAME = "env.example.com";
    store.getConnectTunnelToken.mockResolvedValue("db-token");
    store.getConnectHostname.mockResolvedValue("db.example.com");
    store.getConnectBoundAt.mockResolvedValue("2000-01-01T00:00:00.000Z");
    expect(await resolveInstanceTunnelToken()).toBe("env-token");
    expect(await resolveInstanceConnectHostname()).toBe("env.example.com");
    // Bindings stored before this feature recorded no time: env still wins.
    store.getConnectBoundAt.mockResolvedValue(null);
    expect(await resolveInstanceTunnelToken()).toBe("env-token");
    expect(await resolveInstanceConnectHostname()).toBe("env.example.com");
  });

  it("lets a binding made after this process started supersede its stale env (重新接入 without restarting web)", async () => {
    process.env.TUNNEL_TOKEN = "old-env-token";
    process.env.MEDIARY_CONNECT_HOSTNAME = "old.example.com";
    store.getConnectTunnelToken.mockResolvedValue("new-token");
    store.getConnectHostname.mockResolvedValue("new.example.com");
    store.getConnectBoundAt.mockResolvedValue(new Date().toISOString());
    expect(await resolveInstanceTunnelToken()).toBe("new-token");
    expect(await resolveInstanceConnectHostname()).toBe("new.example.com");
  });

  it("rejects malformed stored hostnames", async () => {
    store.getConnectHostname.mockResolvedValue("https://bad.example.com/path");
    store.getConnectBoundAt.mockResolvedValue(new Date().toISOString());
    expect(await resolveInstanceConnectHostname()).toBeNull();
  });

  it("keeps a malformed non-empty env hostname authoritative over an older binding", async () => {
    process.env.MEDIARY_CONNECT_HOSTNAME = "https://bad.example.com/path";
    store.getConnectHostname.mockResolvedValue("valid.example.com");
    store.getConnectBoundAt.mockResolvedValue("2000-01-01T00:00:00.000Z");
    expect(await resolveInstanceConnectHostname()).toBeNull();
  });
});
