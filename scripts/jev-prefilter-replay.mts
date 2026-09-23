// scripts/jev-prefilter-replay.mts
//
// Two guards on the Jev prefilter, both offline (no acquisition, no 115, no PanSou):
//
//   1. SENTINELS — a fixed set of hand-labelled titles that pin the question wording
//      in jev-judge.ts. They encode the cases the wording was tuned for AND the case
//      it must never regress into: a later season of a long-running show must not be
//      dropped on its year. Edit TV_RULES/MOVIE_RULES, re-run this, or you are
//      changing a filter's behaviour with no evidence.
//   2. REPLAY — REAL production search snapshots through the REAL JevPrefilterProvider
//      (fake inner provider returns the recorded snapshot; the judge is the real client).
//      Hard assertion (go/no-go): every titled candidate the agent actually selected was
//      judged AND kept. Soft metric: drop rate. Input: --labels <file>, exported from prod
//      agent_decisions ⋈ resource_snapshots (see memory/jev-system-one-model.md) — keep it
//      where only you can write, since it decides the verdict. labels.json carries no
//      aliases (the export predates them); production always passes TMDB aliases, so this
//      replay is the HARSHER input: the containment floor and the judge see the title only.
//      A pass here is conservative.
//
// Run:  JEV_API_KEY=… [JEV_BASE_URL=https://api.typesafe.ai/v1/systemone] npx tsx scripts/jev-prefilter-replay.mts --labels <file> [limit]
//       (OPENROUTER_API_KEY is still honoured as the key when JEV_API_KEY is unset; the
//        default base URL is OpenRouter's decisions endpoint, same as production)
//       … --sentinels-only                wording guard only (no --labels)
//       … --replay-only --labels <file>   replay only
//       … --dump <file>                   one JSON line per replayed snapshot; emptied at the
//                                         start, once the arguments, the input and the key
//                                         have all checked out
//       Options take their value as the next argument (--name value, never --name=value);
//       an unknown or repeated option, or a second positional, is refused.
//       JEV_FAKE=1 …                      stub judge, every score 0.95, no network call and no
//                                         key: the drop sentinels FAIL (exit 1) — that is its
//                                         self-check — and --replay-only ends in NO VERDICT.
//                                         It never prints PASS.
// Exit codes: 0 PASS — the sentinels held and every agent-selected titled candidate in the
// replay was judged and kept · 1 FAIL — a sentinel broke, or the replay dropped a selected
// candidate · 2 bad arguments or input (every --labels row is checked against the export's
// shape before any Jev call) · 3 NO VERDICT — the evidence is incomplete: no key, JEV_FAKE,
// a partial mode (--sentinels-only / --replay-only), the judge unreachable during the
// sentinels, nothing replayed, a selected id with no candidate in its row (no snapshot, or
// the wrong one, in the export), or a selected candidate the judge never scored (its
// snapshot failed open, or its chunk failed). 0 is reserved for a run that measured.
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JevPrefilterProvider, createJevJudge, classifyJevScore, isTitleless } from "../packages/workflow/src/index.js";
import type { JevJudge, JevJudgeTarget, ResourceProvider, ResourceSnapshot } from "../packages/workflow/src/index.js";

const USAGE =
  "usage: [JEV_API_KEY=… [JEV_BASE_URL=…] | OPENROUTER_API_KEY=… | JEV_FAKE=1] npx tsx scripts/jev-prefilter-replay.mts " +
  "--labels <labels.json> [limit] [--dump <file>] [--sentinels-only | --replay-only]\n" +
  "       limit must be a positive integer (number of snapshots to replay); --sentinels-only takes no --labels / limit / --dump.";
function usageError(message: string): never {
  console.log(USAGE);
  console.log(message);
  process.exit(2);
}

// A whitelist: an unknown option (a typo'd --replay-only, a --dump=file form) used to be
// dropped silently, and any stray word became the limit.
const VALUED = new Set(["labels", "dump"]);
const SWITCHES = new Set(["sentinels-only", "replay-only"]);
const values = new Map<string, string>();
const switches = new Set<string>();
const positional: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (!arg.startsWith("--")) { positional.push(arg); continue; }
  const name = arg.slice(2);
  if (values.has(name) || switches.has(name)) usageError(`${arg} given twice`);
  if (SWITCHES.has(name)) { switches.add(name); continue; }
  if (!VALUED.has(name)) usageError(`unknown option ${arg}${name.includes("=") ? " (write --name value, not --name=value)" : ""}`);
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) usageError(`${arg} needs a value`);
  values.set(name, value);
  i += 1;
}
const runSentinels = !switches.has("replay-only");
const runReplay = !switches.has("sentinels-only");
// Both "only" switches together would run nothing.
if (!runSentinels && !runReplay) usageError("--sentinels-only and --replay-only are mutually exclusive.");
if (positional.length > 1) usageError(`at most one positional argument (the limit), got: ${positional.join(" ")}`);
const labelsPath = values.get("labels");
// --dump <file>: write one JSON line per replayed snapshot (target, scores, dropped,
// floored) so the floor's cost can be broken down by title after the fact.
const dumpPath = values.get("dump");
const limitArg = positional[0];
const limit = limitArg === undefined ? Infinity : Number(limitArg);
// A typo'd limit used to become NaN → slice(0, NaN) → zero rows → "PASS" on an empty
// replay. Refuse it at the boundary instead: this script's whole job is a go/no-go.
if (limitArg !== undefined && (!Number.isInteger(limit) || limit <= 0)) usageError(`bad limit "${limitArg}"`);
if (!runReplay && (labelsPath !== undefined || dumpPath !== undefined || limitArg !== undefined)) {
  usageError("--sentinels-only runs no replay: --labels, --dump and a limit would be ignored.");
}
if (runReplay && labelsPath === undefined) usageError("the replay needs --labels <file> (the export described above).");
if (dumpPath !== undefined) {
  if (existsSync(dumpPath) && !statSync(dumpPath).isFile()) usageError(`--dump ${dumpPath} is not a regular file.`);
  const same = (a: string, b: string) => {
    if (resolve(a) === resolve(b)) return true;
    try { return realpathSync(a) === realpathSync(b); } catch { return false; }
  };
  // The dump is emptied at the start: pointed at the input, it would wipe the labels.
  if (labelsPath !== undefined && same(dumpPath, labelsPath)) usageError("--dump names the --labels input; it would be emptied.");
}

// ─── Production replay input ─────────────────────────────────────────────────
type Row = {
  run_id: string;
  keyword: string;
  selected: string[];
  title?: string | null;
  title_type?: string | null;
  year?: string | number | null;
  /** null: the export found no snapshot for this decision. */
  candidates: Array<{ id: string; type: string; title: string; source: string }> | null;
};
/** The export's shape, checked for EVERY row before any Jev call: a malformed row used to
 *  crash mid-replay (exit 1, which reads as FAIL) or be skipped without a word. */
function rowProblem(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return "not an object";
  const r = row as Record<string, unknown>;
  for (const key of ["run_id", "keyword"] as const) if (typeof r[key] !== "string") return `${key} must be a string`;
  for (const key of ["title", "title_type"] as const) {
    if (r[key] !== undefined && r[key] !== null && typeof r[key] !== "string") return `${key} must be a string or null`;
  }
  if (r.year !== undefined && r.year !== null && typeof r.year !== "string" && typeof r.year !== "number") return "year must be a number, a string or null";
  if (!Array.isArray(r.selected) || r.selected.some((id) => typeof id !== "string")) return "selected must be an array of candidate ids";
  if (r.candidates === null) return undefined;
  if (!Array.isArray(r.candidates)) return "candidates must be an array (or null when the export has no snapshot)";
  for (const [i, c] of r.candidates.entries()) {
    if (typeof c !== "object" || c === null) return `candidates[${i}] is not an object`;
    const candidate = c as Record<string, unknown>;
    for (const key of ["id", "title", "type", "source"] as const) {
      if (typeof candidate[key] !== "string") return `candidates[${i}].${key} must be a string`;
    }
  }
  return undefined;
}
let rows: Row[] = [];
if (runReplay) {
  try {
    const parsed: unknown = JSON.parse(readFileSync(labelsPath!, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("not a JSON array");
    parsed.forEach((row, i) => {
      const problem = rowProblem(row);
      if (problem !== undefined) throw new Error(`row ${i + 1}: ${problem}`);
    });
    rows = (parsed as Row[]).slice(0, limit);
  } catch (error) {
    usageError(`--labels ${labelsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The stub exists so the script itself can be exercised (and its exit codes proven)
// without spending a call. It scores everything 0.95, so every "drop" sentinel FAILS
// — that IS the dry-run signal: a green run under JEV_FAKE would mean the sentinels
// are not actually checking anything.
const fake = process.env.JEV_FAKE === "1";
// Key source is the operator's choice (OpenRouter or TypeSafe's own console) — exactly
// like the settings page; the base URL follows the same override rule as production.
const key = process.env.JEV_API_KEY || process.env.OPENROUTER_API_KEY;
const baseUrl = process.env.JEV_BASE_URL;
if (!fake && !key) {
  console.log("NO VERDICT: neither JEV_API_KEY nor OPENROUTER_API_KEY is set — nothing was checked");
  process.exit(3);
}
// Only now — arguments, input and key all checked — does the run touch a file. Emptied up
// front so a re-run replaces the dump instead of appending to the last one: a half-old,
// half-new JSONL silently double-counts every per-title analysis.
if (dumpPath !== undefined) {
  try {
    writeFileSync(dumpPath, "");
  } catch (error) {
    usageError(`--dump ${dumpPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const judge: JevJudge = fake
  ? {
      judgeCandidates: async (input) => ({
        scores: Object.fromEntries(input.candidates.map((c) => [c.id, 0.95])),
        model: "fake-0.95",
      }),
    }
  : createJevJudge({ apiKey: key!, ...(baseUrl ? { baseUrl } : {}) });

// ─── 1. Wording sentinels ────────────────────────────────────────────────────
// `keep` = score ≥ 0.7, `notdrop` = ≥ 0.3 (kept, possibly flagged), `drop` = < 0.3,
// `floor` = the provider's containment floor must cover it: checked THROUGH the provider
// with the judge's answer forced to 0, so deleting the floor branch fails it. Its real
// score is printed for information only and never decides the case.
type Expectation = "drop" | "notdrop" | "keep" | "floor";
interface Sentinel {
  target: JevJudgeTarget;
  candidates: Array<{ id: string; title: string; expect: Expectation }>;
}

const SENTINELS: Sentinel[] = [
  {
    // The identity collision the year rule was introduced for, plus the near-name
    // (《权利交锋》) that must survive into the agent's uncertain band.
    target: { kind: "tv", title: "交锋", aliases: [], year: 2026 },
    candidates: [
      { id: "s1", title: "《锋刃》(2015) 又名 交锋 全集", expect: "drop" },
      { id: "s2", title: "交锋(2015)全38集 国语中字", expect: "drop" },
      { id: "s3", title: "交锋 2026 全24集 4K 国语中字", expect: "keep" },
      // Wording cannot separate this uploader mislabel from the real 交锋 (0.04 in a
      // 97-row production batch, 0.64 in this 4-row batch — batch composition sharpens
      // the contrast); the guarantee lives in the provider's containment floor, so this
      // sentinel pins the floor, not the judge.
      { id: "s4", title: "权利交锋 2026 S01E08 1080p", expect: "floor" },
    ],
  },
  {
    // Later-arc anime: the arc is the same series (must survive), the 剧场版 is not.
    target: { kind: "tv", title: "鬼灭之刃", aliases: ["Kimetsu no Yaiba"], year: 2019 },
    candidates: [
      { id: "s1", title: "鬼灭之刃 柱训练篇 (2024) 全8集", expect: "notdrop" },
      { id: "s2", title: "鬼灭之刃 无限城篇 剧场版 (2025) 4K", expect: "drop" },
    ],
  },
  {
    // The regression the asymmetric rule exists to prevent: a later season labelled
    // years after first air must never be dropped on the year alone.
    target: { kind: "tv", title: "葬送的芙莉莲", aliases: ["Sousou no Frieren"], year: 2023 },
    candidates: [
      { id: "s1", title: "葬送的芙莉莲 第二季 (2026) 01-04 1080p", expect: "notdrop" },
      { id: "s2", title: "葬送的芙莉莲 (2023) 全28集", expect: "keep" },
    ],
  },
  {
    // Remake vs original: the EARLIER side of the rule, which still rejects.
    target: { kind: "tv", title: "神雕侠侣", aliases: [], year: 2014 },
    candidates: [
      { id: "s1", title: "神雕侠侣 1995 古天乐版 全32集", expect: "drop" },
      { id: "s2", title: "神雕侠侣 2014 陈晓版 全54集", expect: "keep" },
    ],
  },
  {
    // Movies are symmetric by design: a sequel and a remake are both other films.
    target: { kind: "movie", title: "沙丘", aliases: ["Dune"], year: 2021 },
    candidates: [
      { id: "s1", title: "沙丘2 (2024) 4K HDR", expect: "drop" },
      { id: "s2", title: "沙丘 1984 大卫林奇版", expect: "drop" },
      { id: "s3", title: "沙丘 (2021) 4K REMUX 中字", expect: "keep" },
    ],
  },
];

function sentinelHolds(score: number, expect: Exclude<Expectation, "floor">): boolean {
  const band = classifyJevScore(score);
  if (expect === "drop") return band === "drop";
  if (expect === "keep") return band === "keep";
  return band !== "drop";
}

/** The floor is the provider's guarantee, so it is checked through the provider: the
 *  judge's answer for the row is forced to 0 (the worst it could say), and the row must
 *  come back kept AND recorded as floored. A check on the containment helper alone would
 *  keep passing with the provider's floor branch deleted. */
async function floorHolds(target: JevJudgeTarget, c: { id: string; title: string }): Promise<boolean> {
  const snapshot: ResourceSnapshot = {
    id: "floor-probe", provider: "sentinel", keyword: target.title, createdAt: new Date(0).toISOString(),
    candidates: [{ id: c.id, snapshotId: "floor-probe", index: 0, title: c.title, type: "115", source: "sentinel", providerPayload: {} }],
  };
  const worst: JevJudge = {
    judgeCandidates: async (input) => ({ scores: Object.fromEntries(input.candidates.map((x) => [x.id, 0])), model: "floor-probe" }),
  };
  const out = await new JevPrefilterProvider({ inner: { search: async () => snapshot }, target, judge: worst, log: () => {} }).search({ keyword: target.title });
  return out.candidates.some((x) => x.id === c.id) && (out.prefilter?.floored ?? []).some((f) => f.id === c.id);
}

async function checkSentinels(): Promise<boolean> {
  let allOk = true;
  for (const sentinel of SENTINELS) {
    let result: Awaited<ReturnType<JevJudge["judgeCandidates"]>>;
    try {
      result = await judge.judgeCandidates({
        target: sentinel.target,
        candidates: sentinel.candidates.map((c) => ({ id: c.id, title: c.title })),
      });
    } catch (error) {
      // No answer at all (HTTP error, timeout, network): the wording was not measured,
      // which is not the same as the wording being wrong.
      console.log(`NO VERDICT: the judge did not answer the «${sentinel.target.title}» sentinels (${error instanceof Error ? error.message : String(error)}) — nothing was measured`);
      process.exit(3);
    }
    for (const c of sentinel.candidates) {
      const score = result.scores[c.id];
      // classifyJevScore fails OPEN on a non-number, which would make a "keep"
      // sentinel pass on an unanswered question. An unanswered sentinel is a FAIL.
      const scored = typeof score === "number" && Number.isFinite(score);
      const ok = c.expect === "floor" ? await floorHolds(sentinel.target, c) : scored && sentinelHolds(score, c.expect);
      if (!ok) allOk = false;
      const p = scored ? score.toFixed(2) : "n/a";
      console.log(`SENTINEL ${ok ? "ok" : "FAIL"} «${sentinel.target.title}» ${c.title} p=${p} expected=${c.expect}`);
    }
  }
  return allOk;
}

if (runSentinels) {
  const ok = await checkSentinels();
  if (!ok) {
    console.log("FAIL: sentinel");
    process.exit(1);
  }
  console.log("sentinels: all ok");
}

// ─── 2. Production replay ────────────────────────────────────────────────────
if (runReplay) {
  let replayed = 0, total = 0, dropped = 0, floored = 0, failedOpen = 0, partial = 0, noSnapshot = 0, cost = 0;
  // Agent-selected titled candidates: judged-and-kept, dropped, or never scored at all; and
  // picks with no candidate in their row at all, which nothing here can check.
  let selectedJudged = 0, selectedDropped = 0, selectedUnjudged = 0, selectedMissing = 0;
  const violations: string[] = [];
  for (const r of rows) {
    const cands = r.candidates ?? [];
    const selected = new Set(r.selected);
    const candidateIds = new Set(cands.map((c) => c.id));
    selectedMissing += [...selected].filter((id) => !candidateIds.has(id)).length;
    if (r.candidates === null) noSnapshot += 1;
    if (cands.length === 0) continue;
    const snap: ResourceSnapshot = {
      id: r.run_id, provider: "replay", keyword: r.keyword, createdAt: new Date().toISOString(),
      candidates: cands.map((c, index) => ({ id: c.id, snapshotId: r.run_id, index, title: c.title, type: c.type as ResourceSnapshot["candidates"][number]["type"], source: c.source, providerPayload: {} })),
    };
    const inner: ResourceProvider = { search: async () => snap };
    // anime rides the tv question (it is a series, not a film) — same mapping as
    // the orchestrator's jevTargetOf.
    const kind = r.title_type === "movie" ? "movie" : "tv";
    // Same guard as the orchestrator's jevTargetOf: a 0 / NaN year must never reach
    // the judge, or its year rule rejects every dated candidate and the replay would
    // be measuring a target production never sends. Today's export has none, but a
    // future one silently would.
    const y = Number(r.year);
    const year = Number.isFinite(y) && y > 0 ? y : undefined;
    const p = new JevPrefilterProvider({
      inner, judge, log: () => {},
      target: { kind, title: r.title ?? r.keyword, aliases: [], ...(year === undefined ? {} : { year }) },
    });
    const out = await p.search({ keyword: r.keyword });
    // Title-less rows (date headers, bare URLs) are never judged, so counting them here
    // would dilute the only metric that can veto this filter. The provider's own
    // predicate, not a copy: a divergence would measure a filter that is not the one
    // production runs.
    const selectedTitled = cands.filter((c) => selected.has(c.id) && !isTitleless(c.title));
    if (out.prefilter?.status !== "applied") {
      // Failed open: every candidate went through unjudged. ("skipped" = nothing
      // judgeable, so it holds no titled candidate and adds nothing below.)
      if (out.prefilter?.status === "failed") failedOpen += 1;
      selectedUnjudged += selectedTitled.length;
      continue;
    }
    replayed += 1;
    if ((out.prefilter.failedChunks ?? 0) > 0) partial += 1;
    total += cands.length;
    dropped += out.prefilter.dropped.length;
    // Sub-threshold rows the containment floor kept: the cost side of the go/no-go
    // guarantee, so a wording change that quietly leans on the floor is visible here.
    floored += out.prefilter.floored?.length ?? 0;
    cost += out.prefilter.cost ?? 0;
    if (dumpPath !== undefined) {
      appendFileSync(dumpPath, JSON.stringify({ run_id: r.run_id, title: r.title, title_type: r.title_type, year, keyword: r.keyword, selected: r.selected, candidates: cands.map((c) => c.title), scores: out.prefilter.scores, dropped: out.prefilter.dropped, floored: out.prefilter.floored ?? [] }) + "\n");
    }
    const kept = new Set(out.candidates.map((c) => c.id));
    for (const c of selectedTitled) {
      if (!kept.has(c.id)) {
        selectedDropped += 1;
        violations.push(`«${r.title}» ${c.title} p=${out.prefilter.scores[c.id]}`);
      } else if (typeof out.prefilter.scores[c.id] !== "number") {
        // Kept only because nothing scored it (its chunk failed): it proves nothing.
        selectedUnjudged += 1;
      } else {
        selectedJudged += 1;
      }
    }
  }
  // snapshots= counts what was REPLAYED, not what was read: rows.length includes the
  // candidate-less and failed-open ones.
  console.log(`snapshots=${replayed} failed-open=${failedOpen} partial=${partial} no-snapshot=${noSnapshot} input-rows=${rows.length} candidates=${total} dropped=${dropped} (${total === 0 ? "0.0" : ((100 * dropped) / total).toFixed(1)}%) floored=${floored} cost=$${cost.toFixed(3)}`);
  console.log(`agent-selected titled: judged+kept=${selectedJudged} dropped=${selectedDropped} never-scored=${selectedUnjudged}; picks not in their row's candidates=${selectedMissing}`);
  for (const v of violations) console.log("  VIOLATION", v);
  if (selectedDropped > 0) {
    console.log("FAIL: prefilter dropped an agent-selected titled candidate");
    process.exit(1);
  }
  // "No violations" is only a PASS when the hard check had something to hold: a replay
  // that measured nothing (empty labels, every snapshot failed open), or that could not
  // check some of the agent's picks (not in their row's candidates, a failed-open
  // snapshot, a failed chunk), cannot vouch for the picks it never judged.
  if (total === 0 || selectedMissing > 0 || selectedUnjudged > 0 || selectedJudged === 0) {
    const why =
      total === 0
        ? "nothing was replayed"
        : selectedMissing > 0
          ? `${selectedMissing} agent-selected id(s) are not among their row's candidates (the export has no snapshot, or the wrong one, for them) — fix the export`
          : selectedUnjudged > 0
            ? `${selectedUnjudged} agent-selected candidate(s) were never scored (failed-open snapshot or failed chunk) — re-run`
            : "no agent-selected titled candidate was judged";
    console.log(`NO VERDICT: ${why}`);
    process.exit(3);
  }
  // Soft metric provenance: 48.4% batched without the containment floor (2026-09-20),
  // 32.2% with it — the floor keeps 1,604 sub-threshold rows whose title contains the
  // target (mostly 交锋联盟/寒蝉鸣泣之时 noise) to guarantee 0 selected-drop (it rescued
  // the 权利交锋 mislabel at p=0.04 and the real 攻壳机动队 2026 E01 at p=0.29). Those rows
  // still reach the agent flagged ⚠ with their score, so the cleanup is larger than the
  // raw drop rate suggests. Below 25% would mean the wording or the floor regressed.
  if (dropped / total < 0.25) console.log("WARN: drop rate below 25% (soft metric)");
  if (partial > 0 || failedOpen > 0) console.log("WARN: the drop rate covers only the snapshots the judge answered in full");
}

// The stub scores everything 0.95, so it can only ever reach this line with the
// sentinels skipped (--replay-only): nothing real was measured, and a PASS here would
// read as the production go/no-go.
if (fake) {
  console.log("NO VERDICT: JEV_FAKE stub judge — plumbing only, no real Jev call");
  process.exit(3);
}
// A partial mode checked one guard; PASS/exit 0 is the claim that both held.
if (!runReplay || !runSentinels) {
  console.log(`NO VERDICT: ${runReplay ? "--replay-only skipped the wording sentinels" : "--sentinels-only skipped the replay (the go/no-go check)"}`);
  process.exit(3);
}
console.log("PASS");
