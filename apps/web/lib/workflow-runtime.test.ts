import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireLlmPreflightError,
  customDirNamesFromEnv,
  isCookieSecure,
  getLlmConfig,
  getPanSouBaseUrl,
  getProwlarrConfig,
  getQualityPreference,
  movieTargetFromTmdbId,
  PANSOU_BASE_URL_SETTING_KEY,
  DEFAULT_PANSOU_BASE_URL,
  getTmdbAccesses,
  LLM_BASE_URL_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  TMDB_API_KEY_SETTING_KEY,
} from "./workflow-runtime";

function repoWith(value: string | null) {
  return { getSetting: async () => value };
}

function repoMap(map: Record<string, string>) {
  return { getSetting: async (key: string) => map[key] ?? null };
}

describe("getLlmConfig", () => {
  it("unset → all undefined (falls back to env)", async () => {
    expect(await getLlmConfig(repoWith(null))).toEqual({
      baseURL: undefined,
      apiKey: undefined,
      modelId: undefined,
    });
  });

  it("reads + trims the three app_settings keys", async () => {
    const cfg = await getLlmConfig(
      repoMap({
        llm_base_url: " https://api.example.com/v1 ",
        llm_api_key: " sk-abc ",
        llm_model_id: " gpt-4o-mini ",
      }),
    );
    expect(cfg).toEqual({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-abc",
      modelId: "gpt-4o-mini",
    });
  });

  it("blank strings → undefined (not empty string)", async () => {
    const cfg = await getLlmConfig(repoMap({ llm_base_url: "   ", llm_api_key: "", llm_model_id: "x" }));
    expect(cfg.baseURL).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.modelId).toBe("x");
  });
});

describe("acquireLlmPreflightError (点击获取时的 LLM 预检)", () => {
  const configured = repoMap({
    [LLM_BASE_URL_SETTING_KEY]: "https://api.example.com/v1",
    [LLM_MODEL_ID_SETTING_KEY]: "gpt-4o-mini",
  });
  const unconfigured = repoMap({});

  it("live (vercel-ai) + unconfigured → the friendly 未配置 message (blocks enqueue)", async () => {
    const message = await acquireLlmPreflightError({
      settings: unconfigured,
      env: { MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai" } as unknown as NodeJS.ProcessEnv,
    });
    expect(message).toContain("未配置 AI 模型");
  });

  it("live (vercel-ai) + fully configured → null (common case, unchanged behavior)", async () => {
    const message = await acquireLlmPreflightError({
      settings: configured,
      env: { MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai" } as unknown as NodeJS.ProcessEnv,
    });
    expect(message).toBeNull();
  });

  it("fake/demo adapter + nothing configured → null (no LLM needed, never blocks)", async () => {
    const message = await acquireLlmPreflightError({
      settings: unconfigured,
      env: { MEDIA_TRACK_AGENT_ADAPTER: "fake" } as unknown as NodeJS.ProcessEnv,
    });
    expect(message).toBeNull();
  });

  it("default adapter (unset) + nothing configured → null (fake is the default)", async () => {
    const message = await acquireLlmPreflightError({
      settings: unconfigured,
      env: {} as unknown as NodeJS.ProcessEnv,
    });
    expect(message).toBeNull();
  });

  it("live (vercel-ai) + config from env (no DB) → null", async () => {
    const message = await acquireLlmPreflightError({
      settings: unconfigured,
      env: {
        MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai",
        AGENT_MODEL_BASE_URL: "https://env.example/v1",
        AGENT_MODEL_ID: "env-model",
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(message).toBeNull();
  });
});

describe("getQualityPreference", () => {
  it("unset → undefined (default 不限, no quality injection)", async () => {
    expect(await getQualityPreference(repoWith(null))).toBeUndefined();
  });

  it("'any' → undefined", async () => {
    expect(await getQualityPreference(repoWith("any"))).toBeUndefined();
  });

  it("'high'/'medium' pass through (trimmed)", async () => {
    expect(await getQualityPreference(repoWith("high"))).toBe("high");
    expect(await getQualityPreference(repoWith(" medium "))).toBe("medium");
  });

  it("garbage (incl. legacy '4K') → undefined (safe)", async () => {
    expect(await getQualityPreference(repoWith("4K"))).toBeUndefined();
    expect(await getQualityPreference(repoWith("ultra"))).toBeUndefined();
  });
});

describe("getTmdbAccesses", () => {
  it("puts the user key first, then env token, then the proxy", async () => {
    const accesses = await getTmdbAccesses(
      repoMap({ [TMDB_API_KEY_SETTING_KEY]: "userkey" }),
      { TMDB_READ_TOKEN: "envkey", TMDB_PROXY_BASE_URL: "https://proxy.example" } as unknown as NodeJS.ProcessEnv,
    );
    expect(accesses.map((a) => a.readToken)).toEqual(["userkey", "envkey", undefined]);
    expect(accesses[2]?.baseURL).toBe("https://proxy.example");
    expect(accesses[0]?.baseURL).toBe("https://api.themoviedb.org/3");
  });

  it("omits the user access when no key is set, keeping env + proxy", async () => {
    const accesses = await getTmdbAccesses(
      repoMap({}),
      { TMDB_READ_TOKEN: "envkey" } as unknown as NodeJS.ProcessEnv,
    );
    expect(accesses.map((a) => a.readToken)).toEqual(["envkey", undefined]);
  });

  it("always ends with the default proxy when nothing is configured", async () => {
    const accesses = await getTmdbAccesses(repoMap({}), {} as NodeJS.ProcessEnv);
    expect(accesses).toHaveLength(1);
    expect(accesses[0]?.readToken).toBeUndefined();
    expect(accesses[0]?.baseURL).toMatch(/^https:\/\//);
  });
});

describe("getProwlarrConfig", () => {
  it("reads base url + api key from settings (trim, blank→undefined)", async () => {
    const cfg = await getProwlarrConfig(
      repoMap({ [PROWLARR_BASE_URL_SETTING_KEY]: " https://p.example ", [PROWLARR_API_KEY_SETTING_KEY]: "K" }),
      {} as unknown as NodeJS.ProcessEnv,
    );
    expect(cfg).toEqual({ baseURL: "https://p.example", apiKey: "K" });
  });

  it("falls back to env when settings are blank", async () => {
    const cfg = await getProwlarrConfig(
      repoMap({}),
      { PROWLARR_BASE_URL: "https://env.example", PROWLARR_API_KEY: "EK" } as unknown as NodeJS.ProcessEnv,
    );
    expect(cfg).toEqual({ baseURL: "https://env.example", apiKey: "EK" });
  });

  it("returns undefined fields when nothing configured", async () => {
    const cfg = await getProwlarrConfig(repoMap({}), {} as unknown as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ baseURL: undefined, apiKey: undefined });
  });
});

describe("movieTargetFromTmdbId (demo provider mode — movie poster enrichment)", () => {
  it("resolves a demo movie candidate carrying its poster", async () => {
    const target = await movieTargetFromTmdbId(1311031); // 我的僵尸女儿 — demo movie candidate
    expect(target?.title.type).toBe("movie");
    expect(target?.title.posterPath, "demo movie candidate must carry a poster_path").toBeTruthy();
  });

  it("returns null for a tv id — movies need this dedicated path because the series resolver ignores them", async () => {
    expect(await movieTargetFromTmdbId(289271)).toBeNull(); // 翘楚 is a tv candidate
  });
});

describe("getPanSouBaseUrl", () => {
  it("prefers the DB setting (trimmed)", async () => {
    const url = await getPanSouBaseUrl(
      repoMap({ [PANSOU_BASE_URL_SETTING_KEY]: " http://pansou:80 " }),
      { PANSOU_BASE_URL: "http://env.example" } as unknown as NodeJS.ProcessEnv,
    );
    expect(url).toBe("http://pansou:80");
  });

  it("falls back to env when the DB setting is blank", async () => {
    const url = await getPanSouBaseUrl(
      repoMap({}),
      { PANSOU_BASE_URL: "http://env.example" } as unknown as NodeJS.ProcessEnv,
    );
    expect(url).toBe("http://env.example");
  });

  it("falls back to the public default when nothing is configured", async () => {
    const url = await getPanSouBaseUrl(repoMap({}), {} as unknown as NodeJS.ProcessEnv);
    expect(url).toBe(DEFAULT_PANSOU_BASE_URL);
    expect(DEFAULT_PANSOU_BASE_URL).toMatch(/^https?:\/\//);
  });
});

describe("isCookieSecure (the LAN/HTTP login-bounce fix, #60)", () => {
  const req = (opts: { xfp?: string; protocol?: string }) =>
    ({
      headers: { get: (n: string) => (n.toLowerCase() === "x-forwarded-proto" ? opts.xfp ?? null : null) },
      nextUrl: { protocol: opts.protocol },
    }) as unknown as Parameters<typeof isCookieSecure>[0];

  beforeEach(() => {
    delete process.env.MEDIA_TRACK_COOKIE_SECURE;
  });

  it("env=0 forces insecure even over HTTPS (operator opt-out)", () => {
    process.env.MEDIA_TRACK_COOKIE_SECURE = "0";
    expect(isCookieSecure(req({ xfp: "https", protocol: "https:" }))).toBe(false);
  });

  it("env=1 forces secure even over HTTP (operator opt-in)", () => {
    process.env.MEDIA_TRACK_COOKIE_SECURE = "1";
    expect(isCookieSecure(req({ protocol: "http:" }))).toBe(true);
  });

  it("auto: plain-HTTP LAN (no proxy, http) → insecure so the cookie is actually sent (the bug)", () => {
    expect(isCookieSecure(req({ protocol: "http:" }))).toBe(false);
  });

  it("auto: reverse proxy / CF Tunnel sets x-forwarded-proto=https → secure", () => {
    expect(isCookieSecure(req({ xfp: "https", protocol: "http:" }))).toBe(true);
  });

  it("auto: direct HTTPS → secure", () => {
    expect(isCookieSecure(req({ protocol: "https:" }))).toBe(true);
  });

  it("auto: x-forwarded-proto comma list uses the first (client-facing) hop", () => {
    expect(isCookieSecure(req({ xfp: "https, http", protocol: "http:" }))).toBe(true);
  });

  // Copilot #61: scheme strings vary by proxy/framework — x-forwarded-proto is
  // usually "https" but some send "https:"; nextUrl.protocol is usually "https:"
  // but could be "https". Normalize (strip trailing colon) so neither form drops Secure.
  it("auto: x-forwarded-proto with a trailing colon (https:) → still secure", () => {
    expect(isCookieSecure(req({ xfp: "https:", protocol: "http:" }))).toBe(true);
  });

  it("auto: nextUrl.protocol without a colon (https) → still secure", () => {
    expect(isCookieSecure(req({ protocol: "https" }))).toBe(true);
  });

  it("auto: x-forwarded-proto http with a colon (http:) → insecure", () => {
    expect(isCookieSecure(req({ xfp: "http:", protocol: "http:" }))).toBe(false);
  });
});

describe("customDirNamesFromEnv (brand-agnostic 自定义媒体库目录名)", () => {
  const env = (m: Record<string, string>) => m as unknown as NodeJS.ProcessEnv;

  it("nothing set → {} (defaults apply downstream)", () => {
    expect(customDirNamesFromEnv(env({}))).toEqual({});
  });

  it("reads + trims the four generic vars (applies to every drive brand)", () => {
    expect(
      customDirNamesFromEnv(
        env({
          MEDIA_TRACK_LIBRARY_ROOT_DIR: " 我的影音库 ",
          MEDIA_TRACK_LIBRARY_MOVIES_DIR: "电影",
          MEDIA_TRACK_LIBRARY_TV_DIR: "剧集",
          MEDIA_TRACK_LIBRARY_ANIME_DIR: "番剧",
        }),
      ),
    ).toEqual({ rootName: "我的影音库", moviesName: "电影", tvName: "剧集", animeName: "番剧" });
  });

  it("blank / whitespace values are omitted (never an empty-string root → no write-scope footgun)", () => {
    expect(
      customDirNamesFromEnv(
        env({ MEDIA_TRACK_LIBRARY_ROOT_DIR: "", MEDIA_TRACK_LIBRARY_MOVIES_DIR: "   ", MEDIA_TRACK_LIBRARY_TV_DIR: "剧集" }),
      ),
    ).toEqual({ tvName: "剧集" });
  });
})
