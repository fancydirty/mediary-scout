import { describe, expect, it } from "vitest";
import {
  applySettingsAttentionState,
  buildSettingsAttentionItems,
  isAttentionItemId,
  parseAttentionTimeMap,
  summarizeSettingsAttention,
} from "./settings-attention";

const brandLabel = (provider: string) =>
  ({ pan115: "115网盘", quark: "夸克网盘", guangya: "光鸭云盘" }[provider] ?? provider);

const ORIGIN = "https://mediary.example.com";

describe("buildSettingsAttentionItems", () => {
  it("returns empty in demo mode even with problems", () => {
    const items = buildSettingsAttentionItems({
      demo: true,
      isOwner: true,
      drives: [{ id: "cs1", provider: "quark", label: null, status: "frozen" }],
      brandLabel, origin: ORIGIN,
      llmConfigured: false,
      update: {
        kind: "container",
        behind: true,
        currentShort: "1111111",
        latestShort: "2222222",
      },
    });
    expect(items).toEqual([]);
  });

  it("lists frozen drives as blockers with plain labels", () => {
    const items = buildSettingsAttentionItems({
      demo: false,
      isOwner: true,
      drives: [
        { id: "cs_q", provider: "quark", label: null, status: "frozen" },
        { id: "cs_a", provider: "pan115", label: "家里115", status: "active" },
      ],
      brandLabel, origin: ORIGIN,
      llmConfigured: true,
      update: null,
    });
    expect(items).toEqual([
      expect.objectContaining({
        id: "frozen:cs_q",
        kind: "frozen_drive",
        severity: "blocker",
        title: "夸克网盘 已失效",
        actionLabel: "去处理",
        href: "/settings",
      }),
    ]);
  });

  it("flags missing LLM config as a warning", () => {
    const items = buildSettingsAttentionItems({
      demo: false,
      isOwner: true,
      drives: [],
      brandLabel, origin: ORIGIN,
      llmConfigured: false,
      update: null,
    });
    expect(items.map((i) => i.kind)).toEqual(["missing_llm"]);
    expect(items[0]?.severity).toBe("warning");
    expect(items[0]?.href).toBe("/settings?tab=services");
  });

  it("adds container update as info severity with version-scoped id + origin-threaded prompt", () => {
    const container = buildSettingsAttentionItems({
      demo: false,
      isOwner: true,
      drives: [],
      brandLabel, origin: ORIGIN,
      llmConfigured: true,
      update: {
        kind: "container",
        behind: true,
        currentShort: "aaaaaaa",
        latestShort: "bbbbbbb",
      },
    });
    expect(container).toHaveLength(1);
    expect(container[0]?.kind).toBe("update_available");
    // Version-scoped id: a NEW remote version gets a NEW id → reappears after dismiss/seen.
    expect(container[0]?.id).toBe("update:bbbbbbb");
    expect(container[0]?.severity).toBe("info");
    expect(container[0]?.prompt).toContain("./scripts/deploy.sh");
    expect(container[0]?.prompt).toContain("aaaaaaa");
    expect(container[0]?.prompt).toContain(ORIGIN);

    for (const kind of ["desktop", "web"] as const) {
      const items = buildSettingsAttentionItems({
        demo: false,
        isOwner: true,
        drives: [],
        brandLabel, origin: ORIGIN,
        llmConfigured: true,
        update: { kind, behind: true, currentShort: "a", latestShort: "b" },
      });
      expect(items).toEqual([]);
    }
  });

  it("hides update_available from non-owners (multi-user) but keeps per-account items", () => {
    const items = buildSettingsAttentionItems({
      demo: false,
      isOwner: false,
      drives: [{ id: "cs_q", provider: "quark", label: null, status: "frozen" }],
      brandLabel, origin: ORIGIN,
      llmConfigured: false,
      update: {
        kind: "container",
        behind: true,
        currentShort: "aaaaaaa",
        latestShort: "bbbbbbb",
      },
    });
    expect(items.map((i) => i.kind).sort()).toEqual(["frozen_drive", "missing_llm"]);
    expect(items.some((i) => i.kind === "update_available")).toBe(false);
  });

  it("aggregates severity: blocker > warning > info", () => {
    const base = {
      demo: false,
      isOwner: true,
      drives: [] as Array<{ id: string; provider: string; label: string | null; status: "active" | "frozen" }>,
      brandLabel, origin: ORIGIN,
      llmConfigured: true,
      update: null,
    };
    const updateOnly = summarizeSettingsAttention(
      buildSettingsAttentionItems({
        ...base,
        update: { kind: "container", behind: true, currentShort: "1111111", latestShort: "2222222" },
      }),
    );
    expect(updateOnly).toMatchObject({ count: 1, severity: "info" });

    const warningOnly = summarizeSettingsAttention(
      buildSettingsAttentionItems({ ...base, llmConfigured: false }),
    );
    expect(warningOnly).toMatchObject({ count: 1, severity: "warning" });

    const all = summarizeSettingsAttention(
      buildSettingsAttentionItems({
        ...base,
        drives: [{ id: "cs1", provider: "quark", label: null, status: "frozen" }],
        llmConfigured: false,
        update: { kind: "container", behind: true, currentShort: "1111111", latestShort: "2222222" },
      }),
    );
    expect(all.count).toBe(3);
    expect(all.severity).toBe("blocker");

    expect(summarizeSettingsAttention([])).toEqual({ count: 0, severity: null, items: [] });
  });

  it("preserves non-primary workspace on deep-links", () => {
    const items = buildSettingsAttentionItems({
      demo: false,
      isOwner: true,
      drives: [{ id: "cs_q", provider: "quark", label: null, status: "frozen" }],
      brandLabel, origin: ORIGIN,
      llmConfigured: false,
      update: null,
      activeStorageId: "cs_other",
    });
    expect(items.map((i) => i.href)).toEqual([
      "/settings?w=cs_other",
      "/settings?tab=services&w=cs_other",
    ]);
  });
});

describe("parseAttentionTimeMap", () => {
  it("parses a JSON map of id → ISO time, dropping junk", () => {
    const map = parseAttentionTimeMap(
      JSON.stringify({
        "frozen:cs1": "2026-07-01T00:00:00.000Z",
        "update:aaaaaaa": "not-a-date",
        "missing_llm": 42,
        ["x".repeat(200)]: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(map).toEqual({ "frozen:cs1": "2026-07-01T00:00:00.000Z" });
  });

  it("returns {} for null/garbage/non-object JSON", () => {
    expect(parseAttentionTimeMap(null)).toEqual({});
    expect(parseAttentionTimeMap("{oops")).toEqual({});
    expect(parseAttentionTimeMap("[1,2]")).toEqual({});
    expect(parseAttentionTimeMap('"str"')).toEqual({});
  });
});

describe("parseAttentionTimeMap prototype keys", () => {
  it("skips __proto__/constructor/prototype keys without spending the entry budget", () => {
    // 说明：值必须先过 typeof === "string" 才会被赋值，而把字符串赋给
    // __proto__ 是静默 no-op（不会污染原型，实测确认）。真正的毛病是这类键
    // 什么也没存进去，却照样占掉一格上限配额——显式跳过，账目才对得上。
    const raw = JSON.stringify({
      __proto__: "2026-07-01T00:00:00.000Z",
      constructor: "2026-07-01T00:00:00.000Z",
      prototype: "2026-07-01T00:00:00.000Z",
      "frozen:cs1": "2026-07-02T00:00:00.000Z",
    });
    const map = parseAttentionTimeMap(raw);
    expect(Object.keys(map)).toEqual(["frozen:cs1"]);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("isAttentionItemId", () => {
  it("accepts the three known id shapes", () => {
    expect(isAttentionItemId("missing_llm")).toBe(true);
    expect(isAttentionItemId("frozen:cs_abc123")).toBe(true);
    expect(isAttentionItemId("update:aaaaaaa")).toBe(true);
    expect(isAttentionItemId("update:0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  it("rejects everything else (bounded write surface)", () => {
    expect(isAttentionItemId("")).toBe(false);
    expect(isAttentionItemId("update_available")).toBe(false);
    expect(isAttentionItemId("frozen:")).toBe(false);
    expect(isAttentionItemId("update:zzz")).toBe(false);
    expect(isAttentionItemId("../etc/passwd")).toBe(false);
    expect(isAttentionItemId(`frozen:${"x".repeat(65)}`)).toBe(false);
  });
});

describe("applySettingsAttentionState", () => {
  const baseItems = buildSettingsAttentionItems({
    demo: false,
    isOwner: true,
    drives: [{ id: "cs1", provider: "quark", label: null, status: "frozen" }],
    brandLabel, origin: ORIGIN,
    llmConfigured: false,
    update: { kind: "container", behind: true, currentShort: "1111111", latestShort: "2222222" },
  }); // frozen:cs1 (blocker) + missing_llm (warning) + update:2222222 (info)

  const T0 = "2026-07-01T00:00:00.000Z";
  const T1 = "2026-07-02T00:00:00.000Z";
  const T2 = "2026-07-03T00:00:00.000Z";

  it("first sight: stamps every item createdAt=now, persists state_since, counts all (seenAt null)", () => {
    const r = applySettingsAttentionState({
      items: baseItems, stateSince: {}, dismissed: {}, seenAt: null, now: T1,
    });
    expect(r.items.map((i) => [i.id, i.createdAt])).toEqual([
      ["frozen:cs1", T1], ["missing_llm", T1], ["update:2222222", T1],
    ]);
    expect(r.nextStateSince).toEqual({ "frozen:cs1": T1, missing_llm: T1, "update:2222222": T1 });
    expect(r.stateSinceChanged).toBe(true);
    expect(r.count).toBe(3);
    expect(r.severity).toBe("blocker");
  });

  it("keeps existing state_since timestamps (createdAt = first sight, not last render)", () => {
    const r = applySettingsAttentionState({
      items: baseItems,
      stateSince: { "frozen:cs1": T0, missing_llm: T0, "update:2222222": T0 },
      dismissed: {}, seenAt: null, now: T1,
    });
    expect(r.items.every((i) => i.createdAt === T0)).toBe(true);
    expect(r.stateSinceChanged).toBe(false);
  });

  it("drops state_since entries whose state ended (drive unfroze / llm configured / update applied)", () => {
    const r = applySettingsAttentionState({
      items: baseItems.filter((i) => i.id === "missing_llm"),
      stateSince: { "frozen:cs1": T0, missing_llm: T0 },
      dismissed: {}, seenAt: null, now: T1,
    });
    expect(r.nextStateSince).toEqual({ missing_llm: T0 });
    expect(r.stateSinceChanged).toBe(true);
  });

  it("detects a dropped stateSince entry even when its key exists on Object.prototype", () => {
    // toString/valueOf 这类键能被 parseAttentionTimeMap 正常保留（不同于
    // __proto__），而 `key in obj` 会在原型链上找到它们、误判「还在」，
    // 于是 stateSinceChanged 保持 false，这条陈旧记录永远不会被清理落盘。
    const r = applySettingsAttentionState({
      items: baseItems.filter((i) => i.id === "missing_llm"),
      stateSince: { missing_llm: T0, toString: T0, valueOf: T0 },
      dismissed: {}, seenAt: null, now: T1,
    });
    expect(r.stateSinceChanged).toBe(true);
    expect(r.nextStateSince).toEqual({ missing_llm: T0 });
  });

  it("badge count = visible items created AFTER seen_at; seen items stay in the inbox", () => {
    const r = applySettingsAttentionState({
      items: baseItems,
      stateSince: { "frozen:cs1": T0, missing_llm: T2, "update:2222222": T0 },
      dismissed: {}, seenAt: T1, now: T2,
    });
    expect(r.items).toHaveLength(3); // inbox unchanged by seen
    expect(r.count).toBe(1); // only missing_llm (T2 > T1)
    expect(r.severity).toBe("warning");
  });

  it("dismissal hides the item from inbox + count while its occurrence continues", () => {
    const r = applySettingsAttentionState({
      items: baseItems,
      stateSince: { "frozen:cs1": T0, missing_llm: T0, "update:2222222": T0 },
      dismissed: { "frozen:cs1": T1 }, // dismissed AFTER the occurrence began
      seenAt: null, now: T2,
    });
    expect(r.items.map((i) => i.id)).toEqual(["missing_llm", "update:2222222"]);
    expect(r.count).toBe(2);
  });

  it("dismissal does NOT hide a NEW occurrence (state ended → fresh state_since > dismissedAt)", () => {
    const r = applySettingsAttentionState({
      items: baseItems,
      // re-freeze at T2, dismissal of the previous occurrence was at T1
      stateSince: { "frozen:cs1": T2, missing_llm: T0, "update:2222222": T0 },
      dismissed: { "frozen:cs1": T1 },
      seenAt: null, now: T2,
    });
    expect(r.items.map((i) => i.id)).toContain("frozen:cs1");
    expect(r.count).toBe(3);
  });

  it("severity is the worst among counted items only (dismissed/seen don't tint the badge)", () => {
    const r = applySettingsAttentionState({
      items: baseItems,
      stateSince: { "frozen:cs1": T0, missing_llm: T0, "update:2222222": T2 },
      dismissed: { "frozen:cs1": T1, missing_llm: T1 },
      seenAt: null, now: T2,
    });
    expect(r.count).toBe(1);
    expect(r.severity).toBe("info");
  });

  // 时间必须按「瞬时」比较，不能按字符串字典序。parseAttentionTimeMap 的
  // ISO_DATE_RE 没有 $ 锚点、seenAt 只校验 Date.parse 有限，所以带时区偏移的
  // 合法值（手改 DB / 旧写入器）会真的走到比较里。下面两条都用「字典序更小、
  // 实际时间更晚」的 -05:00 偏移串，字典序实现会给出相反结论。
  const T1_MINUS5 = "2026-07-01T20:00:00.000-05:00"; // = 2026-07-02T01:00Z，晚于 T1

  it("dismissal with a timezone-offset timestamp still hides the ongoing occurrence", () => {
    const r = applySettingsAttentionState({
      items: baseItems,
      stateSince: { "frozen:cs1": T1, missing_llm: T0, "update:2222222": T0 },
      dismissed: { "frozen:cs1": T1_MINUS5 }, // 实际晚于 createdAt=T1 → 应隐藏
      seenAt: null, now: T2,
    });
    expect(r.items.map((i) => i.id)).not.toContain("frozen:cs1");
    expect(r.count).toBe(2);
  });

  it("an unparseable seen_at counts everything (never silently zeroes the badge)", () => {
    // 数值比较意味着 Date.parse 会给出 NaN，而任何与 NaN 的比较都是 false ——
    // 若不归一化，一个坏 seen_at 会让徽章整体消失（提醒系统最不能犯的错）。
    const r = applySettingsAttentionState({
      items: baseItems,
      stateSince: { "frozen:cs1": T0, missing_llm: T0, "update:2222222": T0 },
      dismissed: {},
      seenAt: "not-a-date", now: T2,
    });
    expect(r.count).toBe(3);
    expect(r.severity).toBe("blocker");
  });

  it("an unparseable createdAt still counts (visible beats silently suppressed)", () => {
    const r = applySettingsAttentionState({
      items: baseItems.filter((i) => i.id === "missing_llm"),
      stateSince: { missing_llm: "garbage" },
      dismissed: {},
      seenAt: T1, now: T2,
    });
    expect(r.count).toBe(1);
  });

  it("seen_at with a timezone-offset timestamp does not re-count already-seen items", () => {
    const r = applySettingsAttentionState({
      items: baseItems.filter((i) => i.id === "missing_llm"),
      stateSince: { missing_llm: T1 }, // createdAt=T1 早于 seenAt 的真实瞬时
      dismissed: {},
      seenAt: T1_MINUS5, now: T2,
    });
    expect(r.items).toHaveLength(1); // 仍在 inbox 里
    expect(r.count).toBe(0); // 但不再计数
    expect(r.severity).toBe(null);
  });
});
