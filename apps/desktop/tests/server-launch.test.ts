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
  it("sets SQLite path, loopback host, port, and run-as-node", () => {
    const env = buildServerEnv({ port: 4123, sqlitePath: "/data/app.db", baseEnv: { EXISTING: "keep" } });
    expect(env.MEDIA_TRACK_SQLITE_PATH).toBe("/data/app.db");
    expect(env.PORT).toBe("4123");
    expect(env.HOSTNAME).toBe("127.0.0.1");
    // 巡检零点 bug 的源头特例已退役：per-slot 认领语义下桌面无需任何调度 flag。
    expect(env.MEDIA_TRACK_PATROL_IGNORE_TIME_GATE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.MEDIA_TRACK_DESKTOP).toBe("1"); // desktop shell identity → honest PanSou copy
    expect(env.EXISTING).toBe("keep"); // preserves the base env
  });

  it("defaults to the real-product adapters so the desktop is functional (not fake/demo)", () => {
    // Without these, the spawned server uses the fake storage executor + demo search
    // (adapter defaults to "fake"). Match the container's docker-compose adapters so a
    // fresh desktop performs real 115/quark/guangya acquisitions once a drive is added.
    const env = buildServerEnv({ port: 1, sqlitePath: "/x.db", baseEnv: {} });
    expect(env.MEDIA_TRACK_SEARCH_PROVIDER).toBe("tmdb");
    expect(env.MEDIA_TRACK_WORKFLOW_ADAPTER).toBe("pansou");
    expect(env.MEDIA_TRACK_STORAGE_ADAPTER).toBe("115");
    expect(env.MEDIA_TRACK_AGENT_ADAPTER).toBe("vercel-ai"); // required when storage=115 (validateRuntimeConfig)
  });

  it("lets the launching env override an adapter default, but never the desktop-essential keys", () => {
    const env = buildServerEnv({
      port: 9,
      sqlitePath: "/x.db",
      baseEnv: {
        MEDIA_TRACK_STORAGE_ADAPTER: "fake", // a dev may force fake mode
        MEDIA_TRACK_SQLITE_PATH: "/hijack.db", // must NOT win over the desktop path
        PORT: "1234", // must NOT win over the chosen port
      },
    });
    expect(env.MEDIA_TRACK_STORAGE_ADAPTER).toBe("fake"); // override honored
    expect(env.MEDIA_TRACK_SQLITE_PATH).toBe("/x.db"); // essential key wins
    expect(env.PORT).toBe("9"); // essential key wins
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
