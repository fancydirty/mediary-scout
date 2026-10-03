import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({
  store: {
    getConnectTunnelToken: vi.fn(),
    getConnectHostname: vi.fn(),
    getConnectBoundEnv: vi.fn(),
  },
}));

vi.mock("./connect-link-store", () => store);

import {
  instanceConnectHostname,
  instanceEnvFingerprint,
  instanceTunnelToken,
  resolveInstanceConnectHostname,
  resolveInstanceTunnelToken,
} from "./remote-access";

const previousToken = process.env.TUNNEL_TOKEN;
const previousHostname = process.env.MEDIARY_CONNECT_HOSTNAME;

function setEnv(token: string | undefined, hostname: string | undefined) {
  if (token === undefined) delete process.env.TUNNEL_TOKEN;
  else process.env.TUNNEL_TOKEN = token;
  if (hostname === undefined) delete process.env.MEDIARY_CONNECT_HOSTNAME;
  else process.env.MEDIARY_CONNECT_HOSTNAME = hostname;
}

/** The fingerprint a binding made while the env looked like this would have stored. */
function fingerprintOf(token: string | undefined, hostname: string | undefined): string {
  const [savedToken, savedHostname] = [process.env.TUNNEL_TOKEN, process.env.MEDIARY_CONNECT_HOSTNAME];
  setEnv(token, hostname);
  const fingerprint = instanceEnvFingerprint();
  setEnv(savedToken, savedHostname);
  return fingerprint;
}

beforeEach(() => {
  setEnv(undefined, undefined);
  store.getConnectTunnelToken.mockResolvedValue(null);
  store.getConnectHostname.mockResolvedValue(null);
  store.getConnectBoundEnv.mockResolvedValue(null);
});

afterEach(() => {
  setEnv(previousToken, previousHostname);
  vi.clearAllMocks();
});

describe("instance connect env and stored value resolution", () => {
  it("keeps existing synchronous readers env-only", () => {
    setEnv(" env-token ", "Env.Example.COM");
    expect(instanceTunnelToken()).toBe("env-token");
    expect(instanceConnectHostname()).toBe("env.example.com");
    expect(store.getConnectTunnelToken).not.toHaveBeenCalled();
    expect(store.getConnectHostname).not.toHaveBeenCalled();
  });

  it("fingerprints the env the same way however it is padded or cased, and differently when it changes", () => {
    expect(fingerprintOf(" tok ", "Home.Example.COM")).toBe(fingerprintOf("tok", "home.example.com"));
    expect(fingerprintOf("tok", "home.example.com")).not.toBe(fingerprintOf("tok2", "home.example.com"));
    expect(fingerprintOf("tok", "home.example.com")).not.toBe(fingerprintOf("tok", "other.example.com"));
    expect(fingerprintOf(undefined, undefined)).not.toBe(fingerprintOf("tok", undefined));
  });

  it("uses the stored binding while the env is still the one it was made under", async () => {
    store.getConnectTunnelToken.mockResolvedValue(" db-token ");
    store.getConnectHostname.mockResolvedValue(" Db.Example.COM ");
    store.getConnectBoundEnv.mockResolvedValue(fingerprintOf(undefined, undefined));
    expect(await resolveInstanceTunnelToken()).toBe("db-token");
    expect(await resolveInstanceConnectHostname()).toBe("db.example.com");
  });

  it("lets 重新接入 supersede the env web was created with, also after web restarts with that same env", async () => {
    // A restart (crash, host reboot) keeps the env from when the container was created; only
    // recreating it from .env changes the env.
    setEnv("old-env-token", "old.example.com");
    store.getConnectTunnelToken.mockResolvedValue("new-token");
    store.getConnectHostname.mockResolvedValue("new.example.com");
    store.getConnectBoundEnv.mockResolvedValue(fingerprintOf("old-env-token", "old.example.com"));
    expect(await resolveInstanceTunnelToken()).toBe("new-token");
    expect(await resolveInstanceConnectHostname()).toBe("new.example.com");
  });

  it("lets the env win once web was recreated, even with the same env (another container)", async () => {
    // e.g. the tunnel lines were removed from .env and web recreated: the env is empty again,
    // as it was at binding time, but this is a new container.
    store.getConnectTunnelToken.mockResolvedValue("db-token");
    store.getConnectHostname.mockResolvedValue("db.example.com");
    store.getConnectBoundEnv.mockResolvedValue(instanceEnvFingerprint("old-container-id"));
    expect(await resolveInstanceTunnelToken()).toBeUndefined();
    expect(await resolveInstanceConnectHostname()).toBeNull();
  });

  it("lets the env win once web was recreated with a different env, even an empty one", async () => {
    store.getConnectTunnelToken.mockResolvedValue("db-token");
    store.getConnectHostname.mockResolvedValue("db.example.com");
    store.getConnectBoundEnv.mockResolvedValue(fingerprintOf("old-env-token", "old.example.com"));
    setEnv("env-token", "env.example.com");
    expect(await resolveInstanceTunnelToken()).toBe("env-token");
    expect(await resolveInstanceConnectHostname()).toBe("env.example.com");
    setEnv(undefined, undefined);
    expect(await resolveInstanceTunnelToken()).toBeUndefined();
    expect(await resolveInstanceConnectHostname()).toBeNull();
  });

  it("uses the env when nothing was bound from the settings page", async () => {
    setEnv("env-token", "env.example.com");
    expect(await resolveInstanceTunnelToken()).toBe("env-token");
    expect(await resolveInstanceConnectHostname()).toBe("env.example.com");
  });

  it("rejects malformed stored hostnames", async () => {
    store.getConnectHostname.mockResolvedValue("https://bad.example.com/path");
    store.getConnectBoundEnv.mockResolvedValue(fingerprintOf(undefined, undefined));
    expect(await resolveInstanceConnectHostname()).toBeNull();
  });

  it("keeps a malformed non-empty env hostname authoritative over an older binding", async () => {
    store.getConnectHostname.mockResolvedValue("valid.example.com");
    store.getConnectBoundEnv.mockResolvedValue(fingerprintOf(undefined, undefined));
    setEnv(undefined, "https://bad.example.com/path");
    expect(await resolveInstanceConnectHostname()).toBeNull();
  });
});
