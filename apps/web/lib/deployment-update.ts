export type DeploymentKind = "container" | "desktop" | "web" | "unknown";

export interface DeploymentUpdateState {
  kind: DeploymentKind;
  currentCommit: string | null;
  latestCommit: string | null;
  currentShort: string | null;
  latestShort: string | null;
  behind: boolean | null;
  reason: "demo" | "desktop" | "missing_current" | "probe_failed" | "ok";
}

export interface RemoteCommitFetcher {
  (): Promise<string | null>;
}

const COMMIT_RE = /^[0-9a-f]{40}$/i;

export function normalizeCommit(value: string | null | undefined): string | null {
  const commit = value?.trim().toLowerCase() ?? "";
  return COMMIT_RE.test(commit) ? commit : null;
}

export function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/**
 * Self-host containers can tell the user when main has moved beyond the image's
 * BUILD_COMMIT. The UI never asks the web container to self-upgrade (no Docker
 * socket); it gives the owner an auditable instruction for their local agent.
 */
export async function getDeploymentUpdateState(input: {
  demo: boolean;
  desktop: boolean;
  currentCommit: string | null | undefined;
  fetchLatest: RemoteCommitFetcher;
}): Promise<DeploymentUpdateState> {
  const currentCommit = normalizeCommit(input.currentCommit);
  const base = {
    currentCommit,
    currentShort: shortCommit(currentCommit),
    latestCommit: null,
    latestShort: null,
  };
  if (input.demo) {
    return { ...base, kind: "web", behind: null, reason: "demo" };
  }
  if (input.desktop) {
    return { ...base, kind: "desktop", behind: null, reason: "desktop" };
  }
  if (!currentCommit) {
    return { ...base, kind: "container", behind: null, reason: "missing_current" };
  }
  let latestCommit: string | null;
  try {
    latestCommit = normalizeCommit(await input.fetchLatest());
  } catch {
    latestCommit = null;
  }
  if (!latestCommit) {
    return { ...base, kind: "container", behind: null, reason: "probe_failed" };
  }
  return {
    ...base,
    latestCommit,
    latestShort: shortCommit(latestCommit),
    kind: "container",
    // "not latest main", not necessarily strictly behind: a custom/fork build can
    // differ without main being ahead. The UI copy stays conservative.
    behind: latestCommit !== currentCommit,
    reason: "ok",
  };
}

/** Instruction copied to the owner's local coding/deploy agent. Deliberately
 *  asks for the repo's own self-verifying deploy script and health proof instead
 *  of a blind `docker compose up` — this is the safe "almost in-place update". */
export function buildContainerUpgradePrompt(input: {
  currentShort: string;
  latestShort: string;
}): string {
  return [
    "请在这台部署机的 Mediary Scout 仓库目录执行一次安全升级：",
    `1. 确认当前服务 commit 是 ${input.currentShort}，远端 main 目标是 ${input.latestShort}。`,
    "2. 运行 `git pull --ff-only`，然后执行 `./scripts/deploy.sh`。",
    "3. deploy.sh 必须证明运行容器 BUILD_COMMIT 等于新 HEAD，并通过 DB-backed /api/health；如果失败，停止并报告日志，不要绕过校验。",
    "4. 完成后检查 `docker compose ps` 与 `/api/health`，告诉我升级结果。",
  ].join("\n");
}

export const GITHUB_MAIN_COMMITS_URL =
  "https://github.com/fancydirty/mediary-scout/commits/main";
