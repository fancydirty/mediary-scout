import { readFile } from "node:fs/promises";
import {
  getDeploymentUpdateState,
  normalizeCommit,
  type RemoteCommitFetcher,
} from "./deployment-update";
import { resolveIsDesktop } from "./workflow-runtime";
import { isDemoMode } from "./demo-mode";

const DEFAULT_MAIN_COMMITS_URL =
  "https://api.github.com/repos/fancydirty/mediary-scout/commits/main";
const REMOTE_PROBE_TTL_MS = 10 * 60 * 1000;

let remoteProbeCache:
  | { checkedAt: number; commit: string | null }
  | null = null;

async function readBuildCommit(): Promise<string | null> {
  try {
    return normalizeCommit(await readFile("/app/BUILD_COMMIT", "utf8"));
  } catch {
    // Docker runner keeps the stamp at /app/BUILD_COMMIT; dev / desktop may not.
    try {
      return normalizeCommit(await readFile("BUILD_COMMIT", "utf8"));
    } catch {
      return null;
    }
  }
}

/** Probe upstream main with a short in-process TTL. Failure is intentionally
 *  non-fatal — an offline instance must still open Settings — but frequent page
 *  renders must not burn GitHub's anonymous rate limit. */
export async function fetchLatestMainCommit(
  fetchImpl: typeof fetch = fetch,
  url = DEFAULT_MAIN_COMMITS_URL,
): Promise<string | null> {
  if (remoteProbeCache && Date.now() - remoteProbeCache.checkedAt < REMOTE_PROBE_TTL_MS) {
    return remoteProbeCache.commit;
  }
  let commit: string | null = null;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "mediary-scout-update-check" },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json()) as { sha?: unknown };
      commit = typeof body.sha === "string" ? normalizeCommit(body.sha) : null;
    }
  } catch {
    // Offline/rate-limited instance: keep Settings usable and cache the failure
    // briefly so every refresh doesn't wait out another 5s timeout.
  }
  remoteProbeCache = { checkedAt: Date.now(), commit };
  return commit;
}

export function resetDeploymentUpdateProbeCacheForTests() {
  remoteProbeCache = null;
}

export async function loadDeploymentUpdateState(
  fetchLatest: RemoteCommitFetcher = () => fetchLatestMainCommit(),
) {
  return getDeploymentUpdateState({
    demo: isDemoMode(),
    desktop: resolveIsDesktop(),
    currentCommit: await readBuildCommit(),
    fetchLatest,
  });
}
