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
      "https://assrt.test/fresh/1b",
    ]);
    expect(result.missing).toEqual([]);
  });

  it("reports a pending file missing from a refreshed detail response", () => {
    const initial = indexSubtitleFiles(files("old"));
    const refreshed = indexSubtitleFiles([files("fresh")[0]!, files("fresh")[2]!]);
    const result = selectSubtitleChunk(initial, refreshed, new Set(initial.map((file) => file.key)), 2);
    expect(result.selected).toHaveLength(1);
    expect(result.missing).toEqual(["Show.S01E01.ass#1"]);
  });
});
