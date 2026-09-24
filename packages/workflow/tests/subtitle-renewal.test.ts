import { describe, expect, it } from "vitest";
import { indexSubtitleFiles, selectSubtitleChunk } from "../src/acquisition-v2/subtitle-renewal.js";

const files = (suffix: string) => [
  { filename: "Show.S01E01.ass", url: `https://assrt.test/${suffix}/1` },
  { filename: "Show.S01E01.ass", url: `https://assrt.test/${suffix}/1b` },
  { filename: "Show.S01E02.ass", url: `https://assrt.test/${suffix}/2` },
];

describe("subtitle renewal identity", () => {
  it("gives duplicate filenames stable occurrence keys", () => {
    expect(indexSubtitleFiles(files("old")).map((file) => file.key)).toEqual([
      "Show.S01E01.ass#0",
      "Show.S01E01.ass#1",
      "Show.S01E02.ass#0",
    ]);
  });

  it("selects the next pending chunk from a refreshed detail response", () => {
    const initial = indexSubtitleFiles(files("old"));
    const refreshed = indexSubtitleFiles(files("fresh"));
    const result = selectSubtitleChunk(initial, refreshed, new Set(initial.map((file) => file.key)), 2);
    expect(result.selected.map((file) => file.url)).toEqual([
      "https://assrt.test/fresh/1",
      "https://assrt.test/fresh/2",
    ]);
    expect(result.missing).toEqual([]);
  });

  it("reports a pending file missing from a refreshed detail response", () => {
    const initial = indexSubtitleFiles(files("old"));
    const refreshed = indexSubtitleFiles([files("fresh")[0]!, files("fresh")[2]!]);
    const result = selectSubtitleChunk(initial, refreshed, new Set(["Show.S01E01.ass#1"]), 1);
    expect(result.selected).toHaveLength(0);
    expect(result.selected).toEqual([]);
    expect(result.missing).toEqual(["Show.S01E01.ass#1"]);
  });

  it("keeps duplicate filenames in separate adapter calls across a chunk boundary", () => {
    const packageFiles = [
      ...Array.from({ length: 23 }, (_, index) => ({ filename: `Show.S01E${index + 1}.ass`, url: `old/${index}` })),
      { filename: "Show.S01E24.ass", url: "old/24a" },
      { filename: "Show.S01E24.ass", url: "old/24b" },
    ];
    const initial = indexSubtitleFiles(packageFiles);
    const pending = new Set(initial.map((file) => file.key));
    const first = selectSubtitleChunk(initial, initial, pending, 24);
    expect(first.selected).toHaveLength(24);
    expect(first.selected.at(-1)?.filename).toBe("Show.S01E24.ass");
    expect(new Set(first.selected.map((file) => file.filename)).size).toBe(first.selected.length);
    for (const file of first.selected) pending.delete(file.key);
    const second = selectSubtitleChunk(initial, initial, pending, 24);
    expect(second.selected.map((file) => file.filename)).toEqual(["Show.S01E24.ass"]);
  });

  it("keeps hash-containing filenames distinct in their occurrence keys", () => {
    const indexed = indexSubtitleFiles([
      { filename: "a#0", url: "old/a" },
      { filename: "a#0#0", url: "old/b" },
    ]);
    expect(new Set(indexed.map((file) => file.key)).size).toBe(2);
    const refreshed = indexSubtitleFiles([
      { filename: "a#0", url: "fresh/a" },
      { filename: "a#0#0", url: "fresh/b" },
    ]);
    const selected = selectSubtitleChunk(indexed, refreshed, new Set(indexed.map((file) => file.key)), 2);
    expect(selected.selected.map((file) => file.url)).toEqual(["fresh/a", "fresh/b"]);
  });
});
