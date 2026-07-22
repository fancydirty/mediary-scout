import { describe, expect, it } from "vitest";
import { buildSettingsAttentionItems, summarizeSettingsAttention } from "./settings-attention";

const brandLabel = (provider: string) =>
  ({ pan115: "115网盘", quark: "夸克网盘", guangya: "光鸭云盘" }[provider] ?? provider);

describe("buildSettingsAttentionItems", () => {
  it("returns empty in demo mode even with problems", () => {
    const items = buildSettingsAttentionItems({
      demo: true,
      drives: [{ id: "cs1", provider: "quark", label: null, status: "frozen" }],
      brandLabel,
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
      drives: [
        { id: "cs_q", provider: "quark", label: null, status: "frozen" },
        { id: "cs_a", provider: "pan115", label: "家里115", status: "active" },
      ],
      brandLabel,
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

  it("flags missing LLM config", () => {
    const items = buildSettingsAttentionItems({
      demo: false,
      drives: [],
      brandLabel,
      llmConfigured: false,
      update: null,
    });
    expect(items.map((i) => i.kind)).toEqual(["missing_llm"]);
    expect(items[0]?.href).toBe("/settings?tab=services");
  });

  it("adds container update with agent prompt, skips desktop/web", () => {
    const container = buildSettingsAttentionItems({
      demo: false,
      drives: [],
      brandLabel,
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
    expect(container[0]?.severity).toBe("warning");
    expect(container[0]?.prompt).toContain("./scripts/deploy.sh");
    expect(container[0]?.prompt).toContain("aaaaaaa");

    for (const kind of ["desktop", "web"] as const) {
      const items = buildSettingsAttentionItems({
        demo: false,
        drives: [],
        brandLabel,
        llmConfigured: true,
        update: { kind, behind: true, currentShort: "a", latestShort: "b" },
      });
      expect(items).toEqual([]);
    }
  });

  it("aggregates severity: any blocker wins", () => {
    const items = buildSettingsAttentionItems({
      demo: false,
      drives: [{ id: "cs1", provider: "quark", label: null, status: "frozen" }],
      brandLabel,
      llmConfigured: true,
      update: {
        kind: "container",
        behind: true,
        currentShort: "1111111",
        latestShort: "2222222",
      },
    });
    const summary = summarizeSettingsAttention(items);
    expect(summary.count).toBe(2);
    expect(summary.severity).toBe("blocker");
  });

  it("warning-only when only update is open", () => {
    const summary = summarizeSettingsAttention(
      buildSettingsAttentionItems({
        demo: false,
        drives: [],
        brandLabel,
        llmConfigured: true,
        update: {
          kind: "container",
          behind: true,
          currentShort: "1111111",
          latestShort: "2222222",
        },
      }),
    );
    expect(summary).toMatchObject({ count: 1, severity: "warning" });
  });

  it("preserves non-primary workspace on deep-links", () => {
    const items = buildSettingsAttentionItems({
      demo: false,
      drives: [{ id: "cs_q", provider: "quark", label: null, status: "frozen" }],
      brandLabel,
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
