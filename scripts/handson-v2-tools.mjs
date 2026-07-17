#!/usr/bin/env node
// HANDS-ON V2-tools harness — Claude is the FIRST user of the V2 sandbox tools
// (plan §305 / [[localize-skill-into-agent-prompt]]). It drives the REAL TaskSandbox
// (RealStorageV2 over the real fail-loud 115 executor + real PanSou) against the 115
// TEST ROOT, so I experience real 115 nesting / returns / rough edges BEFORE writing
// the agent's skill from imagination.
//
// SAFETY: writes only under the test-root parents (MEDIA_TRACK_MOVIES/TV/ANIME_PARENT_CID,
// all children of MEDIA_TRACK_115_TEST_ROOT_CID). Production `clawd-media`
// (3339812358359874597) is OUTSIDE write scope + on the executor's protected list — the
// executor refuses any write that doesn't resolve under the test root. This is the
// user-mandated manual exploration, NOT the product e2e (which stays fully automatic).
//
// Run `npm run build:workflow` first (imports from packages/workflow/dist).
//
// Subcommands (steps chain via printed cids — NO re-transfer, registry is in-process so
// only `search`/`transfer` need the provider):
//   search        --keyword "奥本海默 2023" [--keyword ...]
//   transfer      --kind movie --name "奥本海默 (2023)" --keyword "..." --candidate <id|#N|match:substr>
//   transfer      --kind tv --name "绝命毒师 (2008)" --season 1 --keyword "..." --candidate <...>
//   inspect       --cid <cid>
//   flatten-movie --movie-cid <cid>
//   move          --staging-cid <cid> --season-map '{"1":"<seasonCid>"}' --plan '[{"season":1,"fileIds":["..."]}]'
//   discard       --staging-cid <cid> [--season-map '{"1":"<cid>"}']
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadPan115Cookie } from "./_lib/pan115-cookie.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_CID = "3339812358359874597"; // clawd-media — NEVER touch.

function parseArgs(argv) {
  const args = { keyword: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    const name = key.slice(2);
    if (name === "keyword") args.keyword.push(value);
    else args[name] = value;
    i += 1;
  }
  return args;
}

function j(value) {
  return JSON.stringify(value, null, 2);
}

/** Pretty-print a SimTreeFile[] (the V2 storage view: id/path/sizeBytes/isVideo/isSubtitle). */
function printTree(label, tree) {
  console.log(`\n${label} (${tree.length} files):`);
  for (const f of tree) {
    const tag = f.isVideo ? "🎬" : f.isSubtitle ? "💬" : "  ";
    const mb = (f.sizeBytes / 1024 / 1024).toFixed(1);
    console.log(`  ${tag} [${f.id}] ${f.path}  (${mb} MB)`);
  }
}

function buildExecutor() {
  if (process.env.MEDIA_TRACK_115_TEST_ROOT_CID === PRODUCTION_CID) {
    throw new Error("REFUSING: test root cid equals production clawd-media cid");
  }
  return createProtectedStorage();
}

let createPanSou, createProtectedStorage, CandidateRegistry, RealResourceProviderV2, RealStorageV2, TaskSandbox;

async function loadDeps() {
  const mod = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
  createPanSou = mod.createPanSouResourceProviderFromEnv;
  createProtectedStorage = () => mod.createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
  CandidateRegistry = mod.CandidateRegistry;
  RealResourceProviderV2 = mod.RealResourceProviderV2;
  RealStorageV2 = mod.RealStorageV2;
  TaskSandbox = mod.TaskSandbox;
}

function parentForKind(kind) {
  if (kind === "movie") return process.env.MEDIA_TRACK_MOVIES_PARENT_CID;
  if (kind === "anime") return process.env.MEDIA_TRACK_ANIME_PARENT_CID;
  return process.env.MEDIA_TRACK_TV_PARENT_CID;
}

/** Pick a candidate by exact id, #index, match:title-substr, or url:url-substr
 *  (url resolved from the registry — the agent can't see it, but I can, to drive). */
function pickCandidate(snapshot, selector, registry) {
  if (!selector) throw new Error("--candidate is required (id | #N | match:substr | url:substr)");
  if (selector.startsWith("#")) {
    const idx = Number(selector.slice(1));
    const c = snapshot.candidates[idx];
    if (!c) throw new Error(`no candidate at index ${idx} (have ${snapshot.candidates.length})`);
    return c;
  }
  if (selector.startsWith("match:")) {
    const needle = selector.slice(6);
    const c = snapshot.candidates.find((x) => x.title.includes(needle));
    if (!c) throw new Error(`no candidate title contains "${needle}"`);
    return c;
  }
  if (selector.startsWith("url:")) {
    const needle = selector.slice(4);
    const c = snapshot.candidates.find((x) => String(registry.get(x.id)?.providerPayload?.url ?? "").includes(needle));
    if (!c) throw new Error(`no candidate url contains "${needle}"`);
    return c;
  }
  const c = snapshot.candidates.find((x) => x.id === selector);
  if (!c) throw new Error(`no candidate with id ${selector}`);
  return c;
}

async function cmdSearch(args) {
  const registry = new CandidateRegistry();
  const provider = new RealResourceProviderV2({
    provider: createPanSou(),
    registry,
    workflowRunId: "handson",
  });
  for (const keyword of args.keyword) {
    console.log(`\n=== searchResources(${JSON.stringify(keyword)}) ===`);
    const snapshot = await provider.search(keyword);
    console.log(`snapshot id: ${snapshot.id}  (${snapshot.candidates.length} candidates)`);
    snapshot.candidates.forEach((c, i) => {
      const full = registry.get(c.id);
      const url = full?.providerPayload?.url ?? "(no url in payload)";
      console.log(`\n  #${i}  id=${c.id}`);
      console.log(`      title: ${c.title}`);
      console.log(`      url(hidden from agent): ${url}`);
      console.log(`      episodeHints: ${j(c.episodeHints)}  qualityHints: ${j(c.qualityHints)}`);
    });
  }
}

async function cmdTransfer(args) {
  const kind = args.kind ?? "tv";
  const parentId = parentForKind(kind);
  if (!parentId) throw new Error(`no parent cid for kind=${kind}`);
  if (!args.name) throw new Error("--name is required (e.g. '奥本海默 (2023)')");

  const executor = buildExecutor();
  const registry = new CandidateRegistry();
  const provider = new RealResourceProviderV2({ provider: createPanSou(), registry, workflowRunId: "handson" });
  const storage = new RealStorageV2({ executor, registry, workflowRunId: "handson" });

  // Build the real directory layout under the test root, then a sandbox over it.
  const keyword = args.keyword[args.keyword.length - 1];
  if (!keyword) throw new Error("--keyword is required");

  let stagingDirectoryId;
  let sandboxOpts;
  if (kind === "movie") {
    const movieDir = args["movie-cid"] ?? (await executor.createDirectory({ name: args.name, parentId }));
    console.log(`movie dir: ${movieDir}  (${args.name} under Movies ${parentId})`);
    stagingDirectoryId = movieDir; // movie: staging === movie dir (flatten in place).
    sandboxOpts = { stagingDirectoryId: movieDir, targetMovieDirectoryId: movieDir, need: ["MOVIE"] };
  } else {
    const season = Number(args.season ?? 1);
    const showDir = args["show-cid"] ?? (await executor.createDirectory({ name: args.name, parentId }));
    const seasonDir = args["season-cid"] ?? (await executor.createDirectory({ name: `Season ${season}`, parentId: showDir }));
    const stagingName = `.staging-handson-${args.season ?? 1}`;
    const stagingDir = args["staging-cid"] ?? (await executor.createDirectory({ name: stagingName, parentId: showDir }));
    console.log(`show dir:    ${showDir}  (${args.name} under TV ${parentId})`);
    console.log(`season ${season} dir: ${seasonDir}`);
    console.log(`staging dir: ${stagingDir}  (${stagingName}, under show — NEVER inside Season)`);
    stagingDirectoryId = stagingDir;
    sandboxOpts = {
      stagingDirectoryId: stagingDir,
      targetSeasonDirectoryIds: { [season]: seasonDir },
      need: [`S${String(season).padStart(2, "0")}E01`],
    };
  }

  const sandbox = new TaskSandbox({ provider, storage, ...sandboxOpts });
  const search = await sandbox.searchResources(keyword);
  if (!search.snapshot) throw new Error(`search returned no snapshot: ${j(search)}`);

  // auto: iterate VETTED 115-share candidates until one 秒传-succeeds — the agent's
  // real death-link recovery loop. The candidate SET must be agent-vetted, NOT the
  // raw result list: a wildcard search mixes in same-named DIFFERENT works (姐姐妹妹
  // 抓娃娃 / 葫芦小金刚 under "抓娃娃"). So --title-filter is REQUIRED: I (playing the
  // agent) keep only candidates whose title genuinely is the target before iterating.
  let result;
  if (args.candidate === "auto") {
    if (!args["title-filter"]) {
      throw new Error("auto requires --title-filter (vet the candidate set by title first; never iterate the raw wildcard results)");
    }
    const shares = search.snapshot.candidates.filter(
      (c) =>
        c.title.includes(args["title-filter"]) &&
        /https?:\/\/(115cdn\.com|115\.com)\/s\//.test(String(registry.get(c.id)?.providerPayload?.url ?? "")),
    );
    const cap = Math.min(shares.length, Number(args.max ?? 14));
    console.log(`\nauto: ${shares.length} VETTED 115-share candidates (title ⊇ "${args["title-filter"]}"); trying up to ${cap}`);
    for (let i = 0; i < cap; i += 1) {
      const c = shares[i];
      const attempt = await sandbox.transferCandidate({ snapshotId: search.snapshot.id, candidateId: c.id });
      const msg = storage.attempts().at(-1)?.providerMessage;
      console.log(`  [${i}] ${attempt.attempt.status.padEnd(9)} "${msg ?? ""}"  ← ${c.title.slice(0, 70)}`);
      if (attempt.attempt.status === "succeeded") { result = attempt; break; }
    }
    if (!result) throw new Error("auto: no 115-share candidate 秒传-succeeded");
  } else {
    const candidate = pickCandidate(search.snapshot, args.candidate, registry);
    console.log(`\nchosen candidate: id=${candidate.id}\n  title=${candidate.title}`);
    console.log(`\n=== transferCandidate → staging ${stagingDirectoryId} (real 115; ~1.2s/call pacing) ===`);
    result = await sandbox.transferCandidate({ snapshotId: search.snapshot.id, candidateId: candidate.id });
    console.log(`\nattempt: ${j(result.attempt)}`);
    console.log(`full attempt (with providerMessage): ${j(storage.attempts().at(-1))}`);
  }
  printTree("staging after transfer (forced reread)", result.staging);
  const dirs = await sandbox.inspectStagingDirs();
  console.log(`\ninspectStagingDirs (wrapper subdirs): ${j(dirs)}`);
  console.log(`\n--- chain hints ---`);
  console.log(`staging cid = ${stagingDirectoryId}`);
  if (kind !== "movie") console.log(`season-map  = ${j(sandboxOpts.targetSeasonDirectoryIds)}`);
}

/** Drive the REAL movie-only sandbox.transferUntilLanded over an AGENT-VETTED,
 *  ranked set of share candidates (I play the agent: vet by title; the tool takes
 *  fail-loud 转存分享 links — 115/夸克/天翼/123 — and rejects magnets). */
async function cmdTransferUntil(args) {
  const parentId = parentForKind("movie");
  if (!args.name) throw new Error("--name is required");
  const keyword = args.keyword[args.keyword.length - 1];
  if (!keyword) throw new Error("--keyword is required");
  if (!args.vet) throw new Error("--vet is required (title regex to keep ONLY the target film — agent vetting)");

  const executor = buildExecutor();
  const registry = new CandidateRegistry();
  const provider = new RealResourceProviderV2({ provider: createPanSou(), registry, workflowRunId: "handson" });
  const storage = new RealStorageV2({ executor, registry, workflowRunId: "handson" });
  const movieDir = args["movie-cid"] ?? (await executor.createDirectory({ name: args.name, parentId }));
  console.log(`movie dir: ${movieDir}  (${args.name})`);

  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId: movieDir,
    targetMovieDirectoryId: movieDir,
    need: ["MOVIE"],
  });
  const search = await sandbox.searchResources(keyword);
  if (!search.snapshot) throw new Error(`no snapshot: ${j(search)}`);

  const vet = new RegExp(args.vet, "i");
  // Agent vetting: keep ONLY candidates that are genuinely the target film AND are
  // fail-loud share links (115/夸克/天翼/123 转存分享 — the tool rejects magnets).
  // Rank most-descriptive-first (crude proxy: longer titles tend to be transparent rips).
  const vetted = search.snapshot.candidates
    .filter((c) => vet.test(c.title) && storage.candidateLinkKind(c.id) === "share")
    .sort((a, b) => b.title.length - a.title.length);
  console.log(`\nvetted+ranked share candidates (title ~ /${args.vet}/i):`);
  vetted.forEach((c, i) => console.log(`  ${i}. [${c.id}] ${c.title.slice(0, 80)}`));
  if (vetted.length === 0) throw new Error("no vetted share candidates — broaden the search/vet");

  console.log(`\n=== transferUntilLanded(${vetted.length} candidates) — stop at first 秒传 ===`);
  const result = await sandbox.transferUntilLanded({ candidateIds: vetted.map((c) => c.id) });
  console.log(`\nattempts: ${j(result.attempts)}`);
  console.log(`transferredCandidateId: ${result.transferredCandidateId}`);
  printTree("landed in movie dir", result.landed);
  console.log(`\n--- chain hints ---\nmovie cid = ${movieDir}`);
}

async function cmdInspect(args) {
  if (!args.cid) throw new Error("--cid is required");
  const executor = buildExecutor();
  const storage = new RealStorageV2({ executor, registry: new CandidateRegistry(), workflowRunId: "handson" });
  printTree(`listTree(${args.cid})`, await storage.listTree({ directoryId: args.cid }));
  console.log(`\nlistSubdirectories: ${j(await storage.listSubdirectories({ directoryId: args.cid }))}`);
}

async function cmdFlattenMovie(args) {
  if (!args["movie-cid"]) throw new Error("--movie-cid is required");
  const executor = buildExecutor();
  const storage = new RealStorageV2({ executor, registry: new CandidateRegistry(), workflowRunId: "handson" });
  const movieDir = args["movie-cid"];
  const sandbox = new TaskSandbox({
    provider: { search: async () => { throw new Error("no search in flatten mode"); } },
    storage,
    stagingDirectoryId: movieDir,
    targetMovieDirectoryId: movieDir,
    need: ["MOVIE"],
  });
  console.log(`\n=== flattenMovie() on ${movieDir} (dig out video+subs to root, remove wrappers) ===`);
  const result = await sandbox.flattenMovie();
  printTree("movie dir after flatten", result.movie);
}

async function cmdMove(args) {
  if (!args["staging-cid"]) throw new Error("--staging-cid is required");
  if (!args["season-map"]) throw new Error("--season-map is required (e.g. '{\"1\":\"<cid>\"}')");
  if (!args.plan) throw new Error("--plan is required (e.g. '[{\"season\":1,\"fileIds\":[\"..\"]}]')");
  const executor = buildExecutor();
  const storage = new RealStorageV2({ executor, registry: new CandidateRegistry(), workflowRunId: "handson" });
  const seasonMap = JSON.parse(args["season-map"]);
  const plan = JSON.parse(args.plan);
  const sandbox = new TaskSandbox({
    provider: { search: async () => { throw new Error("no search in move mode"); } },
    storage,
    stagingDirectoryId: args["staging-cid"],
    targetSeasonDirectoryIds: seasonMap,
    need: ["S01E01"],
  });
  console.log(`\n=== moveToSeason(${j(plan)}) (batch distribution, forced reread) ===`);
  const result = await sandbox.moveToSeason({ moves: plan });
  for (const [season, tree] of Object.entries(result.seasons)) printTree(`Season ${season} after move`, tree);
  printTree("staging remaining", result.staging);
}

async function cmdDiscard(args) {
  if (!args["staging-cid"]) throw new Error("--staging-cid is required");
  const executor = buildExecutor();
  const storage = new RealStorageV2({ executor, registry: new CandidateRegistry(), workflowRunId: "handson" });
  const sandbox = new TaskSandbox({
    provider: { search: async () => { throw new Error("no search in discard mode"); } },
    storage,
    stagingDirectoryId: args["staging-cid"],
    targetSeasonDirectoryIds: args["season-map"] ? JSON.parse(args["season-map"]) : { 1: "unused" },
    need: ["S01E01"],
  });
  console.log(`\n=== discardStaging() on ${args["staging-cid"]} ===`);
  console.log(j(await sandbox.discardStaging()));
}

const COMMANDS = {
  search: cmdSearch,
  transfer: cmdTransfer,
  "transfer-until": cmdTransferUntil,
  inspect: cmdInspect,
  "flatten-movie": cmdFlattenMovie,
  move: cmdMove,
  discard: cmdDiscard,
};

const [command, ...rest] = process.argv.slice(2);
const handler = COMMANDS[command];
if (!handler) {
  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error(`Commands: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(1);
}

await loadPan115Cookie(); // loads .env + sets PAN115_COOKIE from Postgres app_settings
await loadDeps();
console.log(`test root: ${process.env.MEDIA_TRACK_115_TEST_ROOT_CID}  (production ${PRODUCTION_CID} is protected/out-of-scope)`);
await handler(parseArgs(rest));
console.log("\n✓ done");
