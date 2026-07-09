import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  resolveIsDesktop,
  getTmdbAccesses,
  LLM_BASE_URL_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  TMDB_API_KEY_SETTING_KEY,
} from "./workflow-runtime";

describe("resolveIsDesktop", () => {
  it("MEDIA_TRACK_DESKTOP=1 → true (Electron server-launch sets this)", () => {
    expect(resolveIsDesktop({ MEDIA_TRACK_DESKTOP: "1" })).toBe(true);
  });
  it("unset → false (docker/web)", () => {
    expect(resolveIsDesktop({})).toBe(false);
  });
  it("other value → false (only exact \"1\" counts)", () => {
    expect(resolveIsDesktop({ MEDIA_TRACK_DESKTOP: "0" })).toBe(false);
    expect(resolveIsDesktop({ MEDIA_TRACK_DESKTOP: "true" })).toBe(false);
  });
});

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

describe("getWorkflowRepository (desktop SQLite selection)", () => {
  it("selects the SQLite repository when MEDIA_TRACK_SQLITE_PATH is set", async () => {
    const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    vi.resetModules();
    try {
      const { getWorkflowRepository } = await import("./workflow-runtime");
      expect(getWorkflowRepository().constructor.name).toBe("SqliteWorkflowRepository");
    } finally {
      delete process.env.MEDIA_TRACK_SQLITE_PATH;
      if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
      vi.resetModules();
    }
  });
});

describe("runScheduledType3（per-slot 认领 + 合并补跑）", () => {
  // 每 tick 认领全部「已到点且今天未认领」的时间点、只跑一次 sweep —— 常开机器各
  // slot 准点触发；迟启动（桌面）自动补跑一次；错过整天不重放。桌面与容器同一语义
  // （原 MEDIA_TRACK_PATROL_IGNORE_TIME_GATE 特例已退役）。
  // Harness 沿用旧 desktop describe：内存 SQLite 真 get/setSetting、fake Date 钉
  // 北京钟（UTC+8）、stub runScheduledType3Monitoring 免真盘真模型。
  const monitor = vi.fn(async () => []);
  const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
  let rt: typeof import("./workflow-runtime");

  const boot = async (settings: Record<string, string>, beijingISO: string) => {
    monitor.mockClear();
    monitor.mockImplementation(async () => []);
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${beijingISO}:00.000+08:00`));
    vi.resetModules();
    vi.doMock("@media-track/workflow", async () => {
      const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
      return { ...actual, runScheduledType3Monitoring: monitor };
    });
    rt = await import("./workflow-runtime");
    const repository = rt.getWorkflowRepository();
    for (const [key, value] of Object.entries(settings)) {
      await repository.setSetting(key, value);
    }
    return repository;
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@media-track/workflow");
    delete process.env.MEDIA_TRACK_SQLITE_PATH;
    if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
    vi.resetModules();
  });

  const TIMES = JSON.stringify(["06:00", "21:00"]);
  const claims = async (repository: { getSetting(k: string): Promise<string | null> }) =>
    JSON.parse((await repository.getSetting(rt.LAST_SWEEP_CLAIMS_SETTING_KEY)) ?? "{}");

  it("到点未认领 → 跑一次并认领该 slot", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    const result = await rt.runScheduledType3();
    expect(result.skipped).toBeUndefined();
    expect(monitor).toHaveBeenCalledTimes(1);
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: ["06:00"] });
  });

  it("两 slot 之间（第一个已认领）→ before_scheduled_time + 下一个 slot（今天还会再跑，别谎报 already_swept）", async () => {
    const repository = await boot(
      { daily_sweep_times: TIMES, last_sweep_claims: JSON.stringify({ date: "2026-07-09", slots: ["06:00"] }) },
      "2026-07-09T06:31",
    );
    const result = await rt.runScheduledType3();
    expect(result.skipped).toBe("before_scheduled_time");
    expect(result.scheduledFor).toBe("21:00");
    expect(monitor).not.toHaveBeenCalled();
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: ["06:00"] });
  });

  it("最后一个 slot 之后且全部已认领 → already_swept_today", async () => {
    const repository = await boot(
      {
        daily_sweep_times: TIMES,
        last_sweep_claims: JSON.stringify({ date: "2026-07-09", slots: ["06:00", "21:00"] }),
      },
      "2026-07-09T22:00",
    );
    const result = await rt.runScheduledType3();
    expect(result.skipped).toBe("already_swept_today");
    expect(monitor).not.toHaveBeenCalled();
    expect(repository).toBeTruthy();
  });

  it("全部未到点 → before_scheduled_time + 下一个 slot", async () => {
    await boot({ daily_sweep_times: TIMES }, "2026-07-09T05:00");
    const result = await rt.runScheduledType3();
    expect(result.skipped).toBe("before_scheduled_time");
    expect(result.scheduledFor).toBe("06:00");
    expect(monitor).not.toHaveBeenCalled();
  });

  it("迟启动补跑：两个 slot 都过期 → 只跑一次、两个一起认领（合并）", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T22:15");
    await rt.runScheduledType3();
    expect(monitor).toHaveBeenCalledTimes(1);
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: ["06:00", "21:00"] });
  });

  it("第二个 slot 到点（第一个已认领）→ 再跑一次，追加认领", async () => {
    const repository = await boot(
      { daily_sweep_times: TIMES, last_sweep_claims: JSON.stringify({ date: "2026-07-09", slots: ["06:00"] }) },
      "2026-07-09T21:00",
    );
    await rt.runScheduledType3();
    expect(monitor).toHaveBeenCalledTimes(1);
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: ["06:00", "21:00"] });
  });

  it("跨日：昨天的认领不算数，今天照常跑并重置", async () => {
    const repository = await boot(
      {
        daily_sweep_times: TIMES,
        last_sweep_claims: JSON.stringify({ date: "2026-07-08", slots: ["06:00", "21:00"] }),
      },
      "2026-07-09T06:05",
    );
    await rt.runScheduledType3();
    expect(monitor).toHaveBeenCalledTimes(1);
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: ["06:00"] });
  });

  it("sweep 整体失败 → 释放本次认领、保留已有认领", async () => {
    const repository = await boot(
      { daily_sweep_times: TIMES, last_sweep_claims: JSON.stringify({ date: "2026-07-09", slots: ["06:00"] }) },
      "2026-07-09T21:02",
    );
    monitor.mockRejectedValueOnce(new Error("infra boom"));
    await expect(rt.runScheduledType3()).rejects.toThrow("infra boom");
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: ["06:00"] });
  });

  it("force 手动跑不认领任何 slot（run-now 不吞计划）", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T05:00");
    await rt.runScheduledType3({ force: true });
    expect(monitor).toHaveBeenCalledTimes(1);
    expect((await repository.getSetting(rt.LAST_SWEEP_CLAIMS_SETTING_KEY)) ?? null).toBeNull();
  });

  it("升级迁移：legacy last_sweep_date=今天 → 已到点的 slot 视为已认领（不重扫），未到的 slot 照常预告", async () => {
    await boot({ daily_sweep_times: TIMES, last_sweep_date: "2026-07-09" }, "2026-07-09T12:00");
    const result = await rt.runScheduledType3();
    expect(monitor).not.toHaveBeenCalled(); // 升级当日绝不按新语义重扫
    expect(result.skipped).toBe("before_scheduled_time"); // 21:00 今天还会照常跑
    expect(result.scheduledFor).toBe("21:00");
  });

  it("成功后写 last_sweep_completed_at（含定时路径）", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    await rt.runScheduledType3();
    expect(await repository.getSetting(rt.LAST_SWEEP_COMPLETED_AT_SETTING_KEY)).toBeTruthy();
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

describe("getDailySweepTimes（多时间点 + 迁移回退）", () => {
  const repo = (settings: Record<string, string>) => ({
    getSetting: async (key: string) => settings[key] ?? null,
  });

  it("解析 JSON 数组：去重、升序、剔除非法项", async () => {
    const { getDailySweepTimes } = await import("./workflow-runtime");
    const times = await getDailySweepTimes(
      repo({ daily_sweep_times: JSON.stringify(["21:00", "06:00", "21:00", "bogus", "25:00"]) }),
    );
    expect(times).toEqual(["06:00", "21:00"]);
  });

  it("超过 6 个只保留前 6（升序后）", async () => {
    const { getDailySweepTimes } = await import("./workflow-runtime");
    const eight = ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00", "08:00"];
    const times = await getDailySweepTimes(repo({ daily_sweep_times: JSON.stringify(eight) }));
    expect(times).toEqual(eight.slice(0, 6));
  });

  it("新 key 缺失 → 回退 legacy 单值 daily_sweep_time", async () => {
    const { getDailySweepTimes } = await import("./workflow-runtime");
    expect(await getDailySweepTimes(repo({ daily_sweep_time: "08:30" }))).toEqual(["08:30"]);
  });

  it("两个 key 都没有/新 key 是烂 JSON → 默认 [\"06:00\"]", async () => {
    const { getDailySweepTimes } = await import("./workflow-runtime");
    expect(await getDailySweepTimes(repo({}))).toEqual(["06:00"]);
    expect(await getDailySweepTimes(repo({ daily_sweep_times: "not-json" }))).toEqual(["06:00"]);
    expect(await getDailySweepTimes(repo({ daily_sweep_times: "[]" }))).toEqual(["06:00"]);
  });

  it("legacy 单值也做范围校验：99:99 之类非法值回默认（否则 slot 永远到不了点）", async () => {
    const { getDailySweepTimes, getDailySweepTime } = await import("./workflow-runtime");
    expect(await getDailySweepTime(repo({ daily_sweep_time: "99:99" }))).toBe("06:00");
    expect(await getDailySweepTimes(repo({ daily_sweep_time: "25:00" }))).toEqual(["06:00"]);
  });
});
