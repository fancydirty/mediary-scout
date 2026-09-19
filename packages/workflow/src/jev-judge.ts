/**
 * Jev (TypeSafe "System One" decision model) judge port.
 *
 * The prefilter provider depends ONLY on this port; the real HTTP client lives in
 * jev-client.ts and tests pass a spy. Keeping the question wording here — and
 * exporting it — means the offline eval scripts and production ask the SAME
 * questions, so a wording tweak can never silently diverge from what was measured.
 */

export type JevTargetKind = "tv" | "movie";

export interface JevJudgeTarget {
  kind: JevTargetKind;
  title: string;
  aliases: string[];
  /** First-air / release year when known; undefined lets the year rule stay dormant. */
  year?: number;
}

export interface JevJudgeInput {
  target: JevJudgeTarget;
  candidates: Array<{ id: string; title: string }>;
}

export interface JevJudgeResult {
  /** candidateId → P(candidate refers to the target), 0..1. Missing id = not judged. */
  scores: Record<string, number>;
  model: string;
  inputTokens?: number;
  cost?: number;
  /** Chunks that failed; their candidates have no score. Absent when all chunks succeeded. */
  failedChunks?: number;
}

export interface JevJudge {
  judgeCandidates(input: JevJudgeInput): Promise<JevJudgeResult>;
}

/** The model every Jev call asks for. It lives beside the port rather than in the HTTP
 *  client because the PROVIDER also stamps it into SnapshotPrefilter on the paths where
 *  no judge answer carries a model name (skipped, failed, circuit-open) — a literal in
 *  either place would let the audit trail name a model that was never asked for.
 *  jev-client re-exports it, so `import { JEV_MODEL } from "./jev-client.js"` (and the
 *  web probe's package-level import) keep resolving. */
export const JEV_MODEL = "jev-latest";

/** Below this the candidate is dropped before the agent sees it. Reliability curve on
 *  9,958 titled production candidates: agent-selected rate in [0,0.3) is exactly 0%. */
export const JEV_DROP_BELOW = 0.3;
/** Below this (and ≥ JEV_DROP_BELOW) the candidate is kept but flagged 相关度存疑 —
 *  short Chinese titles collide here (《权利交锋》 vs 《交锋》) and only the agent can tell. */
export const JEV_UNCERTAIN_BELOW = 0.7;

/** The pair the provider stamps into SnapshotPrefilter.thresholds — derived from the
 *  constants above so the audit trail can never disagree with what was applied. */
export const JEV_THRESHOLDS = { dropBelow: JEV_DROP_BELOW, uncertainBelow: JEV_UNCERTAIN_BELOW } as const;

export type JevBand = "drop" | "uncertain" | "keep";

export function classifyJevScore(score: number): JevBand {
  // Fail OPEN on anything that is not a real number: null from a jsonb round-trip
  // of NaN, an unanswered question, a malformed response. A prefilter's only
  // unacceptable failure is dropping a good candidate — never drop on bad data.
  if (typeof score !== "number" || !Number.isFinite(score)) return "keep";
  if (score < JEV_DROP_BELOW) return "drop";
  if (score < JEV_UNCERTAIN_BELOW) return "uncertain";
  return "keep";
}

/** Loose title normalisation for containment checks: NFKC-folded, case-folded, whitespace
 *  and the usual title punctuation removed. NOT a matcher for identity — only for "the
 *  target's name appears verbatim inside this candidate title".
 *
 *  NFKC runs BEFORE the case fold on purpose: `"Ｔ".toLowerCase()` is the full-width `ｔ`,
 *  so folding case first would leave 《ＴＨＥ ＢＯＹＳ》 and "The Boys" as two different keys
 *  and the floor would silently miss the release names that use full-width latin. The
 *  full-width ＆＋＃ in the stripped set are already ASCII by then — they stay so the set
 *  still reads as a complete list of what a release name uses as a separator. */
export function normalizeTitleForContainment(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s《》〈〉「」『』()（）\[\]【】{}<>:：;；·・\-–—_.,，、。!！?？|/\\'"“”‘’~～*&＆+＋#＃]+/g, "");
}

/** The target's names, normalised once and with the unusable ones dropped (an empty or
 *  punctuation-only title/alias would make `includes` true for everything). Hoist this
 *  out of a candidate loop: the provider computes it once per search, not per row. */
export function normalizedTargetNames(target: { title: string; aliases: string[] }): string[] {
  const names: string[] = [];
  for (const name of [target.title, ...target.aliases]) {
    const normalized = normalizeTitleForContainment(name);
    if (normalized.length > 0) names.push(normalized);
  }
  return names;
}

/** True when the candidate title contains any of the already-normalised target names.
 *  An empty list floors nothing — see `titleContainsTarget` for what this is for. */
export function titleContainsAny(candidateTitle: string, normalizedNames: string[]): boolean {
  if (normalizedNames.length === 0) return false;
  const c = normalizeTitleForContainment(candidateTitle);
  if (!c) return false;
  return normalizedNames.some((n) => c.includes(n));
}

/** True when the candidate title contains the target title or any alias verbatim (after
 *  normalisation). Such a candidate is NEVER dropped by the prefilter, only flagged: an
 *  uploader mislabel like 《权利交锋》 for 《交锋》 scores 0.04 under every wording tried
 *  (old, asymmetric, hedged) yet was the pack the agent actually selected in production.
 *  A prefilter's only unacceptable failure is dropping the right one, so containment is a
 *  structural floor rather than a judgement — deliberately loose: 《交锋联盟》 floors too,
 *  keeps its low score, and the agent reads the title and decides.
 *
 *  Loose by design. Cost measured on 9,968 production candidates (2026-09-20): 1,604
 *  sub-threshold rows floored, 472 of them for the 1-character target 《蝉》 (寒蝉鸣泣之时
 *  noise) and 1,098 for 《交锋》 (交锋联盟). Every floored row still reaches the agent
 *  flagged with its score, so the cost is noise the agent already handled before the
 *  prefilter existed — never a wrong drop.
 *
 *  Convenience wrapper: a caller with more than one candidate should hoist
 *  `normalizedTargetNames` out of the loop and call `titleContainsAny`. */
export function titleContainsTarget(candidateTitle: string, target: { title: string; aliases: string[] }): boolean {
  return titleContainsAny(candidateTitle, normalizedTargetNames(target));
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

const TV_RULES =
  "同一IP的剧场版/电影/广播剧/有声书/漫画/游戏/衍生动画/综艺都不算这部剧集本身,必须判否。" +
  "`target.year` 是首播年份:候选标注年份比首播年份早2年及以上,必定是同名/近名的另一部作品,应判否;" +
  "标注年份晚于首播年份的可能是同一部剧的后续季,不能仅凭年份判否。" +
  "`target.aliases` 是原名/别名,候选用这些名字也算指向目标";

const MOVIE_RULES = "`target.aliases` 是原名/别名,候选用这些名字也算指向目标";

/** One noul per candidate key. Wording was tuned in the 2026-09-19 evals
 *  (identity 28/29, injection 8/9, season 20/20); change it only with a re-run.
 *
 *  2026-09-19: the tv year rule became ASYMMETRIC. The symmetric 「相差≥2」 form
 *  measured well on identity collisions (《锋刃(2015)又名交锋》 0.46→0.07) but would
 *  reject a long-running show's later seasons (first air 2016, S8 labelled 2024 →
 *  diff 8 → 否), silently dropping exactly what multi-season acquisition needs. Only
 *  the EARLIER side rejects now. Both directions are guarded by the wording sentinels
 *  in `scripts/jev-prefilter-replay.mts` — run it before changing this string. */
export function buildJevQuestions(
  target: { kind: JevTargetKind },
  candidateKeys: string[],
): Record<string, JevNoulQuestion> {
  const out: Record<string, JevNoulQuestion> = {};
  for (const key of candidateKeys) {
    out[key] = {
      type: "noul",
      instructions:
        target.kind === "movie"
          ? `\`candidates.${key}\` 明确是 \`target.title\`(\`target.year\`)这部电影本身,而不是续集/前传/翻拍/同IP不同片/同名综艺或动画。${MOVIE_RULES}`
          : `\`candidates.${key}\` 明确指向 \`target.title\` 这部剧集/动漫作品(不是仅关键词相似的其它作品;第1季可无季标记,第2季以上必须明确标出季)。${TV_RULES}`,
    };
  }
  return out;
}

/** Row suffix the agent sees for any KEPT candidate the judge was not confident about
 *  — the uncertain band, plus the sub-threshold rows the containment floor keeps (those
 *  reach the agent at their real 0.04, and presenting one as an ordinary result would be
 *  the dishonest half of the floor). "" for the keep band and for unjudged rows.
 *  Floors to 2 dp so a 0.699 never prints as "(0.70)" next to a "< 0.7" rule. The
 *  1e-9 nudge absorbs binary-float error (0.57 * 100 === 56.99999999999999, which a
 *  bare floor would print as 0.56 — a number the judge never produced). */
export function jevUncertaintyFlag(score: number | undefined): string {
  if (score === undefined || classifyJevScore(score) === "keep") return "";
  return ` ⚠ 相关度存疑(${(Math.floor(score * 100 + 1e-9) / 100).toFixed(2)})`;
}

/** One-line legend shown wherever at least one row carries the flag. Data, not
 *  prompt: the system prompt and tool descriptions stay untouched. */
export const JEV_UNCERTAIN_LEGEND =
  "⚠ 相关度存疑 = 系统按片名判断该候选可能是同名/近名的另一部作品(括号内为其判定的相关概率;标题含目标片名者即使概率很低也会保留给你)。这不是排除:请读标题与详情自行确认,该收的照收。";

/** Warning when the agent is looking at an empty candidate list and the prefilter
 *  dropped some. It deliberately does NOT claim the drop explains the whole empty
 *  result: dead-link filtering runs after the prefilter and can remove the rest, so
 *  「全部剔除」 would be an assertion the caller cannot actually make. */
export function jevAllDroppedWarning(dropped: number): string {
  return `本次搜索的候选中有 ${dropped} 个被系统按片名预筛剔除(同名/近名的其它作品或无关资源),剩余为空。这不是搜索源故障;可换 繁体/英文/原名 关键词再搜,若确认没有再 reportNoCoverage。`;
}
