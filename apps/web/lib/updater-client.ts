import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type UpdaterPhase =
  | "idle"
  | "waiting"
  | "backing_up"
  | "building"
  | "switching"
  | "verifying"
  | "done"
  | "rolled_back"
  | "failed";

export interface UpdaterStatus {
  phase: UpdaterPhase;
  targetTag: string | null;
  fromCommit: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** One human sentence for the UI. */
  message: string;
  /** Last ~40 lines of the update log, shown behind 「查看详情」. */
  logTail: string;
  /** HEAD of the deploy folder, sent with every status. The version source for
   *  instances built without GIT_SHA — the documented `docker compose up -d` path. */
  repoCommit?: string | null;
  /** The deploy folder is not back on the serving commit yet after a cut-off update. */
  pendingRestore?: boolean;
  /** A rollback failed: what is running is unknown until a person runs deploy.sh. */
  needsManualRecovery?: boolean;
  /** The deploy folder was changed during an update that did not swap (exit 60): its HEAD is
   *  not what serves until the person's own deploy finishes. */
  servingUnknown?: boolean;
}

/** The deploy folder's HEAD, only when it is the commit being served: no update is
 *  running (it checks out the new tag before the swap) and no checkout is pending. */
export function servingRepoCommit(status: UpdaterStatus | null): string | null {
  if (!status || status.pendingRestore === true || status.needsManualRecovery === true || status.servingUnknown === true) {
    return null;
  }
  if (!["idle", "done", "rolled_back", "failed"].includes(status.phase)) return null;
  const commit = status.repoCommit;
  return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

const DEFAULT_STATE_DIR = "/updater-state";

interface ClientOptions {
  stateDir?: string;
  fetchImpl?: typeof fetch;
}

function updaterUrl(): string {
  return process.env.MEDIA_TRACK_UPDATER_URL ?? "http://updater:8787";
}

async function readToken(stateDir: string): Promise<string | null> {
  try {
    return (await readFile(join(stateDir, "token"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function sameToken(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function isUpdaterStatus(value: unknown): value is UpdaterStatus {
  return Boolean(value) && typeof value === "object" && typeof (value as { phase?: unknown }).phase === "string";
}

/** Whether this instance has an updater at all: its token volume is mounted. False on an
 *  old compose file (and on desktop). An installed updater may still not answer. */
export async function isUpdaterInstalled(options: ClientOptions = {}): Promise<boolean> {
  return (await readToken(options.stateDir ?? DEFAULT_STATE_DIR)) !== null;
}

/** Null = no updater (old compose file, desktop, or it did not answer). */
export async function getUpdaterStatus(options: ClientOptions = {}): Promise<UpdaterStatus | null> {
  const token = await readToken(options.stateDir ?? DEFAULT_STATE_DIR);
  if (!token) return null;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${updaterUrl()}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isUpdaterStatus(body) ? body : null;
  } catch {
    return null;
  }
}

export async function requestUpdate(
  tag: string,
  options: ClientOptions = {},
): Promise<{ ok: true } | { ok: false; reason: "no_updater" | "busy" | "needs_recovery" | "serving_unknown" | "bad_tag" | "unreachable" }> {
  const token = await readToken(options.stateDir ?? DEFAULT_STATE_DIR);
  if (!token) return { ok: false, reason: "no_updater" };
  try {
    const response = await (options.fetchImpl ?? fetch)(`${updaterUrl()}/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tag }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 202) return { ok: true };
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { reason?: unknown } | null;
      if (body?.reason === "needs_recovery") return { ok: false, reason: "needs_recovery" };
      if (body?.reason === "serving_unknown") return { ok: false, reason: "serving_unknown" };
      return { ok: false, reason: "busy" };
    }
    if (response.status === 400) return { ok: false, reason: "bad_tag" };
    return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

export type StartTunnelResult =
  | { ok: true }
  | { ok: false; reason: "no_updater" | "busy" | "invalid_input" | "pull_failed" | "compose_failed"; logTail?: string };

const CONNECTION_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function isConnectionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && CONNECTION_FAILURE_CODES.has(code);
}

/** Ask the updater to persist the Connect tunnel credentials and start cloudflared. */
export async function startTunnel(
  input: { token: string; hostname: string },
  options: ClientOptions = {},
): Promise<StartTunnelResult> {
  const updaterToken = await readToken(options.stateDir ?? DEFAULT_STATE_DIR);
  if (!updaterToken) return { ok: false, reason: "no_updater" };

  const signal = AbortSignal.timeout(290_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${updaterUrl()}/tunnel`, {
      method: "POST",
      headers: { authorization: `Bearer ${updaterToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });

    if (response.status === 200) return { ok: true };
    if (response.status === 401 || response.status === 404) return { ok: false, reason: "no_updater" };
    if (response.status === 409) return { ok: false, reason: "busy" };
    if (response.status === 400) return { ok: false, reason: "invalid_input" };
    if (response.status === 502) {
      const body = (await response.json().catch(() => null)) as { reason?: unknown; logTail?: unknown } | null;
      if (body?.reason === "pull_failed" || body?.reason === "compose_failed") {
        return {
          ok: false,
          reason: body.reason,
          ...(typeof body.logTail === "string" ? { logTail: body.logTail } : {}),
        };
      }
    }
    return { ok: false, reason: "compose_failed" };
  } catch (error) {
    return { ok: false, reason: isConnectionFailure(error) ? "no_updater" : "compose_failed" };
  }
}

/** The updater calls /api/update/busy with the same token; verify it here. */
export async function isUpdaterToken(header: string | null, options: ClientOptions = {}): Promise<boolean> {
  const token = await readToken(options.stateDir ?? DEFAULT_STATE_DIR);
  if (!token || !header?.startsWith("Bearer ")) return false;
  return sameToken(header.slice("Bearer ".length), token);
}
