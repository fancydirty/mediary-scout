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
//      Hard assertion (go/no-go): no titled candidate the agent actually selected is
//      dropped. Soft metric: drop rate. Input: /tmp/jev-eval/labels.json (exported from
//      prod agent_decisions ⋈ resource_snapshots — see memory/jev-system-one-model.md).
//      labels.json carries no aliases (the export predates them); production always
//      passes TMDB aliases, so this replay is the HARSHER input: the containment floor
//      and the judge see the title only. A pass here is conservative.
//
// Run:  JEV_API_KEY=… [JEV_BASE_URL=https://api.typesafe.ai/v1/systemone] npx tsx scripts/jev-prefilter-replay.mts [limit]
//       (OPENROUTER_API_KEY is still honoured as the key when JEV_API_KEY is unset; the
//        default base URL is OpenRouter's decisions endpoint, same as production)
//       … --sentinels-only        wording guard only (no labels.json needed)
//       … --replay-only [limit]   replay only
//       … --dump <file>           one JSON line per replayed snapshot (truncated at start)
//       JEV_FAKE=1 …              stub judge, every score 0.95 — exercises the plumbing
//                                 and the FAIL path without a network call or a key.
//                                 Never a verdict: where a real run prints PASS, a fake
//                                 run prints NO VERDICT and exits 3.
// Exit codes: 0 PASS · 1 FAIL · 2 bad arguments · 3 NO VERDICT (JEV_FAKE, or no key —
// nothing was checked, and 0 is reserved for a run that actually measured).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  JevPrefilterProvider,
  createJevJudge,
  classifyJevScore,
  isTitleless,
  normalizedTargetNames,
  titleContainsAny,
} from "../packages/workflow/src/index.js";
import type {
  JevJudge,
  JevJudgeTarget,
  ResourceProvider,
  ResourceSnapshot,
} from "../packages/workflow/src/index.js";

const USAGE =
  "usage: [JEV_API_KEY=… [JEV_BASE_URL=…] | OPENROUTER_API_KEY=… | JEV_FAKE=1] npx tsx scripts/jev-prefilter-replay.mts [limit] " +
  "[--sentinels-only] [--replay-only] [--dump <file>]\n" +
  "       limit must be a positive integer (number of snapshots to replay).";

const args = process.argv.slice(2);
const runSentinels = !args.includes("--replay-only");
const runReplay = !args.includes("--sentinels-only");
// Both "only" switches together would run nothing and fall through to PASS.
if (!runSentinels && !runReplay) {
  console.log(USAGE);
  console.log("--sentinels-only and --replay-only are mutually exclusive.");
  process.exit(2);
}
// --dump <file>: write one JSON line per replayed snapshot (target, scores, dropped,
// floored) so the floor's cost can be broken down by title after the fact.
const dumpIdx = args.indexOf("--dump");
const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;
// A trailing --dump used to disable dumping silently, and `--dump --sentinels-only`
// truncated a file named "--sentinels-only" before running.
if (dumpIdx >= 0 && (dumpPath === undefined || dumpPath.startsWith("--"))) {
  console.log(USAGE);
  console.log("--dump needs a file path.");
  process.exit(2);
}
// A positional is a non-flag argument that is not the VALUE of --dump, so `50 --dump f`
// and `--dump f 50` parse identically. Matching the dump path by value (the old
// `limitArg === dumpPath`) was wrong for `--dump 50 50`: both the path and the limit
// are "50", the path wins the find(), and the limit is silently Infinity.
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--dump");
const limitArg = positional[0];
const limit = limitArg === undefined ? Infinity : Number(limitArg);
// A typo'd limit used to become NaN → slice(0, NaN) → zero rows → "PASS" on an empty
// replay. Refuse it at the boundary instead: this script's whole job is a go/no-go.
if (limitArg !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.log(USAGE);
  process.exit(2);
}
// Truncate up front so a re-run replaces the dump instead of appending to the last
// one — a half-old, half-new JSONL silently double-counts every per-title analysis.
if (dumpPath) writeFileSync(dumpPath, "");

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
// `floor` = the provider's containment floor must cover it; its score is printed for
// information only and never decides the case.
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

async function checkSentinels(): Promise<boolean> {
  let allOk = true;
  for (const sentinel of SENTINELS) {
    const result = await judge.judgeCandidates({
      target: sentinel.target,
      candidates: sentinel.candidates.map((c) => ({ id: c.id, title: c.title })),
    });
    const targetNames = normalizedTargetNames(sentinel.target);
    for (const c of sentinel.candidates) {
      const score = result.scores[c.id];
      // classifyJevScore fails OPEN on a non-number, which would make a "keep"
      // sentinel pass on an unanswered question. An unanswered sentinel is a FAIL.
      const scored = typeof score === "number" && Number.isFinite(score);
      const ok =
        c.expect === "floor"
          ? titleContainsAny(c.title, targetNames)
          : scored && sentinelHolds(score, c.expect);
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
}

// ─── 2. Production replay ────────────────────────────────────────────────────
type Row = {
  run_id: string;
  keyword: string;
  selected: string[];
  title: string | null;
  title_type: string | null;
  year: string | number | null;
  candidates: Array<{ id: string; type: string; title: string; source: string }> | null;
};

if (runReplay) {
  const rows: Row[] = JSON.parse(readFileSync("/tmp/jev-eval/labels.json", "utf8")).slice(0, limit);

  let replayed = 0, total = 0, dropped = 0, floored = 0, selectedTitled = 0, selectedDropped = 0, skipped = 0, cost = 0;
  const violations: string[] = [];
  for (const r of rows) {
    const cands = r.candidates ?? [];
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
    if (out.prefilter?.status !== "applied") { skipped += 1; continue; }
    replayed += 1;
    total += cands.length;
    dropped += out.prefilter.dropped.length;
    // Sub-threshold rows the containment floor kept: the cost side of the go/no-go
    // guarantee, so a wording change that quietly leans on the floor is visible here.
    floored += out.prefilter.floored?.length ?? 0;
    cost += out.prefilter.cost ?? 0;
    if (dumpPath) {
      appendFileSync(dumpPath, JSON.stringify({ run_id: r.run_id, title: r.title, title_type: r.title_type, year, keyword: r.keyword, selected: r.selected, candidates: cands.map((c) => c.title), scores: out.prefilter.scores, dropped: out.prefilter.dropped, floored: out.prefilter.floored ?? [] }) + "\n");
    }
    const kept = new Set(out.candidates.map((c) => c.id));
    for (const c of cands) {
      // Title-less rows (date headers, bare URLs) are never judged, so counting them
      // here would dilute the only metric that can veto this filter. The provider's own
      // predicate, not a copy: a divergence would measure a filter that is not the one
      // production runs.
      const titled = !isTitleless(c.title);
      if (r.selected.includes(c.id) && titled) {
        selectedTitled += 1;
        if (!kept.has(c.id)) {
          selectedDropped += 1;
          violations.push(`«${r.title}» ${c.title} p=${out.prefilter.scores[c.id]}`);
        }
      }
    }
  }
  // A replay that measured nothing (empty/filtered labels.json, every snapshot
  // fail-open) must never print PASS: this script is a go/no-go gate, and "no evidence"
  // is not "no violations". Checked before the summary, which is why its percent guard
  // below is moot — it stays anyway so the expression is safe on its own terms.
  if (total === 0) {
    console.log(`snapshots=0 skipped(fail-open)=${skipped} input-rows=${rows.length}`);
    console.log("FAIL: nothing replayed");
    process.exit(1);
  }
  // snapshots= counts what was REPLAYED, not what was read: rows.length included the
  // candidate-less and fail-open ones, so a run that measured 3 of 195 claimed 195.
  console.log(`snapshots=${replayed} skipped(fail-open)=${skipped} candidates=${total} dropped=${dropped} (${total === 0 ? "0.0" : ((100 * dropped) / total).toFixed(1)}%) floored=${floored} cost=$${cost.toFixed(3)}`);
  console.log(`agent-selected titled=${selectedTitled} dropped=${selectedDropped}`);
  for (const v of violations) console.log("  VIOLATION", v);
  if (selectedDropped > 0) {
    console.log("FAIL: prefilter dropped an agent-selected titled candidate");
    process.exit(1);
  }
  // Soft metric provenance: 48.4% batched without the containment floor (2026-09-20),
  // 32.2% with it — the floor keeps 1,604 sub-threshold rows whose title contains the
  // target (mostly 交锋联盟/寒蝉鸣泣之时 noise) to guarantee 0 selected-drop (it rescued
  // the 权利交锋 mislabel at p=0.04 and the real 攻壳机动队 2026 E01 at p=0.29). Those rows
  // still reach the agent flagged ⚠ with their score, so the cleanup is larger than the
  // raw drop rate suggests. Below 25% would mean the wording or the floor regressed.
  if (total > 0 && dropped / total < 0.25) { console.log("WARN: drop rate below 25% (soft metric)"); }
}

// The stub scores everything 0.95, so it can only ever reach this line with the
// sentinels skipped (--replay-only): nothing real was measured, and a PASS here would
// read as the production go/no-go.
if (fake) {
  console.log("NO VERDICT: JEV_FAKE stub judge — plumbing only, no real Jev call");
  process.exit(3);
}
console.log("PASS");
