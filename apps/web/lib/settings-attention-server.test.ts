import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_LLM_PRESET } from "@media-track/workflow";

vi.mock("./demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("./update-view-server", () => ({ loadUpdateView: vi.fn(async () => ({ available: null, current: { label: "v2026.09.28", tag: "v2026.09.28" } })) }));
vi.mock("./workflow-runtime", () => ({
  getAccountScopedSettings: vi.fn(() => ({ getSetting: async () => null })),
  getCurrentAccountId: vi.fn(async () => "acct_default"),
  getLlmConfig: vi.fn(async () => ({ baseURL: "https://llm.example", modelId: "m" })),
  resolveAgentModelConfig: vi.fn(async () => ({
    baseURL: "https://llm.example",
    modelId: "m",
    source: "db",
  })),
  getWorkflowRepository: vi.fn(),
  isMultiUserEnabled: vi.fn(() => false),
  resolveIsDesktop: vi.fn(() => false),
  PANSOU_BASE_URL_SETTING_KEY: "pansou_base_url",
  PANSOU_HEALTH_SETTING_KEY: "pansou_last_probe",
  UNAUTHENTICATED_ACCOUNT_ID: "acct_unauthenticated",
}));

import { isDemoMode } from "./demo-mode";
import { loadUpdateView } from "./update-view-server";
import {
  dismissSettingsAttentionItem,
  loadSettingsAttentionSummary,
  markSettingsAttentionSeen,
  resolveCurrentIsOwner,
} from "./settings-attention-server";
import {
  getAccountScopedSettings,
  getCurrentAccountId,
  getLlmConfig,
  getWorkflowRepository,
  isMultiUserEnabled,
  resolveAgentModelConfig,
  resolveIsDesktop,
} from "./workflow-runtime";

const VIEW_UPDATE = {
  available: { tag: "v2026.10.02", commit: "2".repeat(40), date: "2026-10-02", notes: [] },
  current: { label: "v2026.09.28", tag: "v2026.09.28" },
};
const VIEW_LATEST = { available: null, current: { label: "v2026.09.28", tag: "v2026.09.28" } };

type Drive = { id: string; provider: string; label: string | null; status: "active" | "frozen" };

function makeRepository(drives: Drive[], accounts: Record<string, { isOwner: boolean }> = {}) {
  const accountSettings = new Map<string, string>();
  const repository = {
    listConnectedStorages: vi.fn(async () => drives),
    getAccountById: vi.fn(async (id: string) =>
      accounts[id] ? { id, username: id, isOwner: accounts[id]!.isOwner } : null,
    ),
    getAccountSetting: vi.fn(async (accountId: string, key: string) =>
      accountSettings.get(`${accountId}${key}`) ?? null,
    ),
    setAccountSetting: vi.fn(async (accountId: string, key: string, value: string) => {
      accountSettings.set(`${accountId}${key}`, value);
    }),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => {}),
  };
  (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue(repository);
  return { repository, accountSettings };
}

const T_OLD = "2026-07-01T00:00:00.000Z";
const T_MID = "2026-07-02T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_default");
  (getLlmConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    baseURL: "https://llm.example",
    modelId: "m",
  });
  // 生效配置与 DB 配置保持一致的自定义形态（已配置）；免费预设回落用例在
  // 各测试里单独 override。
  (resolveAgentModelConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    baseURL: "https://llm.example",
    modelId: "m",
    source: "db",
  });
  (loadUpdateView as ReturnType<typeof vi.fn>).mockResolvedValue(VIEW_LATEST);
  (resolveIsDesktop as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  // clearAllMocks 会连声明处的实现一起清掉,这里补回默认值:没配自建搜索源。
  (getAccountScopedSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    getSetting: async () => null,
  });
});

describe("loadSettingsAttentionSummary — per-account state", () => {
  it("first sight persists state_since per account and counts everything (seenAt null)", async () => {
    const { repository, accountSettings } = makeRepository([
      { id: "cs1", provider: "quark", label: null, status: "frozen" },
    ]);
    const summary = await loadSettingsAttentionSummary({});
    expect(summary.items.map((i) => i.id)).toEqual(["frozen:cs1"]);
    expect(summary.count).toBe(1);
    const raw = accountSettings.get("acct_defaultattention_state_since");
    expect(raw).toBeDefined();
    expect(Object.keys(JSON.parse(raw!))).toEqual(["frozen:cs1"]);
    expect(repository.setAccountSetting).toHaveBeenCalledWith(
      "acct_default",
      "attention_state_since",
      expect.any(String),
    );
  });

  it("badge clears after seen_at, items stay listed; a NEW occurrence re-badges", async () => {
    const drives: Drive[] = [{ id: "cs1", provider: "quark", label: null, status: "frozen" }];
    const { accountSettings } = makeRepository(drives);
    accountSettings.set("acct_defaultattention_state_since", JSON.stringify({ "frozen:cs1": T_OLD }));
    accountSettings.set("acct_defaultattention_seen_at", T_MID);

    const cleared = await loadSettingsAttentionSummary({});
    expect(cleared.count).toBe(0); // badge cleared…
    expect(cleared.severity).toBeNull();
    expect(cleared.items).toHaveLength(1); // …but inbox still lists it

    // Drive recovers → state ends (entry dropped on read)…
    drives[0]!.status = "active";
    await loadSettingsAttentionSummary({});
    // …then freezes AGAIN → fresh state_since > seen_at → badge returns.
    drives[0]!.status = "frozen";
    const refrozen = await loadSettingsAttentionSummary({});
    expect(refrozen.count).toBe(1);
    expect(refrozen.severity).toBe("blocker");
  });

  it("dismissed items leave inbox + count; a re-freeze resurrects them (read-time filtering)", async () => {
    const drives: Drive[] = [{ id: "cs1", provider: "quark", label: null, status: "frozen" }];
    const { accountSettings } = makeRepository(drives);
    accountSettings.set("acct_defaultattention_state_since", JSON.stringify({ "frozen:cs1": T_OLD }));
    accountSettings.set(
      "acct_defaultattention_dismissed",
      JSON.stringify({ "frozen:cs1": T_MID }),
    );

    const dismissed = await loadSettingsAttentionSummary({});
    expect(dismissed.items).toEqual([]);
    expect(dismissed.count).toBe(0);

    // Re-freeze AFTER the dismissal → new occurrence → dismissal no longer applies.
    drives[0]!.status = "active";
    await loadSettingsAttentionSummary({});
    drives[0]!.status = "frozen";
    const refrozen = await loadSettingsAttentionSummary({});
    expect(refrozen.items.map((i) => i.id)).toEqual(["frozen:cs1"]);
    expect(refrozen.count).toBe(1);
  });

  it("update item is owner-only in multi-user, implicit owner in single-user", async () => {
    (loadUpdateView as ReturnType<typeof vi.fn>).mockResolvedValue(VIEW_UPDATE);

    const single = await loadSettingsAttentionSummary({});
    expect(single.items.some((i) => i.kind === "update_available")).toBe(true);

    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_bob");
    makeRepository([], { acct_bob: { isOwner: false } });
    const member = await loadSettingsAttentionSummary({});
    expect(member.items.some((i) => i.kind === "update_available")).toBe(false);

    makeRepository([], { acct_bob: { isOwner: true } });
    const owner = await loadSettingsAttentionSummary({});
    expect(owner.items.some((i) => i.kind === "update_available")).toBe(true);
  });

  it("never writes for the unauthenticated sentinel (same invariant as markSettingsAttentionSeen)", async () => {
    const { accountSettings, repository } = makeRepository([]);
    await dismissSettingsAttentionItem(
      "acct_unauthenticated",
      "frozen:cs1",
      "2026-07-27T01:00:00.000Z",
    );
    expect(repository.setAccountSetting).not.toHaveBeenCalled();
    expect(accountSettings.get("acct_unauthenticatedattention_dismissed")).toBeUndefined();
  });

  it("rejects a non-allowlisted id at the storage layer (never writes arbitrary keys)", async () => {
    const { accountSettings, repository } = makeRepository([]);
    await dismissSettingsAttentionItem("acct_default", "__proto__", "2026-07-27T01:00:00.000Z");
    await dismissSettingsAttentionItem("acct_default", "../../etc/passwd", "2026-07-27T01:00:00.000Z");
    expect(repository.setAccountSetting).not.toHaveBeenCalled();
    expect(accountSettings.get("acct_defaultattention_dismissed")).toBeUndefined();
    // 合法 id 照常写入。
    await dismissSettingsAttentionItem("acct_default", "frozen:cs1", "2026-07-27T01:00:00.000Z");
    expect(JSON.parse(accountSettings.get("acct_defaultattention_dismissed")!)).toEqual({
      "frozen:cs1": "2026-07-27T01:00:00.000Z",
    });
  });

  it("non-owners never trigger the update view (badge polls every 8s; loadUpdateView can hit the updater)", async () => {
    (loadUpdateView as ReturnType<typeof vi.fn>).mockResolvedValue(VIEW_UPDATE);
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_bob");

    makeRepository([], { acct_bob: { isOwner: false } });
    await loadSettingsAttentionSummary({});
    expect(loadUpdateView).not.toHaveBeenCalled();

    // 站主仍照常读取发布视图。
    makeRepository([], { acct_bob: { isOwner: true } });
    await loadSettingsAttentionSummary({});
    expect(loadUpdateView).toHaveBeenCalledWith({ updaterStatus: false });
  });

  it("still offers the update badge on desktop when a newer release exists (links to the update tab)", async () => {
    (loadUpdateView as ReturnType<typeof vi.fn>).mockResolvedValue(VIEW_UPDATE);
    (resolveIsDesktop as ReturnType<typeof vi.fn>).mockReturnValue(true);
    makeRepository([]);
    const summary = await loadSettingsAttentionSummary({});
    expect(loadUpdateView).toHaveBeenCalledWith({ updaterStatus: false });
    const item = summary.items.find((i) => i.kind === "update_available");
    expect(item?.href).toContain("tab=update");
  });

  it("never writes attention state for the unauthenticated sentinel", async () => {
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_unauthenticated");
    const { repository } = makeRepository([]);
    await loadSettingsAttentionSummary({});
    expect(repository.setAccountSetting).not.toHaveBeenCalled();
  });

  /** 自建搜索源告警的数据来源必须是**存下来的**探活结论,不能现打网络:
   *  这个函数在徽章轮询路径上,每 8s 跑一次。 */
  it("warns for an env-injected source even when the DB setting is empty", async () => {
    // compose 用 PANSOU_BASE_URL 注入自带容器,DB 是空的。只看 DB 会把 env-only
    // 场景误判成未配置,于是 recordPanSouHealth 写了 unhealthy、徽章却不亮。
    const settings = new Map<string, string>([
      // 注意:pansou_base_url 留空(env 注入场景),只有健康结论被写下。
      ["pansou_last_probe", "unhealthy"],
    ]);
    (getAccountScopedSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: async (key: string) => settings.get(key) ?? null,
    });

    const summary = await loadSettingsAttentionSummary();

    const item = summary.items.find((i) => i.kind === "search_source_unreachable");
    expect(item).toBeDefined();
  });

  it("warns from the STORED probe verdict, without probing the network", async () => {
    const settings = new Map<string, string>([
      ["pansou_base_url", "http://192.168.1.10:8899"],
      // 真实合约只有 "ok" | "unhealthy" | ""(workflow-runtime.ts);"unreachable"
      // 不是写入方会存的值。用真值让测试与生产行为对齐,免得将来收紧校验时碎掉。
      ["pansou_last_probe", "unhealthy"],
    ]);
    (getAccountScopedSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: async (key: string) => settings.get(key) ?? null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    makeRepository([]);

    const summary = await loadSettingsAttentionSummary({});

    expect(summary.items.map((i) => i.kind)).toContain("search_source_unreachable");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("stays quiet when the stored verdict is ok", async () => {
    const settings = new Map<string, string>([
      ["pansou_base_url", "http://192.168.1.10:8899"],
      ["pansou_last_probe", "ok"],
    ]);
    (getAccountScopedSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: async (key: string) => settings.get(key) ?? null,
    });
    makeRepository([]);
    const summary = await loadSettingsAttentionSummary({});
    expect(summary.items.map((i) => i.kind)).not.toContain("search_source_unreachable");
  });

  it("stays quiet for a custom source that has never been probed (老用户不该被假警报打扰)", async () => {
    const settings = new Map<string, string>([["pansou_base_url", "http://192.168.1.10:8899"]]);
    (getAccountScopedSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: async (key: string) => settings.get(key) ?? null,
    });
    makeRepository([]);
    const summary = await loadSettingsAttentionSummary({});
    expect(summary.items.map((i) => i.kind)).not.toContain("search_source_unreachable");
  });

  it("demo mode returns empty without touching the repository", async () => {
    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { repository } = makeRepository([{ id: "cs1", provider: "quark", label: null, status: "frozen" }]);
    const summary = await loadSettingsAttentionSummary({});
    expect(summary).toEqual({ count: 0, severity: null, items: [] });
    expect(repository.listConnectedStorages).not.toHaveBeenCalled();
  });
});

describe("missing_llm 判定口径 — 生效配置（resolveAgentModelConfig），非原始 DB 配置", () => {
  it("零配置出厂态：DB/env 全空回落免费预设，不再报「还没配置 AI 模型」", async () => {
    makeRepository([]);
    // 原始 DB 配置就是空的（零配置出厂态）——若判定还看这层，就会误报。
    (getLlmConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      baseURL: undefined,
      apiKey: undefined,
      modelId: undefined,
    });
    // 生效配置与获取链路同源：DB+env 全空 → FREE_LLM_PRESET（Kilo 免费池）。
    (resolveAgentModelConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FREE_LLM_PRESET,
      source: "free-preset",
    });

    const summary = await loadSettingsAttentionSummary({});

    expect(summary.items.map((i) => i.kind)).not.toContain("missing_llm");
    expect(summary.count).toBe(0);
  });

  it("「只剩 API Key 的残留」形态（清空地址保存后）同样回落免费预设，不误报", async () => {
    makeRepository([]);
    (getLlmConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      baseURL: undefined,
      apiKey: "sk-leftover",
      modelId: undefined,
    });
    (resolveAgentModelConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FREE_LLM_PRESET,
      source: "free-preset",
    });

    const summary = await loadSettingsAttentionSummary({});

    expect(summary.items.map((i) => i.kind)).not.toContain("missing_llm");
  });

  it("半截配置（有地址没模型名）真的无法构造模型 → 仍提醒", async () => {
    makeRepository([]);
    (getLlmConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      baseURL: "https://llm.example",
      apiKey: undefined,
      modelId: undefined,
    });
    // 半截配置不回落（用户错误不得静默变成免费池），原样返回缺 modelId。
    (resolveAgentModelConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      baseURL: "https://llm.example",
      source: "db",
    });

    const summary = await loadSettingsAttentionSummary({});

    expect(summary.items.map((i) => i.kind)).toContain("missing_llm");
  });
});

describe("resolveCurrentIsOwner — single-user mode", () => {
  // 单用户下经隧道来的匿名访客带一个随便什么 mt_session 也能过 proxy(只查有无),
  // getCurrentAccountId() 会给这样的请求哨兵账号。哨兵绝不能被当成站主。
  it("is not the owner for the unauthenticated sentinel", async () => {
    makeRepository([]);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_unauthenticated");
    expect(await resolveCurrentIsOwner()).toBe(false);
  });

  it("is the owner for acct_default (LAN, or a valid remote session)", async () => {
    makeRepository([]);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_default");
    expect(await resolveCurrentIsOwner()).toBe(true);
  });

  it("gives the sentinel no update item and never reads the update view in the attention summary", async () => {
    (loadUpdateView as ReturnType<typeof vi.fn>).mockResolvedValue(VIEW_UPDATE);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_unauthenticated");
    makeRepository([]);
    const summary = await loadSettingsAttentionSummary({});
    expect(loadUpdateView).not.toHaveBeenCalled();
    expect(summary.items.some((i) => i.kind === "update_available")).toBe(false);
  });
});

describe("markSettingsAttentionSeen", () => {
  it("writes attention_seen_at for the current account", async () => {
    const { accountSettings } = makeRepository([]);
    await markSettingsAttentionSeen("2026-07-27T00:00:00.000Z");
    expect(accountSettings.get("acct_defaultattention_seen_at")).toBe("2026-07-27T00:00:00.000Z");
  });

  it("skips demo mode and the unauthenticated sentinel", async () => {
    const { repository } = makeRepository([]);
    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await markSettingsAttentionSeen();
    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_unauthenticated");
    await markSettingsAttentionSeen();
    expect(repository.setAccountSetting).not.toHaveBeenCalled();
  });
});

describe("dismissSettingsAttentionItem", () => {
  it("records the dismissal time, preserving existing entries", async () => {
    const { accountSettings } = makeRepository([]);
    accountSettings.set(
      "acct_defaultattention_dismissed",
      JSON.stringify({ missing_llm: T_OLD }),
    );
    await dismissSettingsAttentionItem("acct_default", "frozen:cs1", "2026-07-27T01:00:00.000Z");
    const map = JSON.parse(accountSettings.get("acct_defaultattention_dismissed")!);
    expect(map).toEqual({ missing_llm: T_OLD, "frozen:cs1": "2026-07-27T01:00:00.000Z" });
  });

  it("bounds the map to the 100 most recent dismissals", async () => {
    const { accountSettings } = makeRepository([]);
    const existing: Record<string, string> = {};
    for (let i = 0; i < 120; i += 1) {
      existing[`frozen:cs_${String(i).padStart(3, "0")}`] = `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`;
    }
    accountSettings.set("acct_defaultattention_dismissed", JSON.stringify(existing));
    await dismissSettingsAttentionItem("acct_default", "missing_llm", "2026-07-27T01:00:00.000Z");
    const map = JSON.parse(accountSettings.get("acct_defaultattention_dismissed")!);
    expect(Object.keys(map)).toHaveLength(100);
    expect(map["missing_llm"]).toBe("2026-07-27T01:00:00.000Z");
  });

  it("bounds by ACTUAL time, not string order: a -05:00 entry newer than a Z entry survives", async () => {
    // parseAttentionTimeMap 接受带时区偏移的合法 ISO 串，所以裁剪不能按
    // 字典序排。keeper 的字典序比 filler 小、真实时间却更晚——字典序实现
    // 会把它当成最旧的一批丢掉。
    const { accountSettings } = makeRepository([]);
    const existing: Record<string, string> = {
      // 实际 = 2026-06-02T01:00Z，晚于下面所有 filler；但字典序("…T20…")
      // 比 filler("…T23…") 小，字典序实现会把它当最旧的丢掉。
      // id 必须用真实形态：解析层现在按白名单过滤，假 id 会被直接丢掉。
      "frozen:cs_keeper": "2026-06-01T20:00:00.000-05:00",
    };
    for (let i = 0; i < 100; i += 1) {
      // 实际 = 2026-06-01T09:00Z（早于 keeper），字典序却更大。
      existing[`frozen:cs_${String(i).padStart(3, "0")}`] =
        `2026-06-01T23:00:${String(i % 60).padStart(2, "0")}.000+14:00`;
    }
    accountSettings.set("acct_defaultattention_dismissed", JSON.stringify(existing));
    await dismissSettingsAttentionItem("acct_default", "missing_llm", "2026-07-27T01:00:00.000Z");
    const map = JSON.parse(accountSettings.get("acct_defaultattention_dismissed")!);
    expect(Object.keys(map)).toHaveLength(100);
    expect(map["missing_llm"]).toBe("2026-07-27T01:00:00.000Z");
    expect(map["frozen:cs_keeper"]).toBe("2026-06-01T20:00:00.000-05:00");
  });
});
