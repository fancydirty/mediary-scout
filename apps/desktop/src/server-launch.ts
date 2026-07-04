import net from "node:net";

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export function buildServerEnv(input: { port: number; sqlitePath: string; baseEnv: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return {
    ...input.baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(input.port),
    MEDIA_TRACK_SQLITE_PATH: input.sqlitePath,
    MEDIA_TRACK_PATROL_IGNORE_TIME_GATE: "1",
  };
}

export async function waitForHealthy(input: { probe: () => Promise<boolean>; timeoutMs: number; intervalMs: number }): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await input.probe();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() >= deadline) throw new Error("server health check timed out");
    await new Promise((r) => setTimeout(r, input.intervalMs));
  }
}

/** An HTTP probe against the loopback server root; any non-5xx status = healthy. */
export function httpProbe(url: string): () => Promise<boolean> {
  return async () => {
    try {
      const res = await fetch(url);
      return res.status >= 200 && res.status < 500;
    } catch {
      return false;
    }
  };
}

/** Resolve the Next standalone entry: packaged → resources/app path; dev → local build. */
export function resolveServerEntry(input: { isPackaged: boolean; resourcesPath: string; repoRoot: string }): string {
  return input.isPackaged
    ? `${input.resourcesPath}/app/apps/web/server.js`
    : `${input.repoRoot}/apps/web/.next/standalone/apps/web/server.js`;
}
