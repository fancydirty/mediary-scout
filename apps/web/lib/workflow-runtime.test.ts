import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_LLM_PRESET, isFreeLlmPreset } from "@media-track/workflow";
import {
  acquireLlmPreflightError,
  resolveAgentModelConfig,
  customDirNamesFromEnv,
  isCookieSecure,
  getLlmConfig,
  getPanSouBaseUrl,
  getProwlarrConfig,
  getAccountScopedSettings,
  getJevConfig,
  getJevBaseUrlOverride,
  getJevInheritedBaseUrl,
  jevConfigFingerprint,
  JEV_PROBED_FOR_SETTING_KEY,
  resolveJevJudge,
  isJevPrefilterActive,
  getQualityPreference,
  movieTargetFromTmdbId,
  PANSOU_BASE_URL_SETTING_KEY,
  DEFAULT_PANSOU_BASE_URL,
  resolveIsDesktop,
  getTmdbAccesses,
  LLM_BASE_URL_SETTING_KEY,
  LLM_API_KEY_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  JEV_API_KEY_SETTING_KEY,
  JEV_BASE_URL_SETTING_KEY,
  JEV_PREFILTER_ENABLED_SETTING_KEY,
  JEV_HEALTH_SETTING_KEY,
  TMDB_API_KEY_SETTING_KEY,
  importForeignWorkFiles,
  UpdateInProgressError,
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

describe("resolveAgentModelConfig（DB → env → 出厂免费预设）", () => {
  const cast = (m: Record<string, string>) => m as unknown as NodeJS.ProcessEnv;

  it("DB 有值 → DB 值生效（env 不参与），source db", async () => {
    const cfg = await resolveAgentModelConfig(
      repoMap({
        [LLM_BASE_URL_SETTING_KEY]: "https://db.example/v1",
        [LLM_MODEL_ID_SETTING_KEY]: "db-model",
        [LLM_API_KEY_SETTING_KEY]: "sk-db",
      }),
      cast({ AGENT_MODEL_BASE_URL: "https://env.example/v1", AGENT_MODEL_ID: "env-model" }),
    );
    expect(cfg).toEqual({
      apiKey: "sk-db",
      baseURL: "https://db.example/v1",
      modelId: "db-model",
      source: "db",
    });
  });

  it("DB 空、env 有值（含 legacy XIAOMI_MIMO_*）→ env 值生效，source env", async () => {
    const cfg = await resolveAgentModelConfig(
      repoMap({}),
      cast({ AGENT_MODEL_BASE_URL: "https://env.example/v1", XIAOMI_MIMO_MODEL_ID: "legacy-model" }),
    );
    expect(cfg).toEqual({ baseURL: "https://env.example/v1", modelId: "legacy-model", source: "env" });
  });

  it("DB 只补了一项（如只有 key）、其余靠 env → source db（DB 层参与了就算 db）", async () => {
    const cfg = await resolveAgentModelConfig(
      repoMap({ [LLM_API_KEY_SETTING_KEY]: "sk-db" }),
      cast({ AGENT_MODEL_BASE_URL: "https://env.example/v1", AGENT_MODEL_ID: "env-model" }),
    );
    expect(cfg).toEqual({
      apiKey: "sk-db",
      baseURL: "https://env.example/v1",
      modelId: "env-model",
      source: "db",
    });
  });

  it("DB 空 + env 空 → 回落出厂免费预设（keyless），source free-preset", async () => {
    const cfg = await resolveAgentModelConfig(repoMap({}), cast({}));
    expect(cfg).toEqual({
      baseURL: FREE_LLM_PRESET.baseURL,
      modelId: FREE_LLM_PRESET.modelId,
      source: "free-preset",
    });
    // 回落结果必须能被 isFreeLlmPreset 判成免费档 —— 设置页胶囊/失败文案（Task 4）靠它。
    expect(isFreeLlmPreset(cfg)).toBe(true);
  });

  it("env 三键是空串/空白（.env.example 照抄形态）→ 也照样回落免费预设", async () => {
    const cfg = await resolveAgentModelConfig(
      repoMap({}),
      cast({ AGENT_MODEL_API_KEY: "", AGENT_MODEL_BASE_URL: "   " }),
    );
    expect(cfg.source).toBe("free-preset");
    expect(cfg.modelId).toBe(FREE_LLM_PRESET.modelId);
  });

  it("DB 只剩残留 apiKey（url/model 空，「清空地址保存」后 key blank-keep 的形态）→ 照样回落免费预设，且返回对象不含 apiKey 键", async () => {
    const cfg = await resolveAgentModelConfig(repoMap({ [LLM_API_KEY_SETTING_KEY]: "sk-residual" }), cast({}));
    // toEqual 严格断言：多出的 apiKey 键（值非 undefined）会让它失败。
    expect(cfg).toEqual({
      baseURL: FREE_LLM_PRESET.baseURL,
      modelId: FREE_LLM_PRESET.modelId,
      source: "free-preset",
    });
    // 残留 key 属于用户自配服务（如 DeepSeek），绝不能作为 Authorization 头发给
    // Kilo 免费池第三方 —— 回落分支必须丢弃它。
    expect("apiKey" in cfg).toBe(false);
    expect(isFreeLlmPreset(cfg)).toBe(true);
  });

  it("半截配置（只有 baseURL）不回落 —— 原样返回，交给下游 llmConfigError fail-fast（用户错误不静默变免费池）", async () => {
    const cfg = await resolveAgentModelConfig(repoMap({}), cast({ AGENT_MODEL_BASE_URL: "https://half.example/v1" }));
    expect(cfg).toEqual({ baseURL: "https://half.example/v1", source: "env" });
  });

  it("DB 半截（baseURL 有、modelId 空）同样不回落 —— 原样返回（半截用户错误仍 fail-fast，回归保护）", async () => {
    const cfg = await resolveAgentModelConfig(
      repoMap({ [LLM_BASE_URL_SETTING_KEY]: "https://half.example/v1" }),
      cast({}),
    );
    expect(cfg).toEqual({ baseURL: "https://half.example/v1", source: "db" });
  });
});

describe("acquireLlmPreflightError（已退役：免费预设兜底后恒 null，不再拦截任何获取）", () => {
  const configured = repoMap({
    [LLM_BASE_URL_SETTING_KEY]: "https://api.example.com/v1",
    [LLM_MODEL_ID_SETTING_KEY]: "gpt-4o-mini",
  });
  const unconfigured = repoMap({});

  it("live (vercel-ai) + unconfigured → null（出厂免费预设兜底，issue #52 的门退役）", async () => {
    const message = await acquireLlmPreflightError({
      settings: unconfigured,
      env: { MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai" } as unknown as NodeJS.ProcessEnv,
    });
    expect(message).toBeNull();
  });

  it("live (vercel-ai) + fully configured → null", async () => {
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
  const janitor = vi.fn(async () => ({ held: false }));
  const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
  let rt: typeof import("./workflow-runtime");

  const boot = async (settings: Record<string, string>, beijingISO: string) => {
    monitor.mockClear();
    monitor.mockImplementation(async () => []);
    janitor.mockClear();
    janitor.mockImplementation(async () => ({ held: false }));
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${beijingISO}:00.000+08:00`));
    vi.resetModules();
    vi.doMock("@media-track/workflow", async () => {
      const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
      return { ...actual, runScheduledType3Monitoring: monitor, sweepOrphanStagingDirs: janitor };
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

  it("更新暂停期间：定时和手动巡检都不跑、不认领时间点，暂停结束后照常补跑", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    const { setUpdateHold, clearUpdateHold } = await import("./update-hold");
    setUpdateHold(Date.now(), 60_000);
    try {
      expect(await rt.runScheduledType3()).toEqual({ skipped: "update_in_progress", outcomes: [] });
      expect(await rt.runScheduledType3({ force: true })).toEqual({ skipped: "update_in_progress", outcomes: [] });
      expect(monitor).not.toHaveBeenCalled();
      expect((await repository.getSetting(rt.LAST_SWEEP_CLAIMS_SETTING_KEY)) ?? null).toBeNull();
    } finally {
      clearUpdateHold();
    }
    const result = await rt.runScheduledType3();
    expect(result.skipped).toBeUndefined();
    expect(monitor).toHaveBeenCalledTimes(1);
  });

  it("更新暂停期间：runNextQueuedWorkflow 直接返回 idle，不认领排队任务", async () => {
    const repository = await boot({}, "2026-07-09T06:30");
    const claim = vi.spyOn(repository, "claimNextQueuedWorkflowRun");
    const { setUpdateHold, clearUpdateHold } = await import("./update-hold");
    setUpdateHold(Date.now(), 60_000);
    try {
      expect(await rt.runNextQueuedWorkflow()).toEqual({ status: "idle" });
      expect(claim).not.toHaveBeenCalled();
    } finally {
      clearUpdateHold();
    }
  });

  it("把 mayStartRun 传给巡检，让它在每次预约前再看一眼暂停", async () => {
    await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    await rt.runScheduledType3({ force: true });
    const passed = (monitor.mock.calls[0] as unknown as [{ mayStartRun?: () => boolean }])[0].mayStartRun;
    expect(typeof passed).toBe("function");
    expect(passed!()).toBe(true);
    const { setUpdateHold, clearUpdateHold } = await import("./update-hold");
    setUpdateHold(Date.now(), 60_000);
    try {
      expect(passed!()).toBe(false);
    } finally {
      clearUpdateHold();
    }
  });

  it("更新暂停在巡检途中生效：释放本次认领的时间点、不记完成，新版本当天补跑", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    const { setUpdateHold, clearUpdateHold } = await import("./update-hold");
    // The hold is taken after the entry check, while the sweep runs.
    monitor.mockImplementation((async (input: { mayStartRun?: () => boolean }) => {
      setUpdateHold(Date.now(), 60_000);
      expect(input.mayStartRun!()).toBe(false);
      return [];
    }) as never);
    try {
      const result = await rt.runScheduledType3();
      expect(result.skipped).toBe("update_in_progress");
      expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: [] });
      expect((await repository.getSetting(rt.LAST_SWEEP_COMPLETED_AT_SETTING_KEY)) ?? null).toBeNull();
    } finally {
      clearUpdateHold();
    }
    monitor.mockImplementation(async () => []);
    const again = await rt.runScheduledType3();
    expect(again.skipped).toBeUndefined();
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: ["06:00"] });
  });

  it("staging 清理因更新暂停停下：同样释放时间点、不记完成", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    janitor.mockImplementation((async () => ({ held: true })) as never);
    const result = await rt.runScheduledType3();
    expect(result.skipped).toBe("update_in_progress");
    expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: [] });
    expect((await repository.getSetting(rt.LAST_SWEEP_COMPLETED_AT_SETTING_KEY)) ?? null).toBeNull();
    const passed = (janitor.mock.calls[0] as unknown as [{ mayStartRun?: () => boolean }])[0].mayStartRun;
    expect(typeof passed).toBe("function");
  });

  it("暂停在巡检和清理都查过之后才生效：也释放时间点、不记完成", async () => {
    const repository = await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    const { setUpdateHold, clearUpdateHold } = await import("./update-hold");
    // No reservation candidates and no shows to clean: neither ever asks mayStartRun.
    janitor.mockImplementation((async () => {
      setUpdateHold(Date.now(), 60_000);
      return { held: false };
    }) as never);
    try {
      const result = await rt.runScheduledType3();
      expect(result.skipped).toBe("update_in_progress");
      expect(await claims(repository)).toEqual({ date: "2026-07-09", slots: [] });
      expect((await repository.getSetting(rt.LAST_SWEEP_COMPLETED_AT_SETTING_KEY)) ?? null).toBeNull();
    } finally {
      clearUpdateHold();
    }
  });

  it("巡检整个过程都算「进行中」，更新助手的忙碌检查会等它", async () => {
    await boot({ daily_sweep_times: TIMES }, "2026-07-09T06:30");
    const { inFlightCount } = await import("./update-hold");
    let seen = -1;
    janitor.mockImplementation((async () => {
      seen = inFlightCount();
      return { held: false };
    }) as never);
    await rt.runScheduledType3({ force: true });
    expect(seen).toBeGreaterThan(0);
    expect(inFlightCount()).toBe(0);
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

describe("getPatrolConcurrency", () => {
  const repo = (value: string | null) => ({ getSetting: async () => value });

  it("读 1~5 的整数，其余一律回默认 1", async () => {
    const { getPatrolConcurrency } = await import("./workflow-runtime");
    expect(await getPatrolConcurrency(repo("3"))).toBe(3);
    expect(await getPatrolConcurrency(repo(" 5 "))).toBe(5);
    for (const bad of [null, "", "0", "6", "2.5", "-1", "abc"]) {
      expect(await getPatrolConcurrency(repo(bad)), String(bad)).toBe(1);
    }
  });
});

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

describe("workerHasConfiguredDrive (C1: any account's drive counts)", () => {
  const prev = {
    adapter: process.env.MEDIA_TRACK_STORAGE_ADAPTER,
    cookie: process.env.PAN115_COOKIE,
    pg: process.env.MEDIA_TRACK_POSTGRES_URL,
    sqlite: process.env.MEDIA_TRACK_SQLITE_PATH,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries({
      MEDIA_TRACK_STORAGE_ADAPTER: prev.adapter,
      PAN115_COOKIE: prev.cookie,
      MEDIA_TRACK_POSTGRES_URL: prev.pg,
      MEDIA_TRACK_SQLITE_PATH: prev.sqlite,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  async function boot() {
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    process.env.MEDIA_TRACK_STORAGE_ADAPTER = "115";
    delete process.env.PAN115_COOKIE;
    vi.resetModules();
    return import("./workflow-runtime");
  }

  it("non-115 adapter → true (fake/dev never needs a cookie)", async () => {
    process.env.MEDIA_TRACK_STORAGE_ADAPTER = "fake";
    delete process.env.PAN115_COOKIE;
    vi.resetModules();
    const { workerHasConfiguredDrive } = await import("./workflow-runtime");
    expect(await workerHasConfiguredDrive()).toBe(true);
  });

  it("env PAN115_COOKIE set → true (legacy bootstrap)", async () => {
    process.env.MEDIA_TRACK_STORAGE_ADAPTER = "115";
    process.env.PAN115_COOKIE = "UID=1;CID=2;SEID=3";
    vi.resetModules();
    const { workerHasConfiguredDrive } = await import("./workflow-runtime");
    expect(await workerHasConfiguredDrive()).toBe(true);
  });

  it("fresh deploy (adapter 115, no cookie, no drives) → false", async () => {
    const rt = await boot();
    expect(await rt.workerHasConfiguredDrive()).toBe(false);
  });

  it("drive on a non-default account → true (multi-user must not starve the queue)", async () => {
    const rt = await boot();
    const repo = rt.getWorkflowRepository();
    await repo.createAccount({
      id: "acct_bob",
      username: "bob",
      passwordHash: "x",
      groupId: null,
      isOwner: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await repo.upsertConnectedStorage({
      id: "cs_bob_115",
      accountId: "acct_bob",
      provider: "pan115",
      providerUid: "bob115",
      label: "bob",
      payload: { cookie: "UID=bob" },
      rootCid: "r",
      moviesCid: "m",
      tvCid: "t",
      animeCid: "a",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await rt.workerHasConfiguredDrive()).toBe(true);
  });

  it("repository throw → false (non-throwing for worker tick)", async () => {
    const rt = await boot();
    const repo = rt.getWorkflowRepository();
    vi.spyOn(repo, "hasAnyConnectedStorage").mockRejectedValueOnce(new Error("db down"));
    await expect(rt.workerHasConfiguredDrive()).resolves.toBe(false);
  });
});

describe("requireAuthenticatedAccountId (C2: refuse acct_unauthenticated writes)", () => {
  const prevMulti = process.env.MEDIA_TRACK_MULTI_USER;

  afterEach(() => {
    if (prevMulti === undefined) delete process.env.MEDIA_TRACK_MULTI_USER;
    else process.env.MEDIA_TRACK_MULTI_USER = prevMulti;
    vi.resetModules();
    vi.doUnmock("next/headers");
  });

  it("single-user → returns acct_default (unchanged)", async () => {
    delete process.env.MEDIA_TRACK_MULTI_USER;
    vi.resetModules();
    const { requireAuthenticatedAccountId } = await import("./workflow-runtime");
    expect(await requireAuthenticatedAccountId()).toBe("acct_default");
  });

  it("multi-user + no session cookie → throws UnauthenticatedAccountError", async () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => undefined }),
    }));
    const { requireAuthenticatedAccountId, UnauthenticatedAccountError, UNAUTHENTICATED_ACCOUNT_ID, getCurrentAccountId } =
      await import("./workflow-runtime");
    expect(await getCurrentAccountId()).toBe(UNAUTHENTICATED_ACCOUNT_ID);
    await expect(requireAuthenticatedAccountId()).rejects.toBeInstanceOf(UnauthenticatedAccountError);
    await expect(requireAuthenticatedAccountId()).rejects.toThrow(/未登录/);
  });

  it("queue/reserve write paths refuse multi-user unauthenticated as unsupported", async () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => undefined }),
    }));
    const {
      queueCandidateTracking,
      queueCandidateSeries,
      reserveCandidate,
    } = await import("./workflow-runtime");
    await expect(queueCandidateTracking("tmdb_movie_1")).resolves.toMatchObject({
      status: "unsupported",
      message: expect.stringMatching(/未登录/),
    });
    await expect(queueCandidateSeries("tmdb_tv_1_s1")).resolves.toMatchObject({
      status: "unsupported",
      message: expect.stringMatching(/未登录/),
    });
    await expect(reserveCandidate("tmdb_movie_1")).resolves.toMatchObject({
      status: "unsupported",
      message: expect.stringMatching(/未登录/),
    });
  });
});

/** `{}` is not a structurally valid NodeJS.ProcessEnv here (NODE_ENV is required);
 *  same cast the getProwlarrConfig tests above use. */
const noEnv = {} as unknown as NodeJS.ProcessEnv;

describe("getJevConfig", () => {
  it("setting keys are the DB column values the rest of the suite hardcodes", () => {
    expect(JEV_API_KEY_SETTING_KEY).toBe("jev_api_key");
    expect(JEV_BASE_URL_SETTING_KEY).toBe("jev_base_url");
    expect(JEV_PREFILTER_ENABLED_SETTING_KEY).toBe("jev_prefilter_enabled");
    expect(JEV_HEALTH_SETTING_KEY).toBe("jev_health");
  });

  it("unset → apiKey undefined, baseUrl default, enabled false, health undefined", async () => {
    expect(await getJevConfig(repoWith(null), noEnv)).toEqual({
      apiKey: undefined,
      baseUrl: "https://openrouter.ai/api/alpha/decisions",
      enabled: false,
      health: undefined,
    });
  });

  it("reads + trims DB keys; enabled only when exactly \"1\"", async () => {
    const cfg = await getJevConfig(
      repoMap({
        jev_api_key: " sk-or-x ",
        jev_base_url: " https://x/y ",
        jev_prefilter_enabled: "1",
        jev_health: "ok",
      }),
      noEnv,
    );
    expect(cfg).toEqual({ apiKey: "sk-or-x", baseUrl: "https://x/y", enabled: true, health: "ok" });
    expect((await getJevConfig(repoMap({ jev_prefilter_enabled: "true" }), noEnv)).enabled).toBe(false);
  });

  // A health verdict is only as good as the config it was probed with: an env-only
  // deployment that rotates JEV_API_KEY (or moves JEV_BASE_URL) must not stay "active"
  // on the old probe while every real search fails open.
  it("health is dropped when the effective key or URL no longer matches the probed fingerprint", async () => {
    const probedFor = jevConfigFingerprint("sk-old", "https://env/");
    const base = { jev_health: "ok", jev_prefilter_enabled: "1", [JEV_PROBED_FOR_SETTING_KEY]: probedFor };
    const env = (key: string, url: string) => ({ JEV_API_KEY: key, JEV_BASE_URL: url }) as unknown as NodeJS.ProcessEnv;
    expect((await getJevConfig(repoMap(base), env("sk-old", "https://env/"))).health).toBe("ok");
    expect((await getJevConfig(repoMap(base), env("sk-rotated", "https://env/"))).health).toBeUndefined();
    expect((await getJevConfig(repoMap(base), env("sk-old", "https://moved/"))).health).toBeUndefined();
    expect(isJevPrefilterActive(await getJevConfig(repoMap(base), env("sk-rotated", "https://env/")))).toBe(false);
  });

  it("a legacy \"ok\" saved before fingerprints existed stays valid (no silent deactivation on upgrade)", async () => {
    const cfg = await getJevConfig(repoMap({ jev_api_key: "k", jev_health: "ok", jev_prefilter_enabled: "1" }), noEnv);
    expect(cfg.health).toBe("ok");
  });

  it("jevConfigFingerprint is stable, short, and never contains the key", () => {
    const f = jevConfigFingerprint("sk-or-secret-value", "https://x/");
    expect(f).toBe(jevConfigFingerprint("sk-or-secret-value", "https://x/"));
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(f).not.toContain("secret");
    expect(jevConfigFingerprint("sk-or-secret-value", "https://y/")).not.toBe(f);
  });

  it("env JEV_API_KEY / JEV_BASE_URL fill in when DB is blank", async () => {
    const cfg = await getJevConfig(repoWith(null), { JEV_API_KEY: "sk-env", JEV_BASE_URL: "https://env/" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe("sk-env");
    expect(cfg.baseUrl).toBe("https://env/");
  });
});

// Multi-user: an account that sets only a Base URL would otherwise send the instance's
// global/env key to a host of its choosing on every search. A custom URL carries the
// account's OWN key or nothing.
describe("getJevConfig through the account → global facade: a custom URL never carries a borrowed key", () => {
  const repoOf = (own: Record<string, string>, global: Record<string, string>) => ({
    getAccountSetting: async (_accountId: string, key: string) => own[key] ?? null,
    getSetting: async (key: string) => global[key] ?? null,
  });
  const on = { jev_prefilter_enabled: "1", jev_health: "ok" };
  const sharedEnv = { JEV_API_KEY: "sk-shared" } as unknown as NodeJS.ProcessEnv;

  it("the facade exposes the account's own row, without fallback, as getOwnSetting", async () => {
    const scoped = getAccountScopedSettings("acct_a", repoOf({ x: "mine" }, { x: "global", y: "g" }));
    expect(await scoped.getOwnSetting("x")).toBe("mine");
    expect(await scoped.getOwnSetting("y")).toBeNull();
    expect(await scoped.getSetting("y")).toBe("g");
  });

  it("account URL override + key inherited from env → inactive, and no judge is built", async () => {
    const scoped = getAccountScopedSettings("acct_a", repoOf({ ...on, jev_base_url: "https://evil.example/" }, {}));
    expect(isJevPrefilterActive(await getJevConfig(scoped, sharedEnv))).toBe(false);
    expect(await resolveJevJudge(scoped, sharedEnv)).toBeUndefined();
  });

  it("account URL override + key inherited from the instance-wide (global) row → inactive", async () => {
    const scoped = getAccountScopedSettings(
      "acct_a",
      repoOf({ ...on, jev_base_url: "https://evil.example/" }, { jev_api_key: "sk-shared" }),
    );
    expect(isJevPrefilterActive(await getJevConfig(scoped, noEnv))).toBe(false);
  });

  it("account URL override + the account's OWN key → active", async () => {
    const scoped = getAccountScopedSettings(
      "acct_a",
      repoOf({ ...on, jev_api_key: "sk-mine", jev_base_url: "https://api.typesafe.ai/v1/systemone" }, {}),
    );
    const cfg = await getJevConfig(scoped, sharedEnv);
    expect(cfg.apiKey).toBe("sk-mine");
    expect(isJevPrefilterActive(cfg)).toBe(true);
  });

  it("no account URL override + inherited key → active (the env-only / operator-configured deployment)", async () => {
    const scoped = getAccountScopedSettings("acct_a", repoOf({ ...on }, {}));
    expect(isJevPrefilterActive(await getJevConfig(scoped, sharedEnv))).toBe(true);
  });
});

// What a BLANK account Base URL resolves to — the save action probes it and the settings
// input shows it as the placeholder, so the two can never tell different stories.
describe("getJevInheritedBaseUrl (where a blank account Base URL goes)", () => {
  const repo = (global: string | null) => ({
    getSetting: async (key: string) => (key === JEV_BASE_URL_SETTING_KEY ? global : null),
  });
  const env = (url?: string) => (url === undefined ? noEnv : ({ JEV_BASE_URL: url } as unknown as NodeJS.ProcessEnv));

  it("instance-wide (global) row first, trimmed", async () => {
    expect(await getJevInheritedBaseUrl(repo(" https://global.example/v1/systemone "), env("https://env.example/"))).toBe(
      "https://global.example/v1/systemone",
    );
  });

  it("then env JEV_BASE_URL", async () => {
    expect(await getJevInheritedBaseUrl(repo(null), env(" https://env.example/api/alpha/decisions "))).toBe(
      "https://env.example/api/alpha/decisions",
    );
    expect(await getJevInheritedBaseUrl(repo("  "), env("https://env.example/"))).toBe("https://env.example/");
  });

  it("then the OpenRouter default", async () => {
    expect(await getJevInheritedBaseUrl(repo(null), env())).toBe("https://openrouter.ai/api/alpha/decisions");
  });
});

describe("getJevBaseUrlOverride (the settings input shows the account's OWN override)", () => {
  // The page reads through the account → global facade elsewhere; for THIS input a
  // global value must not be prefilled — saving the form again would copy it into
  // the account row and freeze it (later operator / env changes would stop applying).
  const repo = (own: string | null, global: string | null) => ({
    getAccountSetting: async (_accountId: string, key: string) => (key === JEV_BASE_URL_SETTING_KEY ? own : null),
    getSetting: async (key: string) => (key === JEV_BASE_URL_SETTING_KEY ? global : null),
  });

  it("no account row → \"\" even when a global URL exists", async () => {
    expect(await getJevBaseUrlOverride("acct_a", repo(null, "https://global.example/v1/systemone"))).toBe("");
  });

  it("account row → that value, trimmed", async () => {
    expect(await getJevBaseUrlOverride("acct_a", repo(" https://mine.example/v1/systemone ", "https://global.example/"))).toBe(
      "https://mine.example/v1/systemone",
    );
  });
});

describe("resolveJevJudge (the single go/no-go for wrapping the provider)", () => {
  it("undefined unless key set AND enabled AND health ok", async () => {
    expect(await resolveJevJudge(repoMap({ jev_api_key: "k", jev_prefilter_enabled: "1" }), noEnv)).toBeUndefined(); // no health
    expect(await resolveJevJudge(repoMap({ jev_api_key: "k", jev_health: "ok" }), noEnv)).toBeUndefined(); // not enabled
    expect(await resolveJevJudge(repoMap({ jev_prefilter_enabled: "1", jev_health: "ok" }), noEnv)).toBeUndefined(); // no key
    const judge = await resolveJevJudge(
      repoMap({ jev_api_key: "k", jev_prefilter_enabled: "1", jev_health: "ok" }),
      noEnv,
    );
    expect(judge).toBeDefined();
    expect(typeof judge!.judgeCandidates).toBe("function");
  });

  it("isJevPrefilterActive is the same go/no-go, on an already-read config", async () => {
    const active = await getJevConfig(
      repoMap({ jev_api_key: "k", jev_prefilter_enabled: "1", jev_health: "ok" }),
      noEnv,
    );
    expect(isJevPrefilterActive(active)).toBe(true);
    expect(isJevPrefilterActive({ ...active, health: "fail" })).toBe(false);
    expect(isJevPrefilterActive({ ...active, enabled: false })).toBe(false);
    expect(isJevPrefilterActive({ ...active, apiKey: undefined })).toBe(false);
  });
});


describe("importForeignWorkFiles rechecks the update hold inside the in-flight guard", () => {
  it("throws UpdateInProgressError before any storage work when the hold is on", async () => {
    const { setUpdateHold, clearUpdateHold, inFlightCount } = await import("./update-hold");
    setUpdateHold(Date.now(), 60_000);
    try {
      await expect(
        importForeignWorkFiles({ providerFileIds: ["1"], movieTitle: "沙丘", year: 2021 }),
      ).rejects.toBeInstanceOf(UpdateInProgressError);
      // The guard released even though the work threw.
      expect(inFlightCount()).toBe(0);
    } finally {
      clearUpdateHold();
    }
  });
});

describe("runAutoUpdateIfDue（每日自动更新）", () => {
  // 内存 SQLite 真读写设置、fake Date 钉北京钟；更新视图和更新助手客户端 mock 掉
  // （runAutoUpdateIfDue 是动态 import 它们的，vi.doMock 可以顶掉）。
  const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
  const TAG = "v2026.10.02";
  const idle = {
    phase: "idle",
    targetTag: null,
    fromCommit: null,
    startedAt: null,
    finishedAt: null,
    message: "",
    logTail: "",
  };
  let updater: Record<string, unknown> | null;
  let available: { tag: string; commit: string } | null;
  const loadUpdateView = vi.fn();
  const requestUpdate = vi.fn();
  let rt: typeof import("./workflow-runtime");

  const boot = async (settings: Record<string, string>, beijingISO: string) => {
    updater = { ...idle };
    available = { tag: TAG, commit: "c".repeat(40) };
    loadUpdateView.mockReset();
    loadUpdateView.mockImplementation(async () => ({ available, updater, updaterInstalled: true }));
    requestUpdate.mockReset();
    requestUpdate.mockImplementation(async () => ({ ok: true }));
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${beijingISO}:00.000+08:00`));
    vi.resetModules();
    vi.doMock("./update-view-server", () => ({ loadUpdateView }));
    vi.doMock("./updater-client", async () => ({
      ...(await vi.importActual<typeof import("./updater-client")>("./updater-client")),
      requestUpdate,
    }));
    rt = await import("./workflow-runtime");
    const repository = rt.getWorkflowRepository();
    for (const [key, value] of Object.entries(settings)) {
      await repository.setSetting(key, value);
    }
    return repository;
  };
  const at = (beijingISO: string) => vi.setSystemTime(new Date(`${beijingISO}:00.000+08:00`));
  const ON = { auto_update_enabled: "1" };

  afterEach(async () => {
    vi.useRealTimers();
    vi.doUnmock("./update-view-server");
    vi.doUnmock("./updater-client");
    delete process.env.MEDIA_TRACK_SQLITE_PATH;
    delete process.env.MEDIA_TRACK_DESKTOP;
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
    const { clearUpdateHold } = await import("./update-hold");
    clearUpdateHold();
    vi.resetModules();
  });

  it("does nothing when switched off, without even reading the release list", async () => {
    const repository = await boot({}, "2026-10-03T05:00");
    // The worker asks every 3 s and the switch is off by default: one settings read, no more.
    const getSetting = vi.spyOn(repository, "getSetting");
    await rt.runAutoUpdateIfDue();
    expect(getSetting.mock.calls).toEqual([["auto_update_enabled"]]);
    expect(loadUpdateView).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("waits for the set time (default 04:00) and looks at GitHub only once it has passed", async () => {
    const repository = await boot(ON, "2026-10-03T03:59");
    await rt.runAutoUpdateIfDue();
    expect(loadUpdateView).not.toHaveBeenCalled();
    expect(await repository.getSetting("auto_update_last_attempt")).toBeNull();
    at("2026-10-03T04:00");
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledWith(TAG);
  });

  it("honours the configured hour, and falls back to 04:00 for a malformed one", async () => {
    await boot({ ...ON, auto_update_time: "13:00" }, "2026-10-03T12:59");
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).not.toHaveBeenCalled();
    at("2026-10-03T13:00");
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    for (const bad of ["99:99", "13:30"]) {
      await boot({ ...ON, auto_update_time: bad }, "2026-10-03T04:05");
      await rt.runAutoUpdateIfDue();
      expect(requestUpdate).toHaveBeenCalledTimes(1);
    }
  });

  it("asks at most once per Beijing day, whatever the outcome, and again the next day", async () => {
    const repository = await boot(ON, "2026-10-03T04:05");
    await rt.runAutoUpdateIfDue();
    await rt.runAutoUpdateIfDue();
    at("2026-10-03T23:59");
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(loadUpdateView).toHaveBeenCalledTimes(1);
    expect(await repository.getSetting("auto_update_last_attempt")).toBe("2026-10-03");
    at("2026-10-04T04:00");
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });

  it("uses up the day even when there is nothing to update to, or the updater does not answer", async () => {
    const repository = await boot(ON, "2026-10-03T04:05");
    available = null;
    await rt.runAutoUpdateIfDue();
    expect(await repository.getSetting("auto_update_last_attempt")).toBe("2026-10-03");
    available = { tag: TAG, commit: "c".repeat(40) };
    await rt.runAutoUpdateIfDue(); // same day: no second look
    expect(requestUpdate).not.toHaveBeenCalled();
    at("2026-10-04T04:05");
    updater = null;
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(await repository.getSetting("auto_update_last_attempt")).toBe("2026-10-04");
  });

  it.each([
    ["an update is already running", { phase: "building" }],
    ["a checkout is waiting to be restored", { phase: "failed", pendingRestore: true }],
    ["a rollback needs a person", { phase: "failed", needsManualRecovery: true }],
    ["the deploy folder was changed by hand", { phase: "failed", servingUnknown: true }],
  ])("does not start while %s", async (_name, status) => {
    const repository = await boot(ON, "2026-10-03T04:05");
    updater = { ...idle, ...status };
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(await repository.getSetting("auto_update_last_attempt")).toBe("2026-10-03");
  });

  it("does not start while this web process is holding new tasks for an update", async () => {
    await boot(ON, "2026-10-03T04:05");
    const { setUpdateHold } = await import("./update-hold");
    setUpdateHold(Date.now(), 60_000);
    await rt.runAutoUpdateIfDue();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("does nothing on desktop or in demo mode", async () => {
    const repository = await boot(ON, "2026-10-03T04:05");
    process.env.MEDIA_TRACK_DESKTOP = "1";
    await rt.runAutoUpdateIfDue();
    delete process.env.MEDIA_TRACK_DESKTOP;
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    await rt.runAutoUpdateIfDue();
    expect(loadUpdateView).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(await repository.getSetting("auto_update_last_attempt")).toBeNull();
  });

  it("a refused request does not count as a failed update", async () => {
    const repository = await boot(ON, "2026-10-03T04:05");
    requestUpdate.mockImplementation(async () => ({ ok: false, reason: "busy" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await rt.runAutoUpdateIfDue();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("busy"));
    } finally {
      warn.mockRestore();
    }
    expect(await repository.getSetting("auto_update_fail_streak")).toBeNull();
  });

  describe("two failures on the same release stop it", () => {
    const failed = (finishedAt: string, tag = TAG) => ({
      ...idle,
      phase: "rolled_back",
      targetTag: tag,
      finishedAt,
    });
    const streak = async (repository: { getSetting(k: string): Promise<string | null> }) => {
      const raw = await repository.getSetting("auto_update_fail_streak");
      return raw ? (JSON.parse(raw) as { tag: string; count: number }) : null;
    };

    it("tries again after the first failure, and gives up after the second", async () => {
      const repository = await boot(ON, "2026-10-03T04:05");
      await rt.runAutoUpdateIfDue(); // day 1: first attempt
      expect(requestUpdate).toHaveBeenCalledTimes(1);

      updater = failed("2026-10-02T20:20:00.000Z");
      at("2026-10-04T04:05");
      await rt.runAutoUpdateIfDue(); // day 2: sees failure 1, tries again
      expect(await streak(repository)).toMatchObject({ tag: TAG, count: 1 });
      expect(requestUpdate).toHaveBeenCalledTimes(2);

      updater = failed("2026-10-03T20:20:00.000Z");
      at("2026-10-05T04:05");
      await rt.runAutoUpdateIfDue(); // day 3: sees failure 2, stops
      expect(await streak(repository)).toMatchObject({ tag: TAG, count: 2 });
      expect(requestUpdate).toHaveBeenCalledTimes(2);

      at("2026-10-06T04:05");
      await rt.runAutoUpdateIfDue(); // still stopped on later days
      expect(requestUpdate).toHaveBeenCalledTimes(2);
    });

    it("counts one failed attempt once, however many days pass without a new attempt", async () => {
      const repository = await boot(ON, "2026-10-03T04:05");
      updater = failed("2026-10-02T20:20:00.000Z");
      // Day 1 and day 2 both skip (a person's own deploy is under way), then it clears.
      updater = { ...updater, servingUnknown: true };
      await rt.runAutoUpdateIfDue();
      at("2026-10-04T04:05");
      await rt.runAutoUpdateIfDue();
      updater = failed("2026-10-02T20:20:00.000Z");
      at("2026-10-05T04:05");
      await rt.runAutoUpdateIfDue();
      expect(await streak(repository)).toMatchObject({ tag: TAG, count: 1 });
      expect(requestUpdate).toHaveBeenCalledTimes(1);
    });

    it("a newer release is tried again after the older one gave up", async () => {
      const repository = await boot(
        { ...ON, auto_update_fail_streak: JSON.stringify({ tag: TAG, count: 2, at: "x" }) },
        "2026-10-03T04:05",
      );
      await rt.runAutoUpdateIfDue();
      expect(requestUpdate).not.toHaveBeenCalled();
      available = { tag: "v2026.10.03", commit: "d".repeat(40) };
      updater = failed("2026-10-02T20:20:00.000Z");
      at("2026-10-04T04:05");
      await rt.runAutoUpdateIfDue();
      expect(requestUpdate).toHaveBeenCalledWith("v2026.10.03");
      expect(await streak(repository)).toMatchObject({ tag: TAG, count: 2 });
    });

    it("an empty or corrupt streak counts as none", async () => {
      await boot({ ...ON, auto_update_fail_streak: "{oops" }, "2026-10-03T04:05");
      await rt.runAutoUpdateIfDue();
      expect(requestUpdate).toHaveBeenCalledTimes(1);
      await boot({ ...ON, auto_update_fail_streak: "" }, "2026-10-03T04:05");
      await rt.runAutoUpdateIfDue();
      expect(requestUpdate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("queueing on a drive whose login died names that drive's brand", () => {
  // 在内存 SQLite 里绑一块已冻结的 123 网盘；这两个入口在碰网络之前就会查冻结。
  const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
  const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
  let rt: typeof import("./workflow-runtime");

  beforeEach(async () => {
    delete process.env.MEDIA_TRACK_MULTI_USER;
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    vi.resetModules();
    rt = await import("./workflow-runtime");
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_pan123_1",
      accountId: "acct_default",
      provider: "pan123",
      providerUid: "1",
      payload: {},
      createdAt: "2026-09-30T00:00:00.000Z",
    });
    await repository.setConnectedStorageStatus("cs_pan123_1", "frozen", "PAN123_AUTH_FAILED: 未登录", "2026-09-30T00:00:00.000Z");
  });

  afterEach(() => {
    delete process.env.MEDIA_TRACK_SQLITE_PATH;
    if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
    if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
    vi.resetModules();
  });

  it("asks to re-scan the same 123网盘, not a 115", async () => {
    const refusal = { status: "unsupported", message: "该网盘已掉线，请重新扫码绑定同一个123网盘后再获取。" };
    expect(await rt.queueCandidateSeries("tmdb_tv_1_s1", "cs_pan123_1")).toEqual(refusal);
    expect(await rt.queueCandidateTracking("tmdb_tv_1_s1", "cs_pan123_1")).toEqual(refusal);
  });
});

describe("runNextQueuedWorkflow — queued runs going side by side", () => {
  // The worker's drain calls this once per claim, with its drive filter; several runs
  // can be going at once. Harness as for runScheduledType3: in-memory SQLite, the
  // queued runners and the push stubbed (no drive, no model, no network).
  const idle = async () => ({ status: "idle" as const });
  const stubs = {
    runQueuedType2Workflow: vi.fn(idle),
    runQueuedSeriesInitialization: vi.fn(idle),
    runQueuedMovieAcquisition: vi.fn(idle),
    runQueuedReplaceRequest: vi.fn(idle),
    runQueuedStagingRecovery: vi.fn(idle),
    enqueueUrgentReplaceRequests: vi.fn(async () => undefined),
    sendPushNotifications: vi.fn(async () => undefined),
  };
  const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
  let rt: typeof import("./workflow-runtime");

  const boot = async () => {
    for (const stub of Object.values(stubs)) stub.mockReset();
    for (const runner of [
      stubs.runQueuedType2Workflow,
      stubs.runQueuedSeriesInitialization,
      stubs.runQueuedMovieAcquisition,
      stubs.runQueuedReplaceRequest,
      stubs.runQueuedStagingRecovery,
    ]) {
      runner.mockImplementation(idle);
    }
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    vi.resetModules();
    vi.doMock("@media-track/workflow", async () => {
      const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
      return { ...actual, ...stubs };
    });
    rt = await import("./workflow-runtime");
    return rt.getWorkflowRepository();
  };

  afterEach(() => {
    vi.doUnmock("@media-track/workflow");
    delete process.env.MEDIA_TRACK_SQLITE_PATH;
    if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
    vi.resetModules();
  });

  it("hands the drain's claim options to every queued runner", async () => {
    await boot();
    const claim = { excludeConnectedStorageIds: ["cs_115"], excludeUnbound: true, onClaimed: vi.fn() };

    expect(await rt.runNextQueuedWorkflow(claim)).toEqual({ status: "idle" });
    for (const runner of [
      stubs.runQueuedType2Workflow,
      stubs.runQueuedSeriesInitialization,
      stubs.runQueuedMovieAcquisition,
      stubs.runQueuedReplaceRequest,
      stubs.runQueuedStagingRecovery,
    ]) {
      expect(runner).toHaveBeenCalledWith(expect.objectContaining({ claim }));
    }
  });

  it("pushes only the finished run's notifications, not those of a run going beside it", async () => {
    const repository = await boot();
    const event = (id: string, workflowRunId: string) => ({
      id,
      workflowRunId,
      kind: "movie_obtained",
      title: id,
      body: id,
      createdAt: new Date().toISOString(),
      trigger: "user" as const,
    });
    vi.spyOn(repository, "listRecentNotificationsWithAccount").mockResolvedValue([
      { accountId: "acct_default", connectedStorageId: "cs_115", notification: event("n_115", "run_115") },
      { accountId: "acct_default", connectedStorageId: "cs_guangya", notification: event("n_guangya", "run_guangya") },
    ]);
    stubs.runQueuedMovieAcquisition.mockImplementation(
      async () => ({ status: "ran", workflowRunId: "run_115", workflowStatus: "succeeded" }) as never,
    );

    await rt.runNextQueuedWorkflow();

    expect(stubs.sendPushNotifications).toHaveBeenCalledTimes(1);
    expect(stubs.sendPushNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ notification: expect.objectContaining({ id: "n_115" }) }),
    );
  });

  it("a series run pushes the notifications on its per-season record too", async () => {
    // Series init saves its notifications on `${runId}_s${n}` (see runner-v2).
    const repository = await boot();
    const event = (id: string, workflowRunId: string) => ({
      id,
      workflowRunId,
      kind: "series_initialized",
      title: id,
      body: id,
      createdAt: new Date().toISOString(),
      trigger: "user" as const,
    });
    vi.spyOn(repository, "listRecentNotificationsWithAccount").mockResolvedValue([
      { accountId: "acct_default", connectedStorageId: "cs_115", notification: event("n_s1", "run_series_s1") },
      { accountId: "acct_default", connectedStorageId: "cs_115", notification: event("n_lookalike", "run_series_sx") },
      { accountId: "acct_default", connectedStorageId: "cs_quark", notification: event("n_other", "run_series2") },
    ]);
    stubs.runQueuedSeriesInitialization.mockImplementation(
      async () => ({ status: "ran", workflowRunId: "run_series", workflowStatus: "succeeded" }) as never,
    );

    await rt.runNextQueuedWorkflow();

    expect(stubs.sendPushNotifications).toHaveBeenCalledTimes(1);
    expect(stubs.sendPushNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ notification: expect.objectContaining({ id: "n_s1" }) }),
    );
  });

  it("reads the 同时处理 setting for the worker (1 when unset)", async () => {
    const repository = await boot();
    expect(await rt.getWorkerConcurrency()).toBe(1);
    await repository.setSetting(rt.PATROL_CONCURRENCY_SETTING_KEY, "5");
    expect(await rt.getWorkerConcurrency()).toBe(5);
  });
});
