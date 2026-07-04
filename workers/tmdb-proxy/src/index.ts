import { handleTmdbProxy, runScheduledRefresh, type KvLike } from "./handler";

export interface Env {
  TMDB_CACHE: KvLike;
  TMDB_READ_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.TMDB_READ_TOKEN) {
      return new Response("Proxy misconfigured: missing TMDB_READ_TOKEN secret", { status: 500 });
    }
    return handleTmdbProxy({ request, kv: env.TMDB_CACHE, token: env.TMDB_READ_TOKEN });
  },

  // Daily cron (wrangler triggers.crons): pre-warm the trending feeds into KV so
  // no user open ever triggers a TMDB request. waitUntil keeps the worker alive
  // until the refresh settles.
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (!env.TMDB_READ_TOKEN) {
      return;
    }
    ctx.waitUntil(runScheduledRefresh({ kv: env.TMDB_CACHE, token: env.TMDB_READ_TOKEN }));
  },
};
