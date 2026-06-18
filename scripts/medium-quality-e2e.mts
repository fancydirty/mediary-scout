// Behavioral verification of the medium-quality CEILING fix
// (commit `fix(search-profile): medium 画质指引改双边对称`).
//
// Runs a REAL acquisition (default account / real 115 TEST root / real PanSou /
// real agent) at quality=medium on a BLOCKBUSTER whose recall genuinely contains
// a 4K REMUX. Proves end-to-end that the agent now:
//   (1) SAW a 4K/REMUX candidate in recall (so the test is meaningful), and
//   (2) did NOT select it — it chose a 1080p-class file instead, and
//   (3) the file that physically landed is 1080p-class, not a 70GB+ remux.
//
//   npx tsx scripts/medium-quality-e2e.mts
//
// Lands into the TEST Movies root (env MEDIA_TRACK_MOVIES_PARENT_CID) on the
// main 115 — lots of space; never the friend's 15GB drive.
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const repoRoot = path.resolve(import.meta.dirname, "..");
for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] ??= v;
}

const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const wf = await import("@media-track/workflow");
const repo = rt.getWorkflowRepository();
const pool = new pg.Pool({ connectionString: process.env.MEDIA_TRACK_POSTGRES_URL! });

const ACCT = "acct_default";
// Blockbusters whose PanSou recall reliably carries a TRUE 2160p/4K REMUX (the
// exact original-bug class). Tried in order until one's recall actually contains
// one (so the assertion replicates the 74.9GB-remux scenario, not just a 原盘).
// Lead with FRESH titles (not acquired earlier this session, so the test root
// has no residue that would let the agent skip the transfer) that still surface a
// true 4K remux in recall. 沙丘2/奥本海默 already exercised; kept only as fallback.
const TARGETS = ["阿凡达：水之道", "蝙蝠侠 2022", "蜘蛛侠：英雄无归", "阿凡达水之道", "沙丘2"];
// The exact original-bug class: a true 4K/2160p/REMUX. This is the gate.
const TRUE_4K = /2160p|\b4k\b|\buhd\b|remux/i;
// The full ceiling medium must AVOID (4K + bloated disc images); pick assertion.
const OVER_SPEC = /2160p|\b4k\b|\buhd\b|remux|原盘|bdmv|\biso\b|蓝光原盘/i;
// 1080p-class quality tokens. NOTE candidate titles are inconsistent — many just
// say "BD国英双语" (BD=BluRay) or carry no resolution at all — so the AUTHORITATIVE
// 1080p-class signal is the physically-landed file's size band, not the title.
const GOOD = /1080p|720p|\bbd\b|蓝光|blu-?ray|bdrip|web-?dl|webrip|hdtv|x264|x265|hevc/i;
// a movie 1080p web/bluray is single-digit→~teens GB; a 4K remux is 40-100GB+.
const GIANT_BYTES = 30e9;
// floor: anything under this is a cam/preview, not a real 1080p movie encode.
const MIN_REAL_BYTES = 0.8e9;

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };

async function tmdbId(query: string): Promise<number | null> {
  const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&language=zh-CN`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } });
  const json = (await res.json()) as { results?: Array<{ id: number }> };
  return json.results?.[0]?.id ?? null;
}

async function cleanupTitle(titleId: string) {
  for (const sql of [
    "DELETE FROM notifications WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM transfer_attempts WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM agent_decisions WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM resource_snapshots WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))",
    "DELETE FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)",
    "DELETE FROM episode_states WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)",
    "DELETE FROM tracked_seasons WHERE media_title_id=$1",
  ]) await pool.query(sql, [titleId]);
}

async function driveUntilTerminal(runId: string) {
  for (let i = 0; i < 6; i++) {
    const result = await rt.runNextQueuedWorkflow();
    console.log(`  worker tick ${i + 1}: ${JSON.stringify(result)}`);
    const snap = await repo.getWorkflowRunSnapshot(runId, ACCT);
    const status = snap?.workflowRun.status;
    if (status && status !== "queued" && status !== "running") return snap;
    if (result.status === "idle") break;
  }
  return repo.getWorkflowRunSnapshot(runId, ACCT);
}

const moviesCid = process.env.MEDIA_TRACK_MOVIES_PARENT_CID!;
const cookie = (await repo.getSetting("pan115.cookie"))?.trim();
if (!cookie) throw new Error("no default 115 cookie in DB");
const client = new wf.Pan115CookieClient({ cookie, listPageDelayMs: 0 });

// Recursively collect video files under the test Movies root, deduped by 115
// file id (a file reachable via >1 path must not be double-counted).
async function listMovieVideos(): Promise<Map<string, { name: string; size: number }>> {
  const out = new Map<string, { name: string; size: number }>();
  const walk = async (cid: string, depth: number) => {
    if (depth > 2) return;
    const items = await client.listItems({ directoryId: cid });
    for (const it of items) {
      const name = String((it as any).n ?? "");
      const sub = (it as any).cid;
      const fid = String((it as any).fid ?? (it as any).fileId ?? "");
      if (/\.(mkv|mp4|ts|m2ts)$/i.test(name)) out.set(fid || name, { name, size: Number((it as any).s ?? 0) });
      else if (sub) await walk(String(sub), depth + 1);
    }
  };
  await walk(moviesCid, 0);
  return out;
}

try {
  await repo.setAccountSetting(ACCT, rt.QUALITY_PREFERENCE_SETTING_KEY, "medium");
  console.log(`acct_default quality preference = medium`);

  let chosenTarget: string | null = null;
  for (const query of TARGETS) {
    const id = await tmdbId(query);
    if (!id) { console.log(`(skip ${query}: TMDB miss)`); continue; }
    const titleId = `tmdb_movie_${id}`;
    console.log(`\n=== TRY ${query} (${titleId}) ===`);
    await cleanupTitle(titleId);

    const before = await listMovieVideos();

    const res = await rt.queueCandidateTracking(titleId);
    if (res.status !== "queued" || !res.workflowRunId) { console.log(`(skip ${query}: not queued — ${JSON.stringify(res)})`); continue; }
    const snap = await driveUntilTerminal(res.workflowRunId);
    if (!snap) { console.log(`(skip ${query}: no snapshot)`); continue; }

    // Gate: recall must contain a TRUE 2160p/4K/REMUX (the exact original-bug
    // class) — only then does this run replicate the 74.9GB-remux scenario.
    const allCandidates = snap.resourceSnapshots.flatMap((s) => s.candidates);
    const blob = (c: { title: string; qualityHints: string[] }) => `${c.title} ${c.qualityHints.join(" ")}`;
    const true4kInRecall = allCandidates.filter((c) => TRUE_4K.test(blob(c)));
    const overSpecInRecall = allCandidates.filter((c) => OVER_SPEC.test(blob(c)));
    console.log(`  recall: ${allCandidates.length} candidates, ${true4kInRecall.length} TRUE 4K/remux, ${overSpecInRecall.length} over-spec(incl 原盘)`);
    if (true4kInRecall.length === 0) { console.log(`  (inconclusive for ${query}: no TRUE 4K/remux in recall — trying next)`); continue; }

    chosenTarget = query;
    console.log(`  TRUE 4K/remux in recall: ${true4kInRecall.slice(0, 3).map((c) => c.title).join(" | ")}`);

    // What did the agent SELECT?
    const selectedIds = new Set(snap.decisions.flatMap((d) => d.selectedCandidateIds));
    const selected = allCandidates.filter((c) => selectedIds.has(c.id));
    console.log(`  selected: ${selected.map((c) => c.title).join(" | ") || "(none)"}`);

    ok(`[${query}] recall HAD a TRUE 4K/REMUX option (replicates original bug)`, true4kInRecall.length > 0);
    ok(
      `[${query}] agent did NOT select any over-spec (4K/remux/原盘) candidate`,
      selected.length > 0 && selected.every((c) => !OVER_SPEC.test(blob(c))),
    );

    // PHYSICAL proof (authoritative): the newly landed file is a real 1080p-class
    // encode — sane size band + no 4K/remux token. (Title strings are too
    // inconsistent to judge quality; the landed bytes are the ground truth.)
    const after = await listMovieVideos();
    const landed = [...after.entries()].filter(([id]) => !before.has(id)).map(([, f]) => f);
    console.log(`  landed: ${landed.map((f) => `${f.name} (${(f.size / 1e9).toFixed(2)}GB)`).join(" | ") || "(none new)"}`);
    ok(`[${query}] a video physically landed`, landed.length > 0);
    ok(`[${query}] landed file name has no 4K/REMUX token`, landed.every((f) => !OVER_SPEC.test(f.name)));
    ok(
      `[${query}] landed file is a real 1080p-class encode (0.8GB ≤ size < 30GB)`,
      landed.every((f) => f.size >= MIN_REAL_BYTES && f.size < GIANT_BYTES),
    );
    // Secondary (lenient) signal: at least one selected/landed name reads 1080p-class.
    ok(
      `[${query}] a 1080p-class token appears on the pick (BD/蓝光/1080p/web-dl…)`,
      selected.some((c) => GOOD.test(blob(c))) || landed.some((f) => GOOD.test(f.name)),
    );
    break;
  }

  if (!chosenTarget) {
    console.log("\nINCONCLUSIVE: none of the targets had a 4K/REMUX in recall this run (PanSou jitter). Re-run.");
    failed++;
  }
} finally {
  await pool.end();
}
console.log(failed === 0 ? `\nMEDIUM-QUALITY CEILING E2E PASSED — agent skipped 4K/remux, landed 1080p` : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
