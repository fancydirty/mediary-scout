// §7 stage B: REAL acquisition by the FRIEND account into the FRIEND's own 115
// (uid 100000002, free 15GB). Requires stage A (two-drive-e2e.mjs setup) first.
// Picks a SMALL target + quality=medium to respect 15GB. Verifies the file
// physically lands in the friend's drive — true two-physical-drive isolation.
//   npx tsx scripts/two-drive-acquire-e2e.mts
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

const FRIEND_ACCT = "acct_friend_e2e", FRIEND_UID = "100000002";
const friendCookie = readFileSync("/tmp/friend-115-cookie.txt", "utf8").trim();
const rt = await import(path.join(repoRoot, "apps/web/lib/workflow-runtime.ts"));
const wf = await import("@media-track/workflow");
const repo = rt.getWorkflowRepository();
const pool = new pg.Pool({ connectionString: process.env.MEDIA_TRACK_POSTGRES_URL! });

let failed = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };

async function tmdbId(query: string): Promise<number> {
  const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&language=zh-CN`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } });
  const json = (await res.json()) as { results?: Array<{ id: number }> };
  const id = json.results?.[0]?.id;
  if (!id) throw new Error(`TMDB resolve failed for ${query}`);
  return id;
}
async function cleanupTitle(titleId: string) {
  await pool.query("DELETE FROM notifications WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM transfer_attempts WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM agent_decisions WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM resource_snapshots WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1))", [titleId]);
  await pool.query("DELETE FROM workflow_runs WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)", [titleId]);
  await pool.query("DELETE FROM episode_states WHERE tracked_season_id IN (SELECT id FROM tracked_seasons WHERE media_title_id=$1)", [titleId]);
  await pool.query("DELETE FROM tracked_seasons WHERE media_title_id=$1", [titleId]);
}

try {
  // precondition: stage A bound the friend's 115
  const conn = await repo.findConnectedStorageByUid("pan115", FRIEND_UID);
  ok("friend's 115 is bound (run stage A first)", conn?.accountId === FRIEND_ACCT);
  if (!conn) throw new Error("friend not set up — run: node scripts/two-drive-e2e.mjs setup");
  const friendMoviesCid = conn.moviesCid!;

  // bias small for 15GB
  await repo.setAccountSetting(FRIEND_ACCT, rt.QUALITY_PREFERENCE_SETTING_KEY, "medium");

  const id = await tmdbId("这个杀手不太冷");
  const titleId = `tmdb_movie_${id}`;
  await cleanupTitle(titleId);
  const target = await rt.movieTargetFromTmdbId(id);
  if (!target) throw new Error("movie target resolve failed");
  const runId = `run_friend_acq_${id}`;
  const queued = await wf.queueMovieAcquisition({ title: target.title, keyword: target.keyword, repository: repo, accountId: FRIEND_ACCT, createWorkflowRunId: () => runId });
  console.log("queued (friend) →", JSON.stringify(queued));
  ok("queued under friend", queued.status === "queued");

  for (let i = 0; i < 4; i++) {
    const r = await rt.runNextQueuedWorkflow();
    console.log(`  worker tick ${i + 1}: ${JSON.stringify(r)}`);
    const snap = await repo.getWorkflowRunSnapshot(runId, FRIEND_ACCT);
    if (snap && snap.workflowRun.status !== "queued" && snap.workflowRun.status !== "running") break;
    if (r.status === "idle") break;
  }
  const snap = await repo.getWorkflowRunSnapshot(runId, FRIEND_ACCT);
  console.log("final:", { accountId: snap?.accountId, status: snap?.workflowRun.status, obtained: snap?.obtainedEpisodes });
  ok("run owned by friend (not default)", snap?.accountId === FRIEND_ACCT);
  ok("default account cannot see friend's run", (await repo.getWorkflowRunSnapshot(runId, "acct_default")) === null);

  // PHYSICAL proof: the file is in the FRIEND's drive (uid 100000002) media-track/Movies
  const client = new wf.Pan115CookieClient({ cookie: friendCookie, listPageDelayMs: 0 });
  const movieDirs = await client.listItems({ directoryId: friendMoviesCid });
  let landedVideo: { name: string; size: number } | null = null;
  for (const d of movieDirs) {
    const cid = (d as any).cid;
    if (!cid) continue;
    const inner = await client.listItems({ directoryId: String(cid) });
    for (const f of inner) {
      const name = String((f as any).n ?? "");
      if (/\.(mkv|mp4|ts|m2ts)$/i.test(name)) landedVideo = { name, size: Number((f as any).s ?? 0) };
    }
  }
  console.log("landed in friend's 115:", landedVideo ? `${landedVideo.name} (${(landedVideo.size/1e9).toFixed(2)} GB)` : "(none)");
  ok("movie file physically landed in FRIEND's 115 drive", !!landedVideo);
  ok("landed file fits the 15GB free quota", !!landedVideo && landedVideo.size < 15e9);
} finally {
  await pool.end();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nTWO-DRIVE ACQUIRE (stage B) PASSED — friend acquired into friend's own 115");
process.exit(failed ? 1 : 0);
