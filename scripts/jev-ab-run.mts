// scripts/jev-ab-run.mts — the Jev prefilter delivery gate (spec §8.3): A/B on a REAL
// instance, prefilter OFF vs ON, same titles, fresh state per arm, compared per run.
//
// Runs from the operator's machine and drives an ISOLATED compose project on the home
// router over short ssh calls (the CF tunnel kills long sessions, so every step is one
// fresh `ssh <host> '<cmd>'`). Nothing here touches the production stack: the isolated
// project has its own Postgres, its own web container, and a 115 drive row whose CIDs
// point at a scratch folder — the storage executor's write scope is derived from those
// CIDs, so the run cannot write anywhere else.
//
// Per title × arm:
//   1. wipe tracking tables (accounts / settings / drive rows stay)
//   2. point the drive's category CIDs at the arm's scratch dirs (A or B — so the second
//      arm never sees the first arm's files and both start from an empty library)
//   3. set jev_prefilter_enabled = 0 | 1
//   4. POST /api/agent/acquire { tmdbId, type } (Bearer MEDIA_TRACK_AGENT_TOKEN)
//   5. poll workflow_runs until the run leaves queued/running (timeout)
//   6. collect: status, agent steps, searchResources count, duration, obtained episode
//      codes, transfer attempts, per-search prefilter summary, ⚠ flag seen in agent log
//
// Go/no-go per title: ON obtained set ⊇ OFF obtained set (or equal) AND ON status not
// worse. Any regression → NO-GO (exit 1). Efficiency (steps / searches / seconds) is
// reported, not gated.
//
// Usage:
//   npx tsx scripts/jev-ab-run.mts --host media-router-tunnel \
//     --project mediary-ab --port 3301 --token-file /path/on/router/.agent-token \
//     --cids-file /path/on/router/ab-cids.json --out /tmp/jev-ab-results.json \
//     tv:276161 tv:289761 movie:438631 ...
//   --arms on,off        run only these arms (default off,on)
//   --alternate          flip the arm order on every other title (title 0 off→on, title 1 on→off, …)
//                        so a same-115-account order effect (a magnet the first arm queued is
//                        refused as 任务已存在 for the second arm) cannot systematically favour one arm
//   --timeout-min 30     per-run timeout
//   --dry                print the remote commands instead of running them
//   --pre-arm-remote "<cmd>"   a command run ON the host before every arm (after the instance is
//                        idle, before the reset) — e.g. purge the 115 offline-task records the
//                        previous arm added, so 115's "任务已存在" refusal cannot bias the next arm
//
// ab-cids.json (on the router, produced by the setup script):
//   { "A": { "root": "...", "movies": "...", "tv": "...", "anime": "..." }, "B": { ... } }
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

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
  jevCalls: number;
  /** The agent loop's terminal finishReason from the container log ("stop" | "tool-calls" |
   *  "content-filter" | "error" | …). A "content-filter"/"error" finish is an LLM-side abort
   *  that ends the loop mid-flight (files land, nothing gets marked) — it is not the
   *  prefilter's doing in either direction, so such arms are re-run once and, if they abort
   *  again, the title is reported INCONCLUSIVE rather than OK/REGRESSION. */
  finish: string;
  tokens: number;
  attempts: number;
}

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) { if (dflt === undefined) throw new Error(`missing --${name}`); return dflt; }
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
};
const HOST = opt("host", "media-router-tunnel");
const PROJECT = opt("project", "mediary-ab");
const PORT = Number(opt("port", "3301"));
const TOKEN_FILE = opt("token-file");
const CIDS_FILE = opt("cids-file");
const OUT = opt("out", "/tmp/jev-ab-results.json");
const ARMS = opt("arms", "off,on").split(",").map((a) => a.trim()) as Array<"off" | "on">;
const ALTERNATE = args.includes("--alternate");
const TIMEOUT_MIN = Number(opt("timeout-min", "30"));
const DRY = args.includes("--dry");
const PRE_ARM_REMOTE = args.includes("--pre-arm-remote") ? opt("pre-arm-remote") : undefined;
const titles = args
  .filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--dry" && args[i - 1] !== "--alternate"))
  .map((spec) => {
    const m = /^(tv|movie):(\d+)$/.exec(spec);
    if (!m) throw new Error(`bad title spec "${spec}" (want tv:<tmdbId> | movie:<tmdbId>)`);
    return { type: m[1] as "tv" | "movie", tmdbId: Number(m[2]) };
  });
if (titles.length === 0) { console.error("no titles given"); process.exit(2); }

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

function readCids(): Record<"A" | "B", Arm> {
  const raw = ssh(`cat ${sq(CIDS_FILE)}`);
  if (DRY) return { A: { root: "a", movies: "a", tv: "a", anime: "a" }, B: { root: "b", movies: "b", tv: "b", anime: "b" } };
  return JSON.parse(raw) as Record<"A" | "B", Arm>;
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
  // The ⚠ suffix is rendered into the agent's document; MEDIA_TRACK_AGENT_LOG=1 echoes tool
  // results to the container log. Best-effort: absent log → false, not a gate.
  const flagSeen = DRY ? false : ssh(`docker logs --since ${sq(window.since)} --until ${sq(window.until)} ${WEB} 2>&1 | grep -c '相关度存疑' || true`) !== "0";
  // MEDIA_TRACK_AGENT_LOG=1 prints one "[agent] loop done: steps=… tokens=… finish=…" per loop.
  const loopLine = DRY ? "" : ssh(`docker logs --since ${sq(window.since)} --until ${sq(window.until)} ${WEB} 2>&1 | grep -E '\\[agent\\] loop done' | tail -1 || true`);
  const finish = /finish=([a-z-]+)/.exec(loopLine)?.[1] ?? "unknown";
  const tokens = Number(/tokens=(\d+)/.exec(loopLine)?.[1] ?? 0);
  return { runId, status, steps, searches, transfers, durationS, obtained, prefilter, flagSeen, jevCalls, finish, tokens, attempts: 1 };
}

const isAborted = (x: RunFacts) => x.finish === "content-filter" || x.finish === "error";
const cids = readCids();
const results: Array<{ title: string; type: string; tmdbId: number; order: string; off?: RunFacts; on?: RunFacts; verdict?: string }> = [];
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
        try { const out = ssh(PRE_ARM_REMOTE); if (out) console.log(out.split("\n").map((l) => `      ${l}`).join("\n")); }
        catch (error) { console.log(`    pre-arm hook failed (continuing): ${String((error as { stderr?: unknown }).stderr ?? error).split("\n")[0]}`); }
      }
      resetTracking();
      pointDriveAt(armCids);
      setPrefilter(arm === "on");
      const since = new Date().toISOString();
      const runId = acquire(t);
      console.log(`    queued run ${runId}`);
      const status = await waitForRun(runId);
      const until = new Date(Date.now() + 5_000).toISOString();
      facts = DRY
        ? { runId, status, steps: 0, searches: 0, transfers: 0, durationS: 0, obtained: [], prefilter: "-", flagSeen: false, jevCalls: 0, finish: "dry", tokens: 0, attempts: attempt }
        : { ...collect(runId, t.tmdbId, { since, until }), attempts: attempt };
      console.log(`    ${status} finish=${facts.finish} steps=${facts.steps} searches=${facts.searches} transfers=${facts.transfers} ${facts.durationS}s tokens=${facts.tokens} obtained=${facts.obtained.length} prefilter=${facts.prefilter}${arm === "on" ? ` flagSeen=${facts.flagSeen}` : ""}`);
      if (!isAborted(facts) || DRY) break;
      console.log(`    ↻ the LLM aborted the loop (finish=${facts.finish}) — not a prefilter effect; re-running this arm`);
    }
    row[arm] = facts!;
    writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  if (row.off && row.on) {
    const offSet = new Set(row.off.obtained);
    const superset = row.off.obtained.every((code) => row.on!.obtained.includes(code));
    const statusRank = (s: string) => (s === "succeeded" ? 3 : s === "partial" ? 2 : s === "no_coverage" ? 1 : 0);
    const notWorse = statusRank(row.on.status) >= statusRank(row.off.status);
    row.verdict = isAborted(row.off) || isAborted(row.on) ? "INCONCLUSIVE" : superset && notWorse ? "OK" : "REGRESSION";
    console.log(`    → quality ${row.verdict} (OFF ${offSet.size} eps ${row.off.status}/${row.off.finish} | ON ${row.on.obtained.length} eps ${row.on.status}/${row.on.finish})`);
    writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
}

console.log("\n| title | order | OFF status/finish | OFF eps | OFF steps/search/s/ktok | ON status/finish | ON eps | ON steps/search/s/ktok | ON prefilter (status:dropped/floored/total per search) | quality |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  const f = (x?: RunFacts) => (x ? `${x.steps}/${x.searches}/${x.durationS}/${Math.round(x.tokens / 1000)}` : "-");
  const sf = (x?: RunFacts) => (x ? `${x.status}/${x.finish}${x.attempts > 1 ? ` (×${x.attempts})` : ""}` : "-");
  console.log(`| ${r.title} | ${r.order} | ${sf(r.off)} | ${r.off?.obtained.length ?? "-"} | ${f(r.off)} | ${sf(r.on)} | ${r.on?.obtained.length ?? "-"} | ${f(r.on)} | ${r.on?.prefilter ?? "-"} | ${r.verdict ?? "-"} |`);
}
const regressions = results.filter((r) => r.verdict === "REGRESSION");
const inconclusive = results.filter((r) => r.verdict === "INCONCLUSIVE");
if (regressions.length > 0) { console.log(`\nNO-GO: ${regressions.map((r) => r.title).join(", ")}`); process.exit(1); }
if (inconclusive.length > 0) console.log(`\nINCONCLUSIVE (LLM aborted both attempts of an arm): ${inconclusive.map((r) => r.title).join(", ")}`);
console.log(`\nGO (${results.length - inconclusive.length} conclusive, ${inconclusive.length} inconclusive)`);
