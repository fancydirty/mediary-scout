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

/** Instruction copied to the owner's LOCAL coding agent (the agent runs on the
 *  user's laptop; Mediary Scout is deployed on a DIFFERENT machine). The prompt
 *  therefore never assumes repo/container access: the agent must SSH over, and
 *  every step is either verified or a hard stop — the deploy script's own
 *  self-check (BUILD_COMMIT == HEAD + DB-backed /api/health) is the gate. The
 *  page `origin` is threaded in by the caller (request headers) so the agent can
 *  derive the deploy host and re-probe health from outside. */
export function buildContainerUpgradePrompt(input: {
  currentShort: string;
  latestShort: string;
  origin: string;
}): string {
  return [
    `你在我的笔记本上，Mediary Scout 部署在另一台机器（我通过 ${input.origin} 访问它）。`,
    `1. 从 ${input.origin} 推出部署机的 SSH 目标（主机名/IP，端口与用户不确定就问我），先 ssh 上去；连不上就停下问我，绝不猜地址乱试。`,
    "2. 在部署机上 `docker ps` 找到 Mediary Scout 的 web 容器。",
    '3. `docker inspect <容器> --format \'{{index .Config.Labels "com.docker.compose.project.working_dir"}}\'` 拿到仓库目录并 cd 进去。',
    `4. \`git rev-parse --short HEAD\` 必须等于 ${input.currentShort}（当前运行版本）；不等就停下报告，不要继续。`,
    `5. \`git pull --ff-only\` 更新到 ${input.latestShort}，然后执行 \`./scripts/deploy.sh\`。`,
    "6. deploy.sh 自检必须全过：运行容器 BUILD_COMMIT == 新 HEAD，且 /api/health（走真实 DB）正常；任一失败即视为升级失败。",
    `7. 最后复核 \`docker compose ps\` 全部就绪，且 \`curl -fsS ${input.origin}/api/health\` 正常。`,
    "任何一步失败：立即停止，不做任何破坏性操作（不 force push、不删容器/卷、不 docker system prune），把完整日志贴给我。",
  ].join("\n");
}

export const GITHUB_MAIN_COMMITS_URL =
  "https://github.com/fancydirty/mediary-scout/commits/main";
