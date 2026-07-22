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

/** Probe upstream main once per render with a short deadline. Failure is
 *  intentionally non-fatal — an offline instance must still open Settings. */
export async function fetchLatestMainCommit(
  fetchImpl: typeof fetch = fetch,
  url = DEFAULT_MAIN_COMMITS_URL,
): Promise<string | null> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "mediary-scout-update-check" },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { sha?: unknown };
  return typeof body.sha === "string" ? normalizeCommit(body.sha) : null;
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
