import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("./deployment-update-server", () => ({ loadDeploymentUpdateState: vi.fn(async () => null) }));
vi.mock("./workflow-runtime", () => ({
  getAccountScopedSettings: vi.fn(() => ({ getSetting: async () => null })),
  getCurrentAccountId: vi.fn(async () => "acct_default"),
  getLlmConfig: vi.fn(async () => ({ baseURL: "https://llm.example", modelId: "m" })),
  getWorkflowRepository: vi.fn(),
  isMultiUserEnabled: vi.fn(() => false),
  PANSOU_BASE_URL_SETTING_KEY: "pansou_base_url",
  PANSOU_HEALTH_SETTING_KEY: "pansou_last_probe",
  UNAUTHENTICATED_ACCOUNT_ID: "acct_unauthenticated",
}));

import { isDemoMode } from "./demo-mode";
import { loadDeploymentUpdateState } from "./deployment-update-server";
import {
  dismissSettingsAttentionItem,
  loadSettingsAttentionSummary,
  markSettingsAttentionSeen,
} from "./settings-attention-server";
import {
  getAccountScopedSettings,
  getCurrentAccountId,
  getLlmConfig,
  getWorkflowRepository,
  isMultiUserEnabled,
} from "./workflow-runtime";

const UPDATE_BEHIND = {
  kind: "container" as const,
  behind: true,
  currentShort: "1111111",
  latestShort: "2222222",
};

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
  (loadDeploymentUpdateState as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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
    const summary = await loadSettingsAttentionSummary({ origin: "https://o.example" });
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

    const cleared = await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(cleared.count).toBe(0); // badge cleared…
    expect(cleared.severity).toBeNull();
    expect(cleared.items).toHaveLength(1); // …but inbox still lists it

    // Drive recovers → state ends (entry dropped on read)…
    drives[0]!.status = "active";
    await loadSettingsAttentionSummary({ origin: "https://o.example" });
    // …then freezes AGAIN → fresh state_since > seen_at → badge returns.
    drives[0]!.status = "frozen";
    const refrozen = await loadSettingsAttentionSummary({ origin: "https://o.example" });
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

    const dismissed = await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(dismissed.items).toEqual([]);
    expect(dismissed.count).toBe(0);

    // Re-freeze AFTER the dismissal → new occurrence → dismissal no longer applies.
    drives[0]!.status = "active";
    await loadSettingsAttentionSummary({ origin: "https://o.example" });
    drives[0]!.status = "frozen";
    const refrozen = await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(refrozen.items.map((i) => i.id)).toEqual(["frozen:cs1"]);
    expect(refrozen.count).toBe(1);
  });

  it("update item is owner-only in multi-user, implicit owner in single-user", async () => {
    (loadDeploymentUpdateState as ReturnType<typeof vi.fn>).mockResolvedValue(UPDATE_BEHIND);

    const single = await loadSettingsAttentionSummary({
      ...{ origin: "https://o.example" },
    });
    expect(single.items.some((i) => i.kind === "update_available")).toBe(true);

    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_bob");
    makeRepository([], { acct_bob: { isOwner: false } });
    const member = await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(member.items.some((i) => i.kind === "update_available")).toBe(false);

    makeRepository([], { acct_bob: { isOwner: true } });
    const owner = await loadSettingsAttentionSummary({ origin: "https://o.example" });
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

  it("non-owners never trigger the update probe (badge polls every 8s; the probe can block 5s cold)", async () => {
    (loadDeploymentUpdateState as ReturnType<typeof vi.fn>).mockResolvedValue(UPDATE_BEHIND);
    (isMultiUserEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_bob");

    makeRepository([], { acct_bob: { isOwner: false } });
    await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(loadDeploymentUpdateState).not.toHaveBeenCalled();

    // 站主仍照常探测。
    makeRepository([], { acct_bob: { isOwner: true } });
    await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(loadDeploymentUpdateState).toHaveBeenCalled();
  });

  it("never writes attention state for the unauthenticated sentinel", async () => {
    (getCurrentAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_unauthenticated");
    const { repository } = makeRepository([]);
    await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(repository.setAccountSetting).not.toHaveBeenCalled();
  });

  /** 自建搜索源告警的数据来源必须是**存下来的**探活结论,不能现打网络:
   *  这个函数在徽章轮询路径上,每 8s 跑一次。 */
  it("warns from the STORED probe verdict, without probing the network", async () => {
    const settings = new Map<string, string>([
      ["pansou_base_url", "http://192.168.1.10:8899"],
      ["pansou_last_probe", "unreachable"],
    ]);
    (getAccountScopedSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: async (key: string) => settings.get(key) ?? null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    makeRepository([]);

    const summary = await loadSettingsAttentionSummary({ origin: "https://o.example" });

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
    const summary = await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(summary.items.map((i) => i.kind)).not.toContain("search_source_unreachable");
  });

  it("stays quiet for a custom source that has never been probed (老用户不该被假警报打扰)", async () => {
    const settings = new Map<string, string>([["pansou_base_url", "http://192.168.1.10:8899"]]);
    (getAccountScopedSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      getSetting: async (key: string) => settings.get(key) ?? null,
    });
    makeRepository([]);
    const summary = await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(summary.items.map((i) => i.kind)).not.toContain("search_source_unreachable");
  });

  it("demo mode returns empty without touching the repository", async () => {    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { repository } = makeRepository([{ id: "cs1", provider: "quark", label: null, status: "frozen" }]);
    const summary = await loadSettingsAttentionSummary({ origin: "https://o.example" });
    expect(summary).toEqual({ count: 0, severity: null, items: [] });
    expect(repository.listConnectedStorages).not.toHaveBeenCalled();
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
