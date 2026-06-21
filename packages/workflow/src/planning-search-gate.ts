/**
 * Deterministic guardrails for the planning agents' searchResources tool.
 *
 * The Mimo model does not reliably obey "be economical" prompt guidance — a
 * single TV/anime planning loop was observed issuing 16 PanSou searches, most
 * of them trivial keyword variants of one another. Each PanSou call costs
 * ~10-25s, so the thrash dominated wall-clock time.
 *
 * Two guardrails enforced at the tool boundary (the model cannot override
 * them, unlike prompt text):
 *  - DEDUP: a keyword already searched this run returns the prior snapshot
 *    without re-hitting the provider. This is loss-free — re-searching the same
 *    keyword yields the same candidates — and removes the dominant time cost.
 *  - BUDGET: a generous cap on the number of DISTINCT searches per run, so even
 *    a thrashing model cannot burn unbounded provider calls. Set well above the
 *    handful of genuinely-useful keyword variants (title, aliases, original
 *    title, source-material name, a media-type/quality-prefixed retry), so it
 *    never truncates legitimate coverage searching — it only stops the thrash.
 */

export type SearchGateDecision = "fresh" | "duplicate" | "exhausted";

/** Generous distinct-search ceiling — above real need, below the observed thrash. */
export const MAX_DISTINCT_PLANNING_SEARCHES = 8;

/**
 * Fold trivial keyword variants together (whitespace/case) so the model cannot
 * defeat dedup by re-searching "孤独摇滚 " or "Bocchi The ROCK".
 */
export function normalizeSearchKeyword(keyword: string): string {
  return keyword.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Normalize for title-substring matching: lowercase + drop whitespace and the
 *  common separators that differ between a title and a search keyword, so
 *  "Citizen Vigilante 2026" contains "citizen vigilante" and "公民义警 电影"
 *  contains "公民义警". */
function normalizeForTitleMatch(value: string): string {
  return value.toLowerCase().replace(/[\s·:：\-_.,，、。]/g, "");
}

/**
 * A search keyword MUST reference the title — it has to contain the title, its
 * original title, or an alias (after normalization). Blocks the agent's
 * desperate genre/year-only fallbacks ("2026 电影", "电影") that can never find a
 * specific film and only return noise. Fails OPEN when no usable title terms are
 * known (tests / unscoped sandboxes) so it never wrongly blocks a real search.
 */
export function keywordReferencesTitle(keyword: string, titleTerms: readonly string[]): boolean {
  const terms = titleTerms.map(normalizeForTitleMatch).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return true;
  }
  const normalizedKeyword = normalizeForTitleMatch(keyword);
  return terms.some((term) => normalizedKeyword.includes(term));
}

export function decideSearchGate(args: {
  normalizedKeyword: string;
  seenKeywords: ReadonlySet<string>;
  maxDistinctSearches: number;
}): SearchGateDecision {
  if (args.seenKeywords.has(args.normalizedKeyword)) {
    return "duplicate";
  }
  if (args.seenKeywords.size >= args.maxDistinctSearches) {
    return "exhausted";
  }
  return "fresh";
}
