import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Opt-in outbound proxy for the server's global `fetch`.
 *
 * Node's built-in `fetch` (undici) does NOT read `HTTP_PROXY` / `HTTPS_PROXY`
 * environment variables on its own (and `NODE_USE_ENV_PROXY` only exists on
 * Node 24+). So a self-hoster behind the GFW who sets those vars in
 * docker-compose still couldn't reach `api.themoviedb.org` directly — every
 * TMDB call went out unproxied and timed out (#68).
 *
 * Installing undici's `EnvHttpProxyAgent` as the global dispatcher makes
 * `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` actually take effect for every
 * outbound fetch (TMDB direct, PanSou, Prowlarr). It is OPT-IN: with no proxy
 * env set we install nothing, so the default direct-fetch path is unchanged.
 */

export interface ConfigureProxyDeps {
  setDispatcher: (dispatcher: Dispatcher) => void;
  makeAgent: () => Dispatcher;
}

export interface ConfigureProxyResult {
  enabled: boolean;
  proxyUrl?: string;
  /** Credentials-stripped host:port for safe logging — a proxy URL may embed
   *  user:pass, which must never reach application logs. */
  proxyDisplay?: string;
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

/** Reduce a proxy URL to `host:port`, dropping any embedded credentials. Falls
 *  back to the raw value when it is not a parseable URL (e.g. bare `host:port`). */
function redactProxy(raw: string): string {
  try {
    const u = new URL(raw);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return raw;
  }
}

const defaultDeps: ConfigureProxyDeps = {
  setDispatcher: setGlobalDispatcher,
  makeAgent: () => new EnvHttpProxyAgent(),
};

/**
 * Install the env-driven proxy dispatcher iff a proxy env var is set. Pure
 * w.r.t. its injected deps so the env→install decision is unit-testable without
 * mutating the real global dispatcher.
 */
export function configureHttpProxyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: ConfigureProxyDeps = defaultDeps,
): ConfigureProxyResult {
  const proxyUrl = PROXY_ENV_KEYS.map((key) => env[key]?.trim()).find((value) => value);
  if (!proxyUrl) {
    return { enabled: false };
  }
  deps.setDispatcher(deps.makeAgent());
  return { enabled: true, proxyUrl, proxyDisplay: redactProxy(proxyUrl) };
}
