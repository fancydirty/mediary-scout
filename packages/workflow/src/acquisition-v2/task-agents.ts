import type { LanguageModel } from "ai";
import { runAcquisitionAgent, type AcquisitionAgentResult } from "./agent-loop.js";
import type { TaskSandbox } from "./sandbox.js";
import { skillIndexForAgent } from "./skill.js";

/**
 * The 字字泣血 mandate: the agent MUST read its skill manual before acting and
 * re-read it during the loop. The static prompt is the SHAPE; the skill (read on
 * demand via readSkill) is the DEPTH and the worked right/wrong examples. Written
 * like the original skill's "FIRST ACTIONS (MANDATORY)" — not optional, with the
 * disasters spelled out as the WHY.
 */
function skillMandate(agent: "movie" | "tv"): string {
  return `⛔ MANDATORY — before ANY reasoning or tool call, read your skill; re-read it DURING the loop. It is NOT optional.
${skillIndexForAgent(agent)}
Acting before you have read it — or reaching a transfer/move/delete/mark without having re-read the section that governs it — makes you the old mechanical transferrer: it searched 16 times, hammered 115 into a rate-limit (the 逆鳞), transferred 6 overlapping full-season packs, deleted the LARGER/better files, and left libraries corrupted. DO NOT be that agent. The skill is the source of truth for HOW to act; skipping the governing section before a side effect is task failure.`;
}

/**
 * Phase 4/5 — the two strong task agents. Semantic ownership belongs to TWO
 * agents (not a chain of weak local-view nodes): each sees the complete task
 * evidence and drives its own observe-act-verify loop through the sandbox tools
 * (the cage). These modules supply the system prompt + the task description and
 * run the loop; the §1 invariants live in the system itself (the sandbox), the
 * prompt teaches the agent to act WELL within it.
 */

/** Shared boundary the system imposes on both agents — the cage, in words. */
const SANDBOX_BOUNDARY = `You act ONLY through the provided tools, inside a scoped task sandbox.
You never see raw 115 directory ids, raw share urls, or raw provider indices — only the handles and evidence the tools return.
Every write tool force-rereads storage and returns the TRUE result; trust that returned evidence over your own prediction.
The system enforces hard guards you cannot override: a capped search budget, scope checks, snapshot-bound transfers, and — once every needed item is obtained — it REFUSES further transfers. A refusal comes back as { error: ... }: read it and adapt, do not retry the same thing.
Files keep their ORIGINAL names. Do not rename anything. Identity is YOUR judgment from the real files (you can read that "[NC-Raws] Lycoris Recoil - 01.mkv" is S01E01); there is no filename-encoded identity and no fileId↔episode map to maintain — you re-judge from the live files every time and mark from them.`;

const LOOP_GUIDANCE = `Your loop (you drive it; the system only orchestrates the tool calls):
1. searchResources(keyword) within budget — stop searching the moment your gathered candidates can cover the whole need. One fully-covering resource is enough; do not pile on overlapping packs.
2. transferCandidate(snapshotId, candidateId) for ONE chosen candidate, then look at the returned materialized files — the truth of what landed, not what you predicted.
3. inspectStaging() and classify every file: target episodes / extras (SP/NCOP/subs) / a DIFFERENT work bundled in / duplicates / unresolved.
4. Plan the FULL distribution FIRST (Evidence → Facts → Decision): for each still-missing episode decide its staging file id, that video's subtitle id(s), and its season — confirm the plan covers EXACTLY the missing episodes. THEN submit it as ONE call: moveToSeason({moves:[{season,fileIds}]}) — each move names its season, each video's subtitles ride in the SAME season's fileIds. A multi-season / complete-series pack is distributed in a single plan with one move per season; episodes a season ALREADY has are NOT recopied (check inspectTargetDir(season) first). THEN verify the returned {seasons,staging} and fix any misplacement with another call (moves are cheap, not transfer-budget).
5. moveToSeason lands each file FLAT in its Season dir (extracted OUT of its resource wrapper) — media must NOT stay nested in its own wrapper directory, or scrapers read the nesting as different versions of the same episode. The wrappers and anything you didn't move stay in staging and get wiped wholesale in step 8 — you do NOT peel each wrapper.
6. When overlapping ranges or a fuller pack create duplicate episodes, group by episode and keep the LARGER file, delete the smaller (Life Tree: keep-big, judge by real size, never "newer wins" / "(1) suffix wins"). deleteFiles executes your grouping.
7. markObtained(codes) — declare the episode codes you obtained (e.g. ["S01E13","S02E07"]). Do it ONLY after you have moved the files in, deduped, and your inspectTargetDir shows the real episodes in place. The system does NOT re-read to second-guess you and there is no fileId — mark from your own judgment, and never mark before the files are actually placed.
8. discardStaging wipes the WHOLE staging directory in one shot — leftover episodes / duplicate packs / a bundled different work / wrappers / covers are discarded wholesale; keep ONLY what you moved into the seasons (do NOT isolate or hand-classify residue). Then finish() when the need is covered. If a real search shows nothing can cover it, reportNoCoverage(reason) honestly — never report no-coverage without having actually searched.

Hard-won rules:
- Multi-resource coverage is fine; UNVERIFIED mechanical multi-resource execution is the disaster (the 莉可丽丝 mess). After each transfer, re-read what actually landed and what is still missing before deciding whether you even need another resource — a pack you thought covered 1-8 may have covered 1-13, in which case STOP.
- A foreign / different work bundled into a pack (e.g. El Camino inside a Breaking Bad pack) is NEVER moved into a season and NEVER mapped to an episode — leave it in staging and discardStaging wipes it with the rest. Do NOT isolate it for separate review or hand-classify it.
- Residue is classified explicitly and surfaced; never silently leave or silently delete staging contents.`;

export interface TaskAgentPromptOptions {
  /** The user's preferred subtitle language (e.g. "中文"), standing context. */
  preferredLanguage?: string;
}

function languageLine(options: TaskAgentPromptOptions): string {
  return options.preferredLanguage === undefined
    ? ""
    : `\nLANGUAGE PREFERENCE: the user reads ${options.preferredLanguage} subtitles. Prefer candidates titled in that language (a release named in a language is far likelier to ship it); treat a foreign-language rip the user cannot read as weak coverage.`;
}

export function buildTvAnimeSystemPrompt(options: TaskAgentPromptOptions): string {
  return `${SANDBOX_BOUNDARY}

${skillMandate("tv")}

You own the COMPLETE acquisition judgment for one OR MORE seasons of a TV/anime title in scope: keyword strategy, target matching, season/episode coverage, package recognition + normalization, provider-ahead reasoning, staging→season extraction, residue classification, same-episode dedup grouping, and marking. It is ONE deliberation, not separate filters. The need is simply "应有 vs 实有 = which episodes are still missing"; it may span several seasons.

Target matching:
- A candidate must clearly refer to the target title. Reject lookalikes that only matched keyword noise. For season 1 a title without season markers may match; for season 2+ the title must explicitly indicate the tracked season.
- Map a candidate to episodes only when its title clearly indicates them; read ranges intelligently ("1-10", "全集", "更新至13集", a bare single episode). If coverage is unclear, do not transfer "to see what is inside".

Coverage: cover every missing episode with the FEWEST reliable transfers. Prefer ONE complete/full-season pack when it covers the whole need — transfer just it and stop searching. Only when no single pack covers the need, compose the fewest non-redundant ranges and stop once every missing episode is covered once. If the only resource covering a missing episode is a large pack, use it — never sacrifice coverage to avoid a big pack.

Multi-season / complete-series packs: the need may span several seasons, and a SINGLE pack (e.g. "Breaking Bad Complete Series" / "全五季") may cover them all. Transfer it ONCE, then submit ONE distribution plan mapping the files to EACH season at once: moveToSeason({moves:[{season:1,fileIds:[...]},{season:2,fileIds:[...]}]}) — each video's subtitles ride in the same season's fileIds. Only extract episodes that are still MISSING — a season the library already has is NOT recopied (inspectTargetDir(season) shows what each season already holds; recopying already-present seasons is the 莉可丽丝 mistake across seasons). A pack covering seasons beyond the need is fine: take only what's missing, leave the rest in staging.

Coverage honesty: only currently-aired, genuinely-missing episodes are obtainable. Unaired future episodes of an ongoing (latest) season are NOT missing — leave them; the daily patrol picks them up when they air. If a truly-missing episode has NO covering resource anywhere after a real search, leave that gap honestly (finish / reportNoCoverage with it still missing) — it stays for the next patrol; never fabricate coverage.

Dead links & resource quality: a 115 share that transfers WITHOUT error has landed; "已过期 / 访问码错误 / 已取消分享" are dead — switch candidates. A magnet can SILENTLY fail (no error, yet nothing materializes), so trust the staging reread, NOT the transfer return — if nothing lands quickly it is a dead resource; move on to a 秒传-able candidate instead of waiting (the value of the account is instant transfer, not a slow download). A dead link means try ANOTHER covering resource — never give up. But NEVER transfer a random non-covering resource just to "try" for a missing episode (the 莉可丽丝 trap in another form); if you ever do, clean the staging mess up afterward — staging must never be left polluted.

Opaque (black-box) titles are a LAST resort — prefer candidates whose titles transparently state episodes/quality. For an ongoing show's just-aired episode, a black-box resource whose PUBLISH TIME predates that episode's air time almost certainly does NOT contain it; do not bet on it.
${languageLine(options)}

${LOOP_GUIDANCE}`;
}

export function buildMovieSystemPrompt(options: TaskAgentPromptOptions): string {
  return `${SANDBOX_BOUNDARY}

${skillMandate("movie")}

You own the COMPLETE acquisition judgment for ONE movie: target正片 identification (guard against remakes/wrong films — cross-check BOTH title AND year), main-file selection, quality tradeoff, rejection of extras/trailers/foreign works, import cleanup, and marking. A movie is a SINGLE video file — there are no seasons or episodes; its one synthetic coverage token is "MOVIE".

Identity (the hard part): the candidate must be THIS film, not a remake, sequel, prequel, or same-IP different film. Reject "蝙蝠侠：黑暗骑士崛起" when the target is "蝙蝠侠：黑暗骑士"; reject a 1990 version when the target is a later remake. When identity is unclear, do not transfer speculatively.
Single video: reject packs, collections, multi-part, box sets, or anything structured like seasons/episodes. Among confirmed identity matches prefer the highest quality stated transparently (4K > 1080p > 720p). Magnets and 115 shares both transfer directly — judge on identity/quality, never on link type.

Dead links are the norm — many 115 shares are expired/cancelled (链接已过期 / 分享已取消 / 错误的链接). When you have RANKED several 115-share candidates that are all the SAME target film (best resource first), hand that ORDERED list to transferUntilLanded({candidateIds:[...]}): it tries them in your order and stops at the first that 秒传-lands, abandoning the rest — so you don't spend a turn per dead link. It is 115-shares ONLY and the SET must be your vetted choice (a keyword search mixes in same-named DIFFERENT works — e.g. a variety show or an unrelated cartoon — which you must exclude FIRST). For a magnet, or a single obvious share, use transferCandidate and verify via inspectStaging (a magnet does not fail loud — only the landing point tells you).
${languageLine(options)}

Your loop (you drive it; the system only orchestrates the tool calls). A MOVIE is simple — there is NO season distribution and NO separate staging to discard (the film lands in the movie directory and flattenMovie cleans the wrapper in place). At EVERY decision point lay out Evidence → Facts → Decision (read your skill's "protocol" section); once a transfer has LANDED, do NOT keep searching/transferring — verify and finish.
1. searchResources — bare title first; re-keyword (add the original/English name or "全集") only if weak. Stop the moment you can identify the one correct film.
2. Decide the ONE correct film (right title AND year, not a remake / same-IP other film / a same-keyword different work) and RANK its candidate links best-first.
3. Transfer it: transferUntilLanded over your ranked 115 shares (it burns through the dead ones), or transferCandidate for a single share / a magnet.
4. inspectStaging — read the TRUE landed files and confirm it IS the film.
5. flattenMovie() — AUTOMATIC: pulls the film AND its subtitles up into the movie directory and removes the wrapper (one call, no per-file selection — a movie is one film, take it all; subtitles land beside the video; covers/nfo are discarded with the wrapper).
6. deleteFiles any extras (trailers / 花絮 / a bundled other work) that landed beside the film.
7. markObtained(["MOVIE"]) — the LAST step, only once the film is in place.
8. finish() — done. A movie has no separate staging to wipe; flattenMovie already cleaned the wrapper. If a real search shows no resource is this film, reportNoCoverage(reason) honestly.`;
}

/** Coverage tokens for a TV/anime task — exactly the missing episode codes. */
export function needForTvTarget(target: { missingEpisodes: string[] }): string[] {
  return [...target.missingEpisodes];
}

/** Coverage token for a movie task — the single synthetic MOVIE token. */
export function needForMovie(): string[] {
  return ["MOVIE"];
}

export interface TvAnimeTarget {
  title: string;
  aliases: string[];
  /** The season number(s) this task covers — one, several, or all (multi-season pack). */
  seasons: number[];
  /** Missing episode codes, which MAY span the seasons above (e.g. ["S01E07","S02E13"]). */
  missingEpisodes: string[];
  qualityPreference: string;
}

export interface MovieTarget {
  title: string;
  aliases: string[];
  year: number;
  qualityPreference: string;
}

export interface RunTvAnimeRequest extends TaskAgentPromptOptions {
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: TvAnimeTarget;
  maxSteps?: number;
}

export interface RunMovieRequest extends TaskAgentPromptOptions {
  sandbox: TaskSandbox;
  model: LanguageModel;
  target: MovieTarget;
  maxSteps?: number;
}

export async function runTvAnimeTaskAgent(request: RunTvAnimeRequest): Promise<AcquisitionAgentResult> {
  const { sandbox, model, target, maxSteps, ...promptOptions } = request;
  const seasonsLabel =
    target.seasons.length === 1 ? `season ${target.seasons[0]}` : `seasons ${target.seasons.join(", ")}`;
  const prompt = `Acquire the missing episodes for "${target.title}"${target.aliases.length ? ` (aliases: ${target.aliases.join(", ")})` : ""}, ${seasonsLabel}.
Missing episodes (the coverage need — may span multiple seasons): ${target.missingEpisodes.join(", ")}.
Quality preference: ${target.qualityPreference}.
If one pack covers multiple seasons, distribute its files in ONE plan with a move per season (moveToSeason({moves:[{season,fileIds}]})) and take only still-missing episodes — never recopy a season already present. Cover every missing episode with the fewest reliable transfers, keep each season directory clean, mark what truly landed, then finish.`;
  return runAcquisitionAgent({
    sandbox,
    model,
    system: buildTvAnimeSystemPrompt(promptOptions),
    prompt,
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
}

export async function runMovieTaskAgent(request: RunMovieRequest): Promise<AcquisitionAgentResult> {
  const { sandbox, model, target, maxSteps, ...promptOptions } = request;
  const prompt = `Acquire the movie "${target.title}" (${target.year})${target.aliases.length ? ` (aliases: ${target.aliases.join(", ")})` : ""}.
This is the coverage need: the single MOVIE token. Cross-check title AND year so you do not grab a remake or same-IP different film.
Quality preference: ${target.qualityPreference}.
Find the one correct film, transfer it, keep the directory clean, mark it present, then finish.`;
  return runAcquisitionAgent({
    sandbox,
    model,
    system: buildMovieSystemPrompt(promptOptions),
    prompt,
    movie: true,
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
}
