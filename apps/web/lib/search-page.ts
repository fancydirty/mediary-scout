import {
  createTmdbSearchProvider,
  getSearchPageView,
  InMemoryMediaSearchCache,
  resolveTitles,
  type MediaSearchProvider,
  type SearchInterpretationCache,
  type SearchPageView,
} from "@media-track/workflow";
import { demoMediaSearchProvider } from "./demo-candidates";
import { InMemoryJsonCache, PostgresMediaSearchCache, SearchInterpretationCacheAdapter } from "./tmdb-cache";
import {
  ensureDemoSeeded,
  getAccountScopedSettings,
  getActiveWorkspaceScope,
  getAgentModelForSearch,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
  postgresConnectionString,
  resolveTitleResearchOptions,
} from "./workflow-runtime";

let demoSearchCache: InMemoryMediaSearchCache | null = null;
let durableSearchCache: PostgresMediaSearchCache | null = null;
// Desktop (SQLite) build: no Postgres, so the durable cache degrades to in-memory
// (a lost cache on restart is fine — a 2nd SQLite schema isn't worth it).
let sqliteSearchCache: InMemoryMediaSearchCache | null = null;
// Description → title memory (see SearchInterpretationCache): the search page
// re-renders every 5s while an acquisition runs, so this must outlive one render.
let interpretationCache: SearchInterpretationCache | null = null;

export async function getSearchView(query: string, storageId?: string): Promise<SearchPageView> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  // Tree model: scope a movie's 已获取/获取 state to the active drive — obtained on
  // one drive must stay acquirable on another's workspace.
  const scope = await getActiveWorkspaceScope(storageId);
  return getSearchPageView({
    query,
    provider: await getMediaSearchProvider(),
    cache: getSearchCache(),
    repository,
    scope,
    // Only the live deployment can describe-search: the demo provider serves a
    // fixed seed list, and a demo deployment has no user LLM to call.
    ...(process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb"
      ? {
          resolveTitles: (descriptive: string) => resolveSearchTitles(descriptive),
          interpretations: getInterpretationCache(),
        }
      : {}),
  });
}

/** Postgres-backed in production, in-memory on the desktop (SQLite) build/demo. */
function getInterpretationCache(): SearchInterpretationCache {
  if (interpretationCache) return interpretationCache;
  const store =
    process.env.MEDIA_TRACK_SQLITE_PATH?.trim() || process.env.MEDIA_TRACK_SEARCH_PROVIDER !== "tmdb"
      ? new InMemoryJsonCache()
      : (durableSearchCache ??= new PostgresMediaSearchCache({ connectionString: postgresConnectionString() }));
  interpretationCache = new SearchInterpretationCacheAdapter(store);
  return interpretationCache;
}

/**
 * Turn "男主带小绿瓶修仙的国漫" / "咒术回战 死灭回游" into real titles with the
 * ACCOUNT'S OWN model (Settings → AI 模型), plus web search that routes to
 * DeepSeek's own engine when that is their endpoint. Best-effort: a missing
 * model, a timeout or a bad answer just means "no extra titles".
 */
async function resolveSearchTitles(query: string): Promise<string[]> {
  const settings = getAccountScopedSettings(await getCurrentAccountId());
  const model = await getAgentModelForSearch(settings);
  if (!model) return [];
  const web = await resolveTitleResearchOptions(settings);
  // 15s covers one web search (12s) plus the model call. The page is already
  // inside Suspense, and only a zero-result search pays this at all.
  return resolveTitles({ query, model, web: web.web, timeoutMs: 15_000 });
}

function getSearchCache() {
  // Live TMDB searches are cached durably in Postgres (6h TTL) so casual browsing
  // never becomes an API storm; the desktop (SQLite) build degrades this to in-memory
  // (below), and the demo provider stays in-memory too.
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    // Desktop (SQLite) build has no Postgres — calling postgresConnectionString()
    // would throw, so degrade the durable cache to in-memory instead.
    if (process.env.MEDIA_TRACK_SQLITE_PATH?.trim()) {
      return (sqliteSearchCache ??= new InMemoryMediaSearchCache());
    }
    durableSearchCache ??= new PostgresMediaSearchCache({ connectionString: postgresConnectionString() });
    return durableSearchCache;
  }
  demoSearchCache ??= new InMemoryMediaSearchCache();
  return demoSearchCache;
}

async function getMediaSearchProvider(): Promise<MediaSearchProvider> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER !== "tmdb") {
    return demoMediaSearchProvider;
  }
  // Built per-call scoped to the current account (its TMDB key → global → proxy),
  // not module-cached — a singleton would lock to the first account's key.
  return createTmdbSearchProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId())));
}
