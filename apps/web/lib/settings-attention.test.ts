import { describe, expect, it } from "vitest";
import { buildSettingsAttentionItems, summarizeSettingsAttention } from "./settings-attention";

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
