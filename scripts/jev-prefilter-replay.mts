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
//
// Run:  OPENROUTER_API_KEY=… npx tsx scripts/jev-prefilter-replay.mts [limit]
//       … --sentinels-only        wording guard only (no labels.json needed)
//       … --replay-only [limit]   replay only
//       JEV_FAKE=1 …              stub judge, every score 0.95 — exercises the plumbing
//                                 and the FAIL path without a network call or a key.
import { readFileSync } from "node:fs";
import { JevPrefilterProvider, createJevJudge, classifyJevScore } from "../packages/workflow/src/index.js";
import type {
  JevJudge,
  JevJudgeTarget,
  ResourceProvider,
  ResourceSnapshot,
} from "../packages/workflow/src/index.js";

const args = process.argv.slice(2);
const runSentinels = !args.includes("--replay-only");
const runReplay = !args.includes("--sentinels-only");
const limitArg = args.find((a) => !a.startsWith("--"));
const limit = limitArg === undefined ? Infinity : Number(limitArg);

// The stub exists so the script itself can be exercised (and its exit codes proven)
// without spending a call. It scores everything 0.95, so every "drop" sentinel FAILS
// — that IS the dry-run signal: a green run under JEV_FAKE would mean the sentinels
// are not actually checking anything.
const fake = process.env.JEV_FAKE === "1";
const key = process.env.OPENROUTER_API_KEY;
if (!fake && !key) {
  console.log("SKIP: OPENROUTER_API_KEY not set");
  process.exit(0);
}
const judge: JevJudge = fake
  ? {
      judgeCandidates: async (input) => ({
        scores: Object.fromEntries(input.candidates.map((c) => [c.id, 0.95])),
        model: "fake-0.95",
      }),
    }
  : createJevJudge({ apiKey: key! });

// ─── 1. Wording sentinels ────────────────────────────────────────────────────
// `keep` = score ≥ 0.7, `notdrop` = ≥ 0.3 (kept, possibly flagged), `drop` = < 0.3.
type Expectation = "drop" | "notdrop" | "keep";
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
      { id: "s4", title: "权利交锋 2026 S01E08 1080p", expect: "notdrop" },
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

function sentinelHolds(score: number, expect: Expectation): boolean {
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
    for (const c of sentinel.candidates) {
      const score = result.scores[c.id];
      // classifyJevScore fails OPEN on a non-number, which would make a "keep"
      // sentinel pass on an unanswered question. An unanswered sentinel is a FAIL.
      const scored = typeof score === "number" && Number.isFinite(score);
      const ok = scored && sentinelHolds(score, c.expect);
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

  let total = 0, dropped = 0, floored = 0, selectedTitled = 0, selectedDropped = 0, skipped = 0, cost = 0;
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
    total += cands.length;
    dropped += out.prefilter.dropped.length;
    // Sub-threshold rows the containment floor kept: the cost side of the go/no-go
    // guarantee, so a wording change that quietly leans on the floor is visible here.
    floored += out.prefilter.floored?.length ?? 0;
    cost += out.prefilter.cost ?? 0;
    const kept = new Set(out.candidates.map((c) => c.id));
    for (const c of cands) {
      // Title-less rows (date headers, bare URLs) are never judged, so counting them
      // here would dilute the only metric that can veto this filter.
      const titled = c.title.trim() !== "" && !c.title.startsWith("📅") && !/^https?:\/\//i.test(c.title);
      if (r.selected.includes(c.id) && titled) {
        selectedTitled += 1;
        if (!kept.has(c.id)) {
          selectedDropped += 1;
          violations.push(`«${r.title}» ${c.title} p=${out.prefilter.scores[c.id]}`);
        }
      }
    }
  }
  console.log(`snapshots=${rows.length} skipped(fail-open)=${skipped} candidates=${total} dropped=${dropped} (${((100 * dropped) / total).toFixed(1)}%) floored=${floored} cost=$${cost.toFixed(3)}`);
  console.log(`agent-selected titled=${selectedTitled} dropped=${selectedDropped}`);
  for (const v of violations) console.log("  VIOLATION", v);
  if (selectedDropped > 0) {
    console.log("FAIL: prefilter dropped an agent-selected titled candidate");
    process.exit(1);
  }
  if (total > 0 && dropped / total < 0.4) { console.log("WARN: drop rate below 40% (soft metric)"); }
}

console.log("PASS");
