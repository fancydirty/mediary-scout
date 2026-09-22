// scripts/jev-ab-run.mts — the Jev prefilter delivery gate (spec §8.3): A/B on a REAL
// instance, prefilter OFF vs ON, same titles, fresh DB state per arm, compared per run.
//
// Runs from the operator's machine and drives an ISOLATED compose project on the home
// router over short ssh calls (the CF tunnel kills long sessions, so every step is one
// fresh `ssh <host> '<cmd>'`). Nothing here touches the production stack: the isolated
// project has its own Postgres, its own web container, and a 115 drive row whose CIDs
// point at scratch folders — the storage executor's write scope is derived from those
// CIDs, so the run cannot write anywhere else. The harness holds up its end: --project
// must be a plain compose project name and never the production one (mediary-scout), and
// the eight CIDs must be distinct and none of them the 115 root ("0", an ancestor of
// every folder, would put the whole drive in scope).
//
// Per title × arm:
//   1. wipe tracking tables (accounts / settings / drive rows stay)
//   2. point the drive's category CIDs at the arm's scratch dirs (A or B — so the ON arm
//      never sees the OFF arm's files). The dirs are NOT wiped: a retried arm (below) or a
//      re-run with the same ab-cids.json sees what an earlier attempt landed for that
//      title, and inspectTargetDir can count it. Empty them per arm with
//      --pre-arm-remote, or give every harness run fresh dirs.
//   3. set jev_prefilter_enabled = 0 | 1
//   4. POST /api/agent/acquire { tmdbId, type } (Bearer MEDIA_TRACK_AGENT_TOKEN)
//   5. poll workflow_runs until the run leaves queued/running (timeout)
//   6. collect: status, agent steps, searchResources count, duration, obtained episode
//      codes, transfer attempts, per-search prefilter summary (applied / failed open /
//      partial), the loop's finish reason and ⚠ flag seen in the agent log
// An arm is re-run once when its LLM loop aborted (finish=content-filter / error / length /
// other) or it ended in no comparable state with no loop end in the log (generateText
// throws on a provider error, so a crashed loop prints none).
//
// Verdict per title — fail closed, only positive evidence counts toward GO:
//   INCONCLUSIVE  an arm's loop aborted on both attempts, or the OFF baseline did not end
//                 succeeded / partial / no_coverage;
//   REGRESSION    otherwise, ON looking worse: any other end state, an episode OFF obtained
//                 missing, or a lower status — whatever else about the pair is uncertain;
//   INCONCLUSIVE  ON looking at least as good without a real OFF/ON pair behind it: an
//                 arm's loop end missing from the agent log, OFF carrying a prefilter
//                 record, ON never having it applied or any ON search failing open or being
//                 judged only in part, or neither arm obtaining anything;
//   OK            otherwise.
// Exit codes: 0 GO — no REGRESSION, both arms on every title, at least one OK ·
// 1 NO-GO — any REGRESSION · 2 bad arguments, a failed preflight (the stack must run with
// MEDIA_TRACK_AGENT_LOG=1, readable CIDs), a failed --pre-arm-remote, or the harness itself
// failing mid-run · 3 NO VERDICT — anything else, and every --dry run. Efficiency (steps /
// searches / seconds) is reported, not gated.
//
// Usage:
//   npx tsx scripts/jev-ab-run.mts --host media-router-tunnel \
//     --project mediary-ab --port 3301 --token-file /path/on/router/.agent-token \
//     --cids-file /path/on/router/ab-cids.json --out /tmp/jev-ab-results.json \
//     tv:276161 tv:289761 movie:438631 ...
//   Options take their value as the next argument (--name value, never --name=value); an
//   unknown or repeated option, or a repeated title, is refused before anything runs.
//   --arms on,off        run only these arms (default off,on); a single arm is exploration
//                        only — it ends in NO VERDICT, never GO
//   --alternate          flip the arm order on every other title (title 0 off→on, title 1 on→off, …)
//                        so a same-115-account order effect (a magnet the first arm queued is
//                        refused as 任务已存在 for the second arm) cannot systematically favour one arm
//   --timeout-min 30     per-run timeout
//   --dry                print the remote commands instead of running them (writes no --out)
//   --pre-arm-remote "<cmd>"   a command run ON the host before every arm (after the instance is
//                        idle, before the reset) — e.g. purge the 115 offline-task records the
//                        previous arm added, so 115's "任务已存在" refusal cannot bias the next arm.
//                        A failing hook STOPS the run (exit 2): an arm it did not isolate is no verdict.
//
// ab-cids.json (on the router, produced by the setup script):
//   { "A": { "root": "...", "movies": "...", "tv": "...", "anime": "..." }, "B": { ... } }
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Arm { root: string; movies: string; tv: string; anime: string }
interface RunFacts {
  runId: string;
  status: string;
  steps: number;
  searches: number;
  transfers: number;
  durationS: number;
  obtained: string[];
  prefilter: string;
  flagSeen: boolean;
  /** Searches the judge answered in full or in part (prefilter status "applied"). */
  jevCalls: number;
  /** Searches carrying any prefilter record. The wrapper is not installed with the switch
   *  off, so an OFF arm must have none. */
  prefiltered: number;
  /** Searches whose candidates reached the agent (partly) unjudged: failed open (error,
   *  timeout, open circuit) or applied with failedChunks. */
  jevDegraded: number;
  /** The agent loop's terminal finishReason from the container log ("stop" | "tool-calls" |
   *  "content-filter" | "error" | …). A "content-filter"/"error" finish is an LLM-side abort
   *  that ends the loop mid-flight (files land, nothing gets marked) — it is not the
   *  prefilter's doing in either direction, so such arms are re-run once and, if they abort
   *  again, the title is reported INCONCLUSIVE rather than OK/REGRESSION. "length" and
   *  "other" end the loop the same way. */
  finish: string;
  tokens: number;
  attempts: number;
}

const USAGE =
  "usage: npx tsx scripts/jev-ab-run.mts --token-file <router path> --cids-file <router path> [--host <ssh host>] " +
  "[--project <compose project>] [--port <n>] [--out <file>] [--arms off,on] [--timeout-min <n>] [--alternate] [--dry] " +
  '[--pre-arm-remote "<cmd>"] <tv|movie>:<tmdbId> ...';
/** Everything the operator can get wrong ends here, before the first remote command. */
function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}
/** The production stack (compose project = repo dir name; containers mediary-scout-*-1).
 *  This harness TRUNCATEs the target's tables. */
const PRODUCTION_PROJECT = "mediary-scout";

// A whitelist, not a lookup: an unknown option (a typo'd --dry, a --name=value form) used
// to be skipped silently and swallow the title after it — --dyr ran the real thing.
const VALUED = new Set(["host", "project", "port", "token-file", "cids-file", "out", "arms", "timeout-min", "pre-arm-remote"]);
const SWITCHES = new Set(["dry", "alternate"]);
const values = new Map<string, string>();
const switches = new Set<string>();
const specs: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (!arg.startsWith("--")) { specs.push(arg); continue; }
  const name = arg.slice(2);
  if (values.has(name) || switches.has(name)) usageError(`${arg} given twice`);
  if (SWITCHES.has(name)) { switches.add(name); continue; }
  if (!VALUED.has(name)) usageError(`unknown option ${arg}${name.includes("=") ? " (write --name value, not --name=value)" : ""}`);
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) usageError(`${arg} needs a value`);
  values.set(name, value);
  i += 1;
}
const opt = (name: string, dflt?: string): string => {
  const value = values.get(name) ?? dflt;
  if (value === undefined) usageError(`missing --${name}`);
  return value;
};
const HOST = opt("host", "media-router-tunnel");
if (HOST.startsWith("-")) usageError(`--host must be an ssh host, got "${HOST}"`);
const PROJECT = opt("project", "mediary-ab");
// Interpolated into container names in every remote command: a name, nothing else.
if (!/^[a-z0-9][a-z0-9_-]*$/.test(PROJECT)) usageError(`--project must be a compose project name ([a-z0-9][a-z0-9_-]*), got "${PROJECT}"`);
if (PROJECT === PRODUCTION_PROJECT) usageError(`--project ${PROJECT} is the production stack — this harness TRUNCATEs its tables; point it at the isolated A/B project`);
const PORT = Number(opt("port", "3301"));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) usageError(`--port must be a TCP port, got "${values.get("port")}"`);
const TOKEN_FILE = opt("token-file");
const CIDS_FILE = opt("cids-file");
const OUT = opt("out", "/tmp/jev-ab-results.json");
const ARMS = opt("arms", "off,on").split(",").map((a) => a.trim()) as Array<"off" | "on">;
// The cast above accepts anything; a typo ("of") would run an arm no verdict ever reads.
if (ARMS.some((a) => a !== "off" && a !== "on") || new Set(ARMS).size !== ARMS.length) {
  usageError(`--arms must list "off" and/or "on" once each (got "${ARMS.join(",")}")`);
}
const ALTERNATE = switches.has("alternate");
const TIMEOUT_MIN = Number(opt("timeout-min", "30"));
if (!Number.isFinite(TIMEOUT_MIN) || TIMEOUT_MIN <= 0) usageError(`--timeout-min must be a positive number, got "${values.get("timeout-min")}"`);
const DRY = switches.has("dry");
const PRE_ARM_REMOTE = values.get("pre-arm-remote");
const titles: Array<{ type: "tv" | "movie"; tmdbId: number }> = [];
for (const spec of specs) {
  const m = /^(tv|movie):(\d+)$/.exec(spec);
  if (!m) usageError(`bad title spec "${spec}" (want tv:<tmdbId> | movie:<tmdbId>)`);
  const tmdbId = Number(m[2]);
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) usageError(`bad TMDB id in "${spec}"`);
  // tv:1 and tv:01 are one title. A repeat runs against the dirs the first pass filled
  // (they are not wiped) and would add a "conclusive" row that measured nothing new.
  if (titles.some((t) => t.type === m[1] && t.tmdbId === tmdbId)) usageError(`title ${m[1]}:${tmdbId} given twice`);
  titles.push({ type: m[1] as "tv" | "movie", tmdbId });
}
if (titles.length === 0) usageError("no titles given");
if (!DRY) {
  // Results are written after every arm: a bad path must fail now, not after the first
  // 30-minute arm. A --dry run writes nothing, so it can never replace real results.
  try {
    const target = resolve(OUT);
    if (existsSync(target)) {
      if (!statSync(target).isFile()) throw new Error("not a regular file");
      accessSync(target, constants.W_OK);
    } else {
      accessSync(dirname(target), constants.W_OK);
    }
  } catch (error) {
    usageError(`--out ${OUT} is not writable (${error instanceof Error ? error.message : String(error)})`);
  }
}

const PG = `docker exec -e PGPASSWORD=mediatrack ${PROJECT}-postgres-1 psql -U mediatrack -d mediatrack -tA`;
const WEB = `${PROJECT}-web-1`;

/** One short ssh call. Output trimmed. Throws on non-zero exit. Transient transport
 *  failures (the CF tunnel hiccups, "Network is unreachable", timeouts) are retried
 *  with backoff — a 2-hour A/B must not die on one dropped hop. */
function ssh(remote: string): string {
  if (DRY) { console.log(`[dry] ssh ${HOST} ${remote}`); return ""; }
  const delays = [0, 5_000, 20_000, 60_000];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) { console.log(`    (ssh retry in ${delay / 1000}s)`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); }
    try {
      return execFileSync("ssh", ["-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=10", HOST, remote], {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      lastError = error;
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      const status = (error as { status?: unknown }).status;
      // status 255 = ssh itself failed (transport); anything else came from the remote command.
      if (status !== 255 && !/ETIMEDOUT|timed out/i.test(String(error))) throw error;
      console.log(`    (ssh transport failure: ${stderr.trim().split("\n")[0] ?? String(error)})`);
    }
  }
  throw lastError;
}
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psql = (sql: string) => ssh(`${PG} -c ${sq(sql)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A failed preflight: the arguments were fine, the target is not usable. Nothing ran. */
function preflightError(message: string): never {
  console.error(message);
  process.exit(2);
}

function readCids(): Record<"A" | "B", Arm> {
  const raw = ssh(`cat ${sq(CIDS_FILE)}`);
  if (DRY) return { A: { root: "1", movies: "2", tv: "3", anime: "4" }, B: { root: "5", movies: "6", tv: "7", anime: "8" } };
  let cids: Record<"A" | "B", Arm>;
  try {
    cids = JSON.parse(raw) as Record<"A" | "B", Arm>;
  } catch {
    preflightError(`${CIDS_FILE} is not JSON`);
  }
  const seen = new Set<string>();
  for (const arm of ["A", "B"] as const) {
    for (const key of ["root", "movies", "tv", "anime"] as const) {
      const value: unknown = cids?.[arm]?.[key];
      // Interpolated into SQL (pointDriveAt): a 115 CID is digits. Never "0" — the drive
      // root is an ancestor of every folder, so every write would pass the executor's
      // scope check — and never shared: an arm that can see the other arm's folders (or a
      // category that is its own root) no longer starts from what the header promises.
      if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) preflightError(`${CIDS_FILE}: ${arm}.${key} must be a non-root 115 CID (digits, not 0)`);
      if (seen.has(value)) preflightError(`${CIDS_FILE}: ${arm}.${key} (${value}) repeats another CID — all eight must be distinct`);
      seen.add(value);
    }
  }
  return cids;
}

/** The router's clock, not this machine's: `docker logs --since/--until` filter by the
 *  timestamps the router's daemon recorded, so a window taken on an operator clock that
 *  runs ahead or behind can miss this arm's loop line and catch the previous arm's. */
function routerNow(): string {
  const now = ssh("date -u +%Y-%m-%dT%H:%M:%SZ");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now)) throw new Error(`reading the router clock returned "${now}"`);
  return now;
}

/** Never wipe the tables while the worker is mid-run (a crashed/restarted harness could
 *  otherwise TRUNCATE under an in-flight acquisition and corrupt its persistence). */
async function waitForIdle(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  while (Date.now() < deadline) {
    const busy = psql("SELECT count(*) FROM workflow_runs WHERE payload->>'status' IN ('queued','running')");
    if (DRY || busy === "0") return;
    console.log(`    waiting for ${busy} in-flight run(s) to finish before resetting…`);
    await sleep(20_000);
  }
  throw new Error("instance did not become idle");
}

function resetTracking(): void {
  // Everything that describes a title or a run. Accounts, settings, drive rows, sessions stay.
  psql(
    "TRUNCATE media_titles, tracked_seasons, episode_states, workflow_runs, resource_snapshots, agent_decisions, agent_steps, transfer_attempts, notifications, dead_links",
  );
}

function pointDriveAt(arm: Arm): void {
  psql(
    `UPDATE connected_storages SET root_cid='${arm.root}', movies_cid='${arm.movies}', tv_cid='${arm.tv}', anime_cid='${arm.anime}' WHERE provider='pan115'`,
  );
}

function setPrefilter(on: boolean): void {
  psql(`UPDATE account_settings SET value='${on ? "1" : "0"}' WHERE account_id='acct_default' AND key='jev_prefilter_enabled'`);
  const v = psql("SELECT value FROM account_settings WHERE account_id='acct_default' AND key='jev_prefilter_enabled'");
  if (!DRY && v !== (on ? "1" : "0")) throw new Error(`jev_prefilter_enabled did not stick (got "${v}") — was the form saved on this instance?`);
}

function acquire(t: { type: "tv" | "movie"; tmdbId: number }): string {
  const body = JSON.stringify({ tmdbId: t.tmdbId, type: t.type });
  const out = ssh(
    `curl -s -X POST http://localhost:${PORT}/api/agent/acquire -H "Authorization: Bearer $(cat ${sq(TOKEN_FILE)})" -H 'content-type: application/json' -d ${sq(body)}`,
  );
  if (DRY) return "dry-run-id";
  let parsed: { status?: string; workflowRunId?: string | null; message?: string };
  try { parsed = JSON.parse(out); } catch { throw new Error(`acquire returned non-JSON: ${out.slice(0, 300)}`); }
  if (parsed.status !== "requested" || !parsed.workflowRunId) {
    throw new Error(`acquire ${t.type}:${t.tmdbId} → ${parsed.status}: ${parsed.message ?? out.slice(0, 300)}`);
  }
  // Interpolated into every per-run SQL statement below: accept only an id-shaped value.
  if (!/^[A-Za-z0-9_-]+$/.test(parsed.workflowRunId)) {
    throw new Error(`acquire ${t.type}:${t.tmdbId} returned a run id that is not id-shaped; refusing to use it in SQL`);
  }
  return parsed.workflowRunId;
}

async function waitForRun(runId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const status = psql(`SELECT payload->>'status' FROM workflow_runs WHERE id='${runId}'`);
    if (DRY) return "dry";
    if (status !== last) { process.stdout.write(`    ${new Date().toISOString().slice(11, 19)} ${runId.slice(0, 8)} ${status}\n`); last = status; }
    if (status && status !== "queued" && status !== "running") return status;
    await sleep(20_000);
  }
  throw new Error(`run ${runId} did not finish within ${TIMEOUT_MIN} min`);
}

function collect(runId: string, tmdbId: number, window: { since: string; until: string }): RunFacts {
  const status = psql(`SELECT payload->>'status' FROM workflow_runs WHERE id='${runId}'`);
  const steps = Number(psql(`SELECT count(*) FROM agent_steps WHERE workflow_run_id='${runId}'`) || 0);
  const searches = Number(psql(`SELECT count(*) FROM agent_steps WHERE workflow_run_id='${runId}' AND payload->>'toolName'='searchResources'`) || 0);
  const transfers = Number(psql(`SELECT count(*) FROM transfer_attempts WHERE workflow_run_id='${runId}'`) || 0);
  const durationS = Number(psql(`SELECT round(extract(epoch from ((payload->>'finishedAt')::timestamptz-(payload->>'startedAt')::timestamptz))) FROM workflow_runs WHERE id='${runId}'`) || 0);
  const obtainedRaw = psql(
    `SELECT string_agg(es.episode_code, ',' ORDER BY es.episode_code) FROM episode_states es JOIN tracked_seasons ts ON ts.id=es.tracked_season_id JOIN media_titles mt ON mt.id=ts.media_title_id WHERE (mt.payload->>'tmdbId')='${tmdbId}' AND (es.payload->>'obtained')::boolean`,
  );
  const obtained = obtainedRaw ? obtainedRaw.split(",").filter(Boolean) : [];
  // One token per search: status:dropped/floored/total (or '-' when no prefilter ran).
  const prefilter = psql(
    `SELECT coalesce(string_agg(coalesce(payload->'prefilter'->>'status','none')||':'||coalesce(jsonb_array_length(payload->'prefilter'->'dropped'),0)||'/'||coalesce(jsonb_array_length(payload->'prefilter'->'floored'),0)||'/'||jsonb_array_length(payload->'candidates'), ' ' ORDER BY ordinal),'-') FROM resource_snapshots WHERE workflow_run_id='${runId}'`,
  );
  const jevCalls = Number(psql(`SELECT count(*) FROM resource_snapshots WHERE workflow_run_id='${runId}' AND payload->'prefilter'->>'status'='applied'`) || 0);
  const prefiltered = Number(psql(`SELECT count(*) FROM resource_snapshots WHERE workflow_run_id='${runId}' AND payload->'prefilter' IS NOT NULL`) || 0);
  const jevDegraded = Number(
    psql(
      `SELECT count(*) FROM resource_snapshots WHERE workflow_run_id='${runId}' AND (payload->'prefilter'->>'status'='failed' OR coalesce((payload->'prefilter'->>'failedChunks')::int,0)>0)`,
    ) || 0,
  );
  const logs = (filter: string) => ssh(`docker logs --since ${sq(window.since)} --until ${sq(window.until)} ${WEB} 2>&1 | ${filter}`);
  // The ⚠ suffix is rendered into the agent's document; MEDIA_TRACK_AGENT_LOG=1 echoes tool
  // results to the container log. Best-effort: absent log → false, not a gate.
  const flagSeen = logs(`grep -c '相关度存疑' || true`) !== "0";
  // MEDIA_TRACK_AGENT_LOG=1 prints one "[agent] loop done: steps=… tokens=… finish=…" per
  // loop, at the start of a line. Anchored to that whole shape so an echoed tool result
  // (third-party titles land in this log too) cannot pass for it.
  const loopLine = logs(`grep -E '^\\[agent\\] loop done: steps=[0-9]+ .* finish=[a-z-]+$' | tail -1 || true`);
  const finish = /finish=([a-z-]+)$/.exec(loopLine)?.[1] ?? "unknown";
  const tokens = Number(/tokens=(\d+)/.exec(loopLine)?.[1] ?? 0);
  return { runId, status, steps, searches, transfers, durationS, obtained, prefilter, flagSeen, jevCalls, prefiltered, jevDegraded, finish, tokens, attempts: 1 };
}

// An LLM-side end of the loop, not the prefilter's doing in either direction. AI SDK 6
// finish reasons: stop | tool-calls are a loop that ran its course; these four are not.
const ABORT_FINISHES = new Set(["content-filter", "error", "length", "other"]);
const isAborted = (x: RunFacts) => ABORT_FINISHES.has(x.finish);
// "unknown" = no "[agent] loop done" line in the arm's log window: whether its loop
// aborted cannot be told, so the arm cannot count as evidence FOR the prefilter.
const isUnobserved = (x: RunFacts) => x.finish === "unknown";
// Terminal states that say something about coverage. Anything else (failed, cancelled,
// a state this harness does not know) is not evidence: an OFF baseline in such a state
// leaves nothing to compare against.
const COMPARABLE_STATUSES = new Set(["succeeded", "partial", "no_coverage"]);
const isComparable = (x: RunFacts) => COMPARABLE_STATUSES.has(x.status);
const statusRank = (s: string) => (s === "succeeded" ? 3 : s === "partial" ? 2 : s === "no_coverage" ? 1 : 0);
// Re-run once: an LLM abort, or a crash (no comparable end and no loop end logged).
const needsRetry = (x: RunFacts) => isAborted(x) || (!isComparable(x) && isUnobserved(x));

type Verdict = "OK" | "REGRESSION" | "INCONCLUSIVE";
/** Fail closed: only positive evidence counts toward GO. Once OFF is a baseline, ON
 *  looking worse is a REGRESSION whatever else is uncertain about the pair — only an
 *  observed LLM abort excuses it — while ON looking fine counts only for a real,
 *  observed OFF/ON pair that measured something. */
function judgeRow(off: RunFacts, on: RunFacts): { verdict: Verdict; why: string } {
  const inconclusive = (why: string) => ({ verdict: "INCONCLUSIVE" as const, why });
  const regression = (why: string) => ({ verdict: "REGRESSION" as const, why });
  if (isAborted(off) || isAborted(on)) return inconclusive(`LLM loop aborted on both attempts (OFF finish=${off.finish}, ON finish=${on.finish})`);
  if (!isComparable(off)) return inconclusive(`no OFF baseline: OFF ended ${off.status}`);
  if (!isComparable(on)) return regression(`ON ended ${on.status} where OFF ended ${off.status}`);
  const missing = off.obtained.filter((code) => !on.obtained.includes(code));
  if (missing.length > 0) return regression(`ON lacks ${missing.join(",")}, which OFF obtained`);
  if (statusRank(on.status) < statusRank(off.status)) return regression(`ON ended ${on.status}, OFF ${off.status}`);
  const unobserved = [isUnobserved(off) ? "OFF" : "", isUnobserved(on) ? "ON" : ""].filter(Boolean);
  if (unobserved.length > 0) return inconclusive(`${unobserved.join(" and ")} loop end not in the agent log`);
  // The arms must be what they claim, or "no difference" is ON measured against ON.
  if (off.prefiltered > 0) return inconclusive(`OFF carried a prefilter record on ${off.prefiltered} search(es)`);
  if (on.jevCalls === 0) return inconclusive("ON never had the prefilter applied");
  if (on.jevDegraded > 0) return inconclusive(`${on.jevDegraded} ON search(es) failed open or were judged only in part`);
  // Every set contains the empty set: two empty arms measured nothing.
  if (off.obtained.length === 0 && on.obtained.length === 0) return inconclusive("neither arm obtained anything");
  return { verdict: "OK", why: "" };
}

const results: Array<{ title: string; type: string; tmdbId: number; order: string; off?: RunFacts; on?: RunFacts; verdict?: Verdict; why?: string }> = [];
const saveResults = () => { if (!DRY) writeFileSync(OUT, JSON.stringify(results, null, 2)); };

async function main(): Promise<void> {
  const cids = readCids();
  // Without MEDIA_TRACK_AGENT_LOG=1 the web container never prints the loop-end line, no
  // arm could count as evidence and the whole run would end NO VERDICT — refuse up front.
  if (!DRY) {
    const agentLog = ssh(`docker exec ${WEB} printenv MEDIA_TRACK_AGENT_LOG || true`);
    if (agentLog !== "1") {
      preflightError(
        `MEDIA_TRACK_AGENT_LOG is not 1 in ${WEB} (got "${agentLog}"): no arm's loop end could be observed. Set it in the stack's .env and recreate the container.`,
      );
    }
  }
  for (const [index, t] of titles.entries()) {
    const label = `${t.type}:${t.tmdbId}`;
    const arms = ALTERNATE && index % 2 === 1 ? [...ARMS].reverse() : ARMS;
    const row: (typeof results)[number] = { title: label, type: t.type, tmdbId: t.tmdbId, order: arms.join("→") };
    results.push(row);
    for (const arm of arms) {
      const armCids = arm === "off" ? cids.A : cids.B;
      let facts: RunFacts | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`\n=== ${label} — prefilter ${arm.toUpperCase()} (drive → ${arm === "off" ? "A" : "B"})${attempt > 1 ? ` — attempt ${attempt}` : ""}`);
        await waitForIdle();
        if (PRE_ARM_REMOTE) {
          console.log(`    pre-arm: ${PRE_ARM_REMOTE}`);
          try {
            const out = ssh(PRE_ARM_REMOTE);
            if (out) console.log(out.split("\n").map((l) => `      ${l}`).join("\n"));
          } catch (error) {
            // The hook IS the isolation the operator asked for (clearing the other arm's
            // leftover 115 tasks — the 「任务已存在」 order effect). An arm run without it is
            // not isolated, yet its verdict would still print as a GO/REGRESSION gate: stop.
            console.error(`    pre-arm hook failed — stopping${DRY ? "" : ` (rows finished so far are in ${OUT})`}: ${String((error as { stderr?: unknown }).stderr ?? error).split("\n")[0]}`);
            process.exit(2);
          }
        }
        resetTracking();
        pointDriveAt(armCids);
        setPrefilter(arm === "on");
        const since = DRY ? "" : routerNow();
        const runId = acquire(t);
        console.log(`    queued run ${runId}`);
        const status = await waitForRun(runId);
        facts = DRY
          ? { runId, status, steps: 0, searches: 0, transfers: 0, durationS: 0, obtained: [], prefilter: "-", flagSeen: false, jevCalls: 0, prefiltered: 0, jevDegraded: 0, finish: "dry", tokens: 0, attempts: attempt }
          : { ...collect(runId, t.tmdbId, { since, until: routerNow() }), attempts: attempt };
        console.log(
          `    ${status} finish=${facts.finish} steps=${facts.steps} searches=${facts.searches} transfers=${facts.transfers} ${facts.durationS}s tokens=${facts.tokens} obtained=${facts.obtained.length} prefilter=${facts.prefilter}${arm === "on" ? ` flagSeen=${facts.flagSeen}` : ""}`,
        );
        if (DRY || !needsRetry(facts) || attempt === 2) break;
        console.log(
          isAborted(facts)
            ? `    ↻ the LLM aborted the loop (finish=${facts.finish}) — not a prefilter effect; re-running this arm`
            : `    ↻ the run ended ${facts.status} with no loop end in the agent log (a provider error throws before it) — re-running this arm`,
        );
        if (!PRE_ARM_REMOTE) console.log("    ⚠ no --pre-arm-remote: the retry sees whatever the first attempt already landed in this arm's dirs");
      }
      row[arm] = facts!;
      saveResults();
    }
    if (row.off && row.on && !DRY) {
      const { verdict, why } = judgeRow(row.off, row.on);
      row.verdict = verdict;
      row.why = why;
      console.log(
        `    → quality ${verdict}${why ? ` — ${why}` : ""} (OFF ${row.off.obtained.length} eps ${row.off.status}/${row.off.finish} | ON ${row.on.obtained.length} eps ${row.on.status}/${row.on.finish})`,
      );
      saveResults();
    }
  }

  console.log("\n| title | order | OFF status/finish | OFF eps | OFF steps/search/s/ktok | ON status/finish | ON eps | ON steps/search/s/ktok | ON prefilter (status:dropped/floored/total per search) | quality |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const f = (x?: RunFacts) => (x ? `${x.steps}/${x.searches}/${x.durationS}/${Math.round(x.tokens / 1000)}` : "-");
    const sf = (x?: RunFacts) => (x ? `${x.status}/${x.finish}${x.attempts > 1 ? ` (×${x.attempts})` : ""}` : "-");
    console.log(`| ${r.title} | ${r.order} | ${sf(r.off)} | ${r.off?.obtained.length ?? "-"} | ${f(r.off)} | ${sf(r.on)} | ${r.on?.obtained.length ?? "-"} | ${f(r.on)} | ${r.on?.prefilter ?? "-"} | ${r.verdict ?? "-"} |`);
  }
  if (DRY) {
    // Nothing ran: the rows above are placeholders, not evidence.
    console.log("\nNO VERDICT: dry run — nothing was executed");
    process.exit(3);
  }
  for (const r of results) if (r.verdict && r.verdict !== "OK") console.log(`  ${r.verdict} ${r.title}: ${r.why}`);
  const regressions = results.filter((r) => r.verdict === "REGRESSION");
  if (regressions.length > 0) {
    console.log(`\nNO-GO: ${regressions.map((r) => r.title).join(", ")}`);
    process.exit(1);
  }
  // A row without a verdict never had both arms (a single-arm --arms run): nothing was
  // compared, so it can neither pass nor fail the gate.
  const uncompared = results.filter((r) => r.verdict === undefined);
  const ok = results.filter((r) => r.verdict === "OK").length;
  const inconclusive = results.length - ok - uncompared.length;
  if (uncompared.length > 0 || ok === 0) {
    // GO is a claim that Jev was measured against the bare run. Without both arms on
    // every title, or with no conclusive title at all, that claim has no evidence.
    console.log(
      `\nNO VERDICT: ${uncompared.length > 0 ? `${uncompared.map((r) => r.title).join(", ")} ran only ${ARMS.join(",")} (both arms are needed)` : "no title produced a conclusive OFF/ON comparison"}`,
    );
    process.exit(3);
  }
  console.log(`\nGO (${ok} conclusive, ${inconclusive} inconclusive)`);
}

try {
  await main();
} catch (error) {
  // A harness that died mid-run (ssh gave up, a run never finished, a malformed acquire
  // response) measured nothing it can stand behind: not NO-GO's exit 1.
  console.error(`\nHARNESS ERROR — no verdict${DRY ? "" : ` (rows finished so far are in ${OUT})`}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
