import { describe, expect, it } from "vitest";
import { trimToMinimalCoveringCandidates } from "./minimal-cover.js";

function cand(id: string, episodes: string[]) {
  return { id, episodes };
}

describe("trimToMinimalCoveringCandidates", () => {
  it("keeps a single complete pack and drops redundant complete packs", () => {
    // The 链锯人 failure: ~11 overlapping complete packs for one 12-ep season.
    const all = Array.from({ length: 11 }, (_, i) =>
      cand(`pack-${i}`, ["S01E01", "S01E02", "S01E03", "S01E04"]),
    );
    const kept = trimToMinimalCoveringCandidates(all);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe("pack-0");
  });

  it("keeps the fewest packs needed to cover overlapping ranges", () => {
    const all = [
      cand("a", ["S01E01", "S01E02", "S01E03"]),
      cand("b", ["S01E02", "S01E03", "S01E04"]), // redundant once a+c chosen
      cand("c", ["S01E04", "S01E05", "S01E06"]),
    ];
    const kept = trimToMinimalCoveringCandidates(all);
    const coveredIds = kept.map((c) => c.id).sort();
    // a (1-3) + c (4-6) cover everything; b is redundant.
    expect(coveredIds).toEqual(["a", "c"]);
  });

  it("keeps all disjoint packs (each adds unique coverage)", () => {
    const all = [
      cand("a", ["S01E01", "S01E02"]),
      cand("b", ["S01E03", "S01E04"]),
      cand("c", ["S01E05", "S01E06"]),
    ];
    expect(trimToMinimalCoveringCandidates(all)).toHaveLength(3);
  });

  it("drops a candidate whose episodes are all already covered", () => {
    const all = [
      cand("full", ["S01E01", "S01E02", "S01E03"]),
      cand("subset", ["S01E02"]),
    ];
    const kept = trimToMinimalCoveringCandidates(all);
    expect(kept.map((c) => c.id)).toEqual(["full"]);
  });

  it("preserves the agent's original ordering among kept candidates", () => {
    const all = [
      cand("first", ["S01E05", "S01E06"]),
      cand("second", ["S01E01", "S01E02", "S01E03", "S01E04"]),
    ];
    // Greedy picks "second" first (more coverage) but output stays in input order.
    expect(trimToMinimalCoveringCandidates(all).map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("returns empty for empty input", () => {
    expect(trimToMinimalCoveringCandidates([])).toEqual([]);
  });

  it("includes provider-ahead episodes in the covered union (no 资源超前 loss)", () => {
    // One pack covers aired 1-12 plus the un-aired ahead ep 13; nothing redundant.
    const all = [cand("pack", ["S01E01", "S01E12", "S01E13"])];
    expect(trimToMinimalCoveringCandidates(all)).toHaveLength(1);
  });
});
