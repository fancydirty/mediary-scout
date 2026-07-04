import { describe, it, expect } from "vitest";
import { pickFreePort, waitForHealthy, buildServerEnv, httpProbe, resolveServerEntry } from "../src/server-launch.js";

describe("pickFreePort", () => {
  it("returns a usable positive port", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe("buildServerEnv", () => {
  it("sets SQLite path, loopback host, port, patrol gate, and run-as-node", () => {
    const env = buildServerEnv({ port: 4123, sqlitePath: "/data/app.db", baseEnv: { EXISTING: "keep" } });
    expect(env.MEDIA_TRACK_SQLITE_PATH).toBe("/data/app.db");
    expect(env.PORT).toBe("4123");
    expect(env.HOSTNAME).toBe("127.0.0.1");
    expect(env.MEDIA_TRACK_PATROL_IGNORE_TIME_GATE).toBe("1");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.EXISTING).toBe("keep"); // preserves the base env
  });
});

describe("waitForHealthy", () => {
  it("resolves once the probe returns true", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 20);
    await expect(waitForHealthy({ probe: async () => ready, timeoutMs: 500, intervalMs: 5 })).resolves.toBeUndefined();
  });
  it("rejects when the probe never becomes true before the timeout", async () => {
    await expect(waitForHealthy({ probe: async () => false, timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(/timed out/);
  });
  it("treats a throwing probe as not-ready (does not reject early)", async () => {
    let calls = 0;
    const probe = async () => { calls++; if (calls < 3) throw new Error("connrefused"); return true; };
    await expect(waitForHealthy({ probe, timeoutMs: 500, intervalMs: 5 })).resolves.toBeUndefined();
  });
});

describe("httpProbe", () => {
  it("returns false for an unreachable host", async () => {
    const probe = httpProbe("http://127.0.0.1:1/");
    await expect(probe()).resolves.toBe(false);
  });
});

describe("resolveServerEntry", () => {
  it("points at the packaged resources path when packaged", () => {
    expect(resolveServerEntry({ isPackaged: true, resourcesPath: "/App/Contents/Resources", repoRoot: "/repo" }))
      .toBe("/App/Contents/Resources/app/apps/web/server.js");
  });
  it("points at the local standalone build in dev", () => {
    expect(resolveServerEntry({ isPackaged: false, resourcesPath: "/x", repoRoot: "/repo" }))
      .toBe("/repo/apps/web/.next/standalone/apps/web/server.js");
  });
});
