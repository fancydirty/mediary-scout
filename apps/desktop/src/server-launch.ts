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
    // Real-product adapter DEFAULTS (mirror the container's docker-compose env) so a
    // fresh desktop performs real acquisitions instead of running the fake executor +
    // demo search. Placed BEFORE the baseEnv spread so a developer can override them
    // (e.g. MEDIA_TRACK_STORAGE_ADAPTER=fake) from the launching shell.
    // storage=115 is "live storage mode"; the actual brand (115/quark/guangya) is
    // resolved per-drive from the DB. agent=vercel-ai is required whenever storage=115
    // or workflow=pansou (validateRuntimeConfig); the LLM model is built lazily from
    // per-account DB settings, so a keyless/driveless desktop still BOOTS and idles.
    MEDIA_TRACK_SEARCH_PROVIDER: "tmdb",
    MEDIA_TRACK_WORKFLOW_ADAPTER: "pansou",
    MEDIA_TRACK_STORAGE_ADAPTER: "115",
    MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai",
    ...input.baseEnv,
    // Desktop-ESSENTIAL keys — always win over baseEnv (a stray env must never
    // redirect the DB path or the chosen port, or break the spawned-as-Node contract).
    ELECTRON_RUN_AS_NODE: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(input.port),
    MEDIA_TRACK_SQLITE_PATH: input.sqlitePath,
    // Desktop shell identity — the settings UI reads this (resolveIsDesktop) to
    // show honest PanSou copy: unlike compose, desktop bundles NO PanSou container.
    MEDIA_TRACK_DESKTOP: "1",
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
