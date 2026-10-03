// Mediary Scout updater: the only process with Docker access. Listens on the compose
// network only (no published port). One job at a time; status persisted to the state dir.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { writeTunnelEnv } from "./tunnel-env.mjs";

// Same shape as apps/web/lib/release-version.ts TAG_RE, plus that file's calendar check
// (v2026.02.31 matches the pattern and is still not a date). Keep the two in sync.
const TAG_RE = /^v(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?:\.([2-9]|[1-9]\d+))?$/;

const PHASE_MESSAGES = {
  idle: "",
  waiting: "有任务在进行，等它结束再继续。",
  backing_up: "正在备份数据库。",
  building: "正在构建新版本，构建期间一切照常。",
  switching: "正在替换，网页会短暂打不开，完成后自动刷新。",
  verifying: "正在检查新版本是否正常。",
  done: "更新完成。",
  rolled_back: "新版本没通过自检，已自动回到原来的版本，一切照常。",
  failed: "更新没成功，原来的版本仍在运行。",
};

const TERMINAL_PHASES = new Set(["idle", "done", "rolled_back", "failed"]);
const STEP_PHASES = new Set(["waiting", "backing_up", "building", "switching", "verifying"]);
const INTERRUPTED_MESSAGE = "更新被中断了，原来的版本仍在运行。";
const RESUME_ROLLBACK_MESSAGE = "更新中途被打断，正在回到原来的版本。";
const ROLLING_BACK_MESSAGE = "新版本没通过自检，正在回到原来的版本，网页会短暂打不开。";
const RECOVERED_MESSAGE = "上次更新没成功，之后已经恢复正常，可以再次更新。";
const RESTORE_FOLDER_CHANGED_MESSAGE =
  "更新被中断了，之后部署目录被人手动换过版本，更新助手没有再改动它。请在部署目录运行 ./scripts/deploy.sh，跑起来之后就能再更新。";
const MAX_BODY = 1024;
const TUNNEL_MAX_BODY = 8192;
// Below 300 s on purpose: the web calls /tunnel with Node's fetch, which stops waiting for
// response headers after 300 s (undici headersTimeout) whatever its AbortSignal says. A slower
// image pull ends as pull_failed/compose_failed with a DOCKER_MIRROR hint, and a retry resumes
// from the layers already downloaded.
const TUNNEL_COMPOSE_TIMEOUT_MS = 270_000;
const TUNNEL_TOKEN_RE = /^[A-Za-z0-9+/=_-]{20,4096}$/;
const TUNNEL_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PULL_MARKERS = [
  "failed to resolve reference",
  "pull access denied",
  "tls handshake timeout",
  "connection reset by peer",
  "i/o timeout",
  "toomanyrequests",
];
const PROJECT_LOOKUP_FAILURE = "读不到 compose 项目名，没有启动隧道。";
const ENV_WRITE_FAILURE = "写入 .env 失败，配置没有改动。";

export function isReleaseTag(value) {
  if (typeof value !== "string") return false;
  const match = TAG_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

function idleStatus() {
  return {
    phase: "idle",
    targetTag: null,
    fromCommit: null,
    toCommit: null,
    startedAt: null,
    finishedAt: null,
    message: "",
    logTail: "",
  };
}

/** Only a 200 JSON `{"busy": false}` means idle. A failed or odd answer counts as busy
 *  (keep waiting) and is logged: starting on a failed probe could cut running tasks. */
export function interpretBusyResponse(status, body) {
  if (status !== 200) {
    return {
      busy: true,
      failed: true,
      log: status ? `==> BUSY_CHECK http ${status}` : "==> BUSY_CHECK unreachable",
    };
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.busy === "boolean") return { busy: parsed.busy, failed: false };
  } catch {
    // fall through
  }
  return { busy: true, failed: true, log: "==> BUSY_CHECK unparsable" };
}

export function readLimitedBody(stream, limit = MAX_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    stream.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        finish({ error: "too_big" });
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () => finish({ body: Buffer.concat(chunks).toString("utf8") }));
    stream.on("error", () => finish({ error: "too_big" }));
  });
}

function redactToken(output, token) {
  const text = typeof output === "string" ? output : "";
  if (typeof token !== "string" || token.length === 0) return text;
  return text.split(token).join("[redacted]");
}

function classifyComposeOutput(output) {
  const haystack = output.toLowerCase();
  return PULL_MARKERS.some((marker) => haystack.includes(marker)) ? "pull_failed" : "compose_failed";
}

function lastLines(output, count) {
  const text = String(output).replace(/\n$/, "");
  if (text.length === 0) return "";
  return text.split("\n").slice(-count).join("\n");
}

/** Same inspect the update script uses, so the tunnel joins this stack instead of starting a second one. */
export async function readComposeProject(dockerText, host = hostname()) {
  const raw = await dockerText([
    "inspect",
    "-f",
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    host,
  ]);
  const project = String(raw ?? "").trim();
  if (!project) throw new Error("compose project unavailable");
  return project;
}

export function runComposeTunnel(args, deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const timeoutMs = deps.timeoutMs ?? TUNNEL_COMPOSE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawnFn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdin?.end();
    let output = "";
    let settled = false;
    let timer;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      resolve({ code, output, timedOut });
    };
    timer = setTimer(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      finish(1, true);
    }, timeoutMs);
    const take = (chunk) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => finish(1, false));
    child.on("close", (code) => finish(typeof code === "number" ? code : 1, false));
  });
}

export async function performTunnel(input, deps = {}) {
  const repoDir = deps.repoDir ?? process.env.UPDATER_REPO_DIR ?? "/repo";
  let project;
  try {
    project = await deps.composeProject();
    if (typeof project !== "string" || project.trim() === "") throw new Error("empty project");
    project = project.trim();
  } catch {
    return { ok: false, reason: "compose_failed", logTail: PROJECT_LOOKUP_FAILURE };
  }
  try {
    await deps.writeTunnelEnv(repoDir, { token: input.token, hostname: input.hostname });
  } catch {
    return { ok: false, reason: "compose_failed", logTail: ENV_WRITE_FAILURE };
  }
  // --no-deps keeps web up: recreating it would cut off a download that is still running.
  const argv = [
    "compose",
    "-p",
    project,
    "--project-directory",
    repoDir,
    "--profile",
    "tunnel",
    "up",
    "-d",
    "--no-deps",
    "cloudflared",
  ];
  let result;
  try {
    result = await deps.runCompose(argv);
  } catch {
    return { ok: false, reason: "compose_failed", logTail: "启动 cloudflared 失败。" };
  }
  const output = redactToken(result && result.output, input.token);
  const timedOut = Boolean(result && result.timedOut);
  const code = result && typeof result.code === "number" ? result.code : 1;
  if (code === 0 && !timedOut) return { ok: true };
  return { ok: false, reason: classifyComposeOutput(output), logTail: lastLines(output, 40) };
}

function parseTunnelBody(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (typeof value.token !== "string" || typeof value.hostname !== "string") return null;
  if (!TUNNEL_TOKEN_RE.test(value.token) || !TUNNEL_HOSTNAME_RE.test(value.hostname)) return null;
  return { token: value.token, hostname: value.hostname };
}

/** Write-then-rename in the same directory: a kill mid-write never leaves a truncated
 *  status.json, which would drop the recorded commit a rollback needs. */
function writeStatusFile(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function createUpdater(opts) {
  const statusFile = join(opts.stateDir, "status.json");
  let status = idleStatus();
  if (existsSync(statusFile)) {
    try {
      const loaded = JSON.parse(readFileSync(statusFile, "utf8"));
      if (loaded && typeof loaded === "object") status = { ...idleStatus(), ...loaded };
    } catch {
      status = idleStatus();
    }
  }
  // A job cut off by an updater restart is not running any more. Where it stopped
  // decides what to do: after the swap began, the new version may be the one
  // serving, so go back to the recorded commit; before it, the old version never
  // stopped, but the deploy folder may be left on the new tag, so check it back out.
  // `pendingRestore` stays in the file until the restore succeeds, so a second restart
  // retries it; the phase already says the update failed and the old version kept running.
  let resume = null;
  const from = typeof status.fromCommit === "string" && /^[0-9a-f]{40}$/.test(status.fromCommit) ? status.fromCommit : null;
  // The commit the interrupted update was moving to, when it was recorded: passed on so the
  // resume can tell a deploy folder still on the new tag from one a person has changed since.
  const to = typeof status.toCommit === "string" && /^[0-9a-f]{40}$/.test(status.toCommit) ? status.toCommit : null;
  if (!TERMINAL_PHASES.has(status.phase)) {
    const swapStarted = status.phase === "switching" || status.phase === "verifying";
    if (from && swapStarted) {
      resume = { mode: "rollback", commit: from, to };
      status = { ...status, phase: "switching", message: RESUME_ROLLBACK_MESSAGE, finishedAt: null };
    } else {
      if (from) resume = { mode: "restore", commit: from, to };
      status = {
        ...status,
        phase: "failed",
        message: INTERRUPTED_MESSAGE,
        finishedAt: opts.now(),
        ...(from ? { pendingRestore: true } : {}),
      };
    }
    writeStatusFile(statusFile, status);
  } else if (status.pendingRestore === true && from) {
    resume = { mode: "restore", commit: from, to };
  }
  let job = null;
  // Seeded from the saved tail, so a recovery after a restart adds to the lines that
  // explain the interruption instead of replacing them. A new update starts it over.
  const log = typeof status.logTail === "string" && status.logTail ? status.logTail.split("\n") : [];

  const save = (patch) => {
    status = { ...status, ...patch };
    if (patch.phase && !Object.prototype.hasOwnProperty.call(patch, "message")) {
      status.message = PHASE_MESSAGES[patch.phase] ?? status.message;
    }
    status.logTail = log.slice(-40).join("\n");
    writeStatusFile(statusFile, status);
  };

  // Whether the last probe failed, so the give-up message can say why.
  let lastProbeFailed = false;
  async function acquisitionsBusy() {
    const result = await opts.acquisitionsRunning();
    if (typeof result === "boolean") {
      lastProbeFailed = false;
      return result;
    }
    const code = result && typeof result.status === "number" ? result.status : 0;
    const body = result && typeof result.body === "string" ? result.body : "";
    const interpreted = interpretBusyResponse(code, body);
    lastProbeFailed = interpreted.failed;
    if (interpreted.log && log.at(-1) !== interpreted.log) {
      log.push(interpreted.log);
      save({});
    }
    return interpreted.busy;
  }

  async function run(tag) {
    const { pendingRestore: _stale, ...fresh } = status;
    status = fresh;
    log.length = 0;
    save({ phase: "waiting", targetTag: tag, fromCommit: null, toCommit: null, startedAt: opts.now(), finishedAt: null });
    let waited = 0;
    while (await acquisitionsBusy()) {
      if (waited >= opts.waitLimitMs) {
        const message = lastProbeFailed ? "连不上网页服务，这次先不更新了。" : "有任务一直没结束，这次先不更新了。";
        save({ phase: "failed", message, finishedAt: opts.now() });
        return;
      }
      await opts.sleep(opts.waitPollMs);
      waited += opts.waitPollMs;
    }
    let buildFailed = false;
    // Set once this job has saved switching or verifying. From then on the saved phase never
    // goes back to a pre-swap one: a restart during the rollback would read it as "the old
    // version never stopped" and only check the folder out, leaving the failed version up.
    let pastSwap = false;
    const code = await opts.runUpdate(tag, (line) => {
      log.push(line);
      const patch = {};
      if (line.startsWith("==> BUILD_FAILED")) buildFailed = true;
      const from = /^==> FROM ([0-9a-f]{40})/.exec(line);
      if (from) patch.fromCommit = from[1];
      const to = /^==> TO ([0-9a-f]{40})/.exec(line);
      if (to) patch.toCommit = to[1];
      if (line.startsWith("==> VERIFY_FAILED") || line.startsWith("==> UP_FAILED")) {
        pastSwap = true;
        Object.assign(patch, { phase: "switching", message: ROLLING_BACK_MESSAGE });
      }
      const step = /^==> STEP (\w+)/.exec(line);
      if (step && STEP_PHASES.has(step[1])) {
        const swapPhase = step[1] === "switching" || step[1] === "verifying";
        if (swapPhase) pastSwap = true;
        if (swapPhase || !pastSwap) patch.phase = step[1];
      }
      // Every line, as resumeAfterRestart does: the saved tail is what a restart starts from,
      // and the lines right before an interruption are the ones that explain it.
      save(patch);
    });
    const outcome =
      code === 0
        ? { phase: "done" }
        : code === 10
          ? buildFailed
            ? { phase: "rolled_back", message: "新版本构建没成功，原来的版本一直在运行，没有受影响。" }
            : { phase: "rolled_back" }
          : code === 20
            ? {
                phase: "failed",
                message: "新版本没通过自检，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。",
                needsManualRecovery: true,
              }
            : code === 30
              ? {
                  phase: "failed",
                  message:
                    "部署目录里有改过的文件，自动更新不会覆盖它们。请先还原或提交这些改动（git status 可以看到），再更新。",
                }
              : code === 40
                ? { phase: "failed", message: "替换前没能让网页暂停开始新任务，这次先不更新了，原来的版本一直在运行。" }
                : code === 50
                  ? // Still serving the old version, but the checkout is left on the new tag: retry it.
                    { phase: "failed", message: INTERRUPTED_MESSAGE, pendingRestore: true }
                  : code === 60
                    ? {
                        phase: "failed",
                        message:
                          "更新途中部署目录被人手动换过版本，这次先不更新了，更新助手没有再改动它。请在部署目录运行 ./scripts/deploy.sh，跑起来之后就能再更新。",
                        // The container was not swapped: the folder's HEAD is not what serves.
                        servingUnknown: true,
                      }
                    : code === 70
                      ? {
                          phase: "failed",
                          message:
                            // .env is read when the container is created: a new proxy needs `up -d`.
                            "没能从 GitHub 下载新版本，原来的版本一直在运行。网络不通时，可以在 .env 里设置 HTTPS_PROXY，在部署目录运行 docker compose up -d 让它生效，再点更新。",
                        }
                      : code === 80
                        ? { phase: "failed", message: "正在进行一次手动部署，这次先不更新了，原来的版本一直在运行。手动部署完成后可以再点更新。" }
                        : { phase: "failed" };
    save({ ...outcome, finishedAt: opts.now() });
    if (code === 50 && status.fromCommit) {
      await resumeAfterRestart({ mode: "restore", commit: status.fromCommit, to: status.toCommit });
    }
  }

  async function resumeAfterRestart({ mode, commit, to }) {
    // Pass the "to" commit only when it is a real commit id, so the script can tell a folder
    // still on the new tag from one a person changed; the script treats a missing one as today.
    const args = typeof to === "string" && /^[0-9a-f]{40}$/.test(to) ? [mode, commit, to] : [mode, commit];
    const code = await opts.runUpdate(args, (line) => {
      log.push(line);
      save({});
    });
    if (mode === "restore") {
      // The status already says the update was cut off and the old version kept running.
      if (code === 0) {
        const { pendingRestore: _done, ...rest } = status;
        status = rest;
        save({});
      } else if (code === 60) {
        // Somebody changed the folder since: nothing left to restore, and the folder's HEAD is
        // not what serves. New updates wait until recheckRecovery sees the web serving it.
        const { pendingRestore: _gone, ...rest } = status;
        status = { ...rest, servingUnknown: true };
        save({ message: RESTORE_FOLDER_CHANGED_MESSAGE });
      } else {
        log.push("==> RESTORE_FAILED");
        save({});
      }
      return;
    }
    save({
      ...(code === 10
        ? { phase: "rolled_back", message: "更新中途被打断，已自动回到原来的版本，一切照常。" }
        : code === 60
          ? {
              phase: "failed",
              message:
                "更新中途部署目录被人手动换过版本，更新助手没有再改动它。如果网页不正常，请在部署目录运行 ./scripts/deploy.sh。",
              needsManualRecovery: true,
            }
          : {
              phase: "failed",
              message: "更新中途被打断，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。",
              needsManualRecovery: true,
            }),
      finishedAt: opts.now(),
    });
  }
  if (resume) {
    job = resumeAfterRestart(resume).finally(() => {
      job = null;
    });
  }

  // A failed rollback needs a person (./scripts/deploy.sh). Once the running web serves the
  // deploy folder's HEAD again, that happened: clear the flag and say so. Runs on its own
  // schedule, so the page stops saying "needs a person" without anyone clicking update.
  let rechecking = false;
  async function recheckRecovery() {
    // Not while a job runs (the web may be half way through a swap), and never two at once:
    // the web probe is a slow docker call. Also clears servingUnknown (exit 60): once the web
    // serves the folder's HEAD, the person's own deploy has finished.
    const manual = status.needsManualRecovery === true;
    if ((!manual && status.servingUnknown !== true) || job || rechecking) return;
    rechecking = true;
    try {
      const head = opts.repoCommit();
      const serving = opts.servingCommit ? await opts.servingCommit() : null;
      if (!head || head !== serving) return;
      const { needsManualRecovery: _cleared, servingUnknown: _known, ...rest } = status;
      status = rest;
      // Both flags come with a message that asks for ./scripts/deploy.sh: that is done now.
      save({ message: RECOVERED_MESSAGE });
    } finally {
      rechecking = false;
    }
  }

  return {
    // repoCommit is read fresh: it is the deploy folder's HEAD, which the web falls back
    // to when its image has no BUILD_COMMIT (built without GIT_SHA).
    status: () => ({ ...status, repoCommit: opts.repoCommit() }),
    recheckRecovery,
    start(tag) {
      if (!isReleaseTag(tag)) return { accepted: false, reason: "bad_tag" };
      if (job) return { accepted: false, reason: "busy" };
      if (status.needsManualRecovery === true) return { accepted: false, reason: "needs_recovery" };
      // The deploy folder is on somebody's own checkout, not on what serves: an update would
      // check a release tag out over it. recheckRecovery clears this once their deploy is up.
      if (status.servingUnknown === true) return { accepted: false, reason: "serving_unknown" };
      // A cut-off update's checkout is not back on the old commit yet: try that again first,
      // from the right commit, and say so. The new update runs only once it worked; if the
      // restore keeps failing, stop and ask for a person rather than update from a wrong tree.
      if (status.pendingRestore === true && typeof status.fromCommit === "string") {
        const commit = status.fromCommit;
        const to = status.toCommit;
        save({ phase: "waiting", message: "正在把部署目录切回原来的版本…", finishedAt: null });
        job = resumeAfterRestart({ mode: "restore", commit, to })
          .then(() => {
            if (status.pendingRestore === true) {
              save({
                phase: "failed",
                message: "部署目录没能切回原来的版本，这次先不更新了。请在部署目录运行 ./scripts/deploy.sh。",
                finishedAt: opts.now(),
              });
              return undefined;
            }
            if (status.servingUnknown === true) {
              save({ phase: "failed", message: RESTORE_FOLDER_CHANGED_MESSAGE, finishedAt: opts.now() });
              return undefined;
            }
            return run(tag);
          })
          .finally(() => {
            job = null;
          });
        return { accepted: true };
      }
      job = run(tag).finally(() => {
        job = null;
      });
      return { accepted: true };
    },
    // Same slot as an update: either job makes the other answer busy. Nothing here is written
    // into the persisted update status.
    tunnel(input) {
      if (job) return { accepted: false, reason: "busy" };
      const done = Promise.resolve()
        .then(() =>
          performTunnel(input, {
            repoDir: opts.repoDir,
            writeTunnelEnv: opts.writeTunnelEnv,
            composeProject: opts.composeProject,
            runCompose: opts.runCompose,
          }),
        )
        .finally(() => {
          job = null;
        });
      job = done;
      return { accepted: true, done };
    },
    idle: () => job ?? Promise.resolve(),
  };
}

function sameToken(presented, expected) {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function createUpdaterHttp(updater, token) {
  return (req, res) => {
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!presented || !sameToken(presented, token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(updater.status()));
      return;
    }
    if (req.method === "POST" && req.url === "/update") {
      readLimitedBody(req, MAX_BODY)
        .then((result) => {
          if (result.error) {
            res.writeHead(400).end();
            return;
          }
          let tag = null;
          try {
            tag = JSON.parse(result.body).tag;
          } catch {
            tag = null;
          }
          const outcome = updater.start(tag);
          const status = outcome.accepted
            ? 202
            : outcome.reason === "busy" || outcome.reason === "needs_recovery" || outcome.reason === "serving_unknown"
              ? 409
              : 400;
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(outcome));
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(400).end();
        });
      return;
    }
    if (req.method === "POST" && req.url === "/tunnel") {
      readLimitedBody(req, TUNNEL_MAX_BODY)
        .then(async (result) => {
          if (result.error) {
            sendJson(res, 400, { ok: false, reason: "invalid_input" });
            return;
          }
          const parsed = parseTunnelBody(result.body);
          if (!parsed) {
            sendJson(res, 400, { ok: false, reason: "invalid_input" });
            return;
          }
          const outcome = updater.tunnel(parsed);
          if (!outcome.accepted) {
            sendJson(res, 409, { ok: false, reason: "busy" });
            return;
          }
          try {
            const applied = await outcome.done;
            if (applied && applied.ok === true) {
              sendJson(res, 200, { ok: true }, parsed.token);
              return;
            }
            const reason = applied && applied.reason === "pull_failed" ? "pull_failed" : "compose_failed";
            const logTail = applied && typeof applied.logTail === "string" ? applied.logTail : "";
            sendJson(res, 502, { ok: false, reason, logTail }, parsed.token);
          } catch {
            sendJson(res, 502, { ok: false, reason: "compose_failed", logTail: ENV_WRITE_FAILURE }, parsed.token);
          }
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(400).end();
        });
      return;
    }
    res.writeHead(404).end();
  };
}

function sendJson(res, status, payload, secret) {
  let body = JSON.stringify(payload);
  if (typeof secret === "string" && secret.length > 0) body = body.split(secret).join("[redacted]");
  res.writeHead(status, { "content-type": "application/json" }).end(body);
}

/** Runs run-update.sh with a release tag, or with ["rollback" | "restore", commit]. */
function shellRunner(scriptPath) {
  return (args, onLine) =>
    new Promise((resolve) => {
      const argv = Array.isArray(args) ? args : [args];
      const child = spawn("sh", [scriptPath, ...argv], { cwd: process.env.UPDATER_REPO_DIR ?? "/repo" });
      let buffer = "";
      const feed = (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) onLine(line);
      };
      child.stdout.on("data", feed);
      child.stderr.on("data", feed);
      child.on("close", (code) => {
        if (buffer) onLine(buffer);
        resolve(code ?? 20);
      });
    });
}

function loadToken(stateDir) {
  const file = join(stateDir, "token");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o644 });
  return readFileSync(file, "utf8").trim();
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const stateDir = process.env.UPDATER_STATE_DIR ?? "/state";
  mkdirSync(stateDir, { recursive: true });
  const token = loadToken(stateDir);
  const webBase = process.env.UPDATER_WEB_BASE ?? "http://web:3000";
  const execFileAsync = promisify(execFile);
  // stdin is closed at once, as the old synchronous call did with stdio "ignore": compose
  // exec forwards stdin by default. stderr is captured, so compose's variable warnings
  // stay out of the log.
  const dockerText = async (args) => {
    const pending = execFileAsync("docker", args, { encoding: "utf8", timeout: 15_000 });
    pending.child.stdin?.end();
    return (await pending).stdout;
  };
  const updater = createUpdater({
    stateDir,
    runUpdate: shellRunner(join(fileURLToPath(new URL(".", import.meta.url)), "run-update.sh")),
    acquisitionsRunning: async () => {
      try {
        const response = await fetch(`${webBase}/api/update/busy`, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, body: await response.text() };
      } catch {
        return { status: 0, body: "" };
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date().toISOString(),
    waitPollMs: 30_000,
    waitLimitMs: 2 * 60 * 60 * 1000,
    repoDir: process.env.UPDATER_REPO_DIR ?? "/repo",
    writeTunnelEnv,
    composeProject: () => readComposeProject(dockerText),
    runCompose: (argv) => runComposeTunnel(argv),
    // The commit the running web container was built from (its BUILD_COMMIT). Async with a
    // timeout on both calls: the recheck skips a round while the last one is still running,
    // so one hung docker call must not stop it for good.
    servingCommit: async () => {
      try {
        const project = await readComposeProject(dockerText);
        const commit = (
          await dockerText([
            "compose",
            "-p",
            project,
            "--project-directory",
            process.env.UPDATER_REPO_DIR ?? "/repo",
            "exec",
            "-T",
            "web",
            "cat",
            "BUILD_COMMIT",
          ])
        ).trim();
        return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
      } catch {
        return null;
      }
    },
    // As the deploy folder's owner (see run-update.sh), so git does not refuse the repo.
    repoCommit: () => {
      try {
        const owner = execFileSync("stat", ["-c", "%u:%g", process.env.UPDATER_REPO_DIR ?? "/repo"], {
          encoding: "utf8",
        }).trim();
        const head = execFileSync("su-exec", [owner, "git", "-C", process.env.UPDATER_REPO_DIR ?? "/repo", "rev-parse", "HEAD"], {
          encoding: "utf8",
          env: { ...process.env, HOME: "/tmp" },
        }).trim();
        return /^[0-9a-f]{40}$/.test(head) ? head : null;
      } catch {
        return null;
      }
    },
  });
  createServer(createUpdaterHttp(updater, token)).listen(8787, "0.0.0.0", () => {
    console.log("[updater] listening on :8787 (compose network only)");
  });
  // Once at start-up, then every minute; a failed round just waits for the next one.
  const recheck = () => {
    updater.recheckRecovery().catch(() => {});
  };
  recheck();
  setInterval(recheck, 60_000).unref();
}
