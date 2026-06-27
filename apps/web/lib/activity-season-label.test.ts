import { describe, expect, it } from "vitest";
import type { EpisodeState } from "@media-track/workflow";
// Import from the PURE module (not activity-view) — this is the client-safe home
// for these helpers, kept free of the Postgres-backed runtime.
import { distinctSeasons, seasonLabelText } from "./activity-season-label";

function episode(seasonNumber: number, episodeNumber: number): EpisodeState {
  return {
    trackedSeasonId: "s",
    episodeCode: `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`,
    airDate: null,
    title: `Episode ${episodeNumber}`,
    airStatus: "aired",
    obtained: false,
    metadataStatus: "confirmed",
    verifiedFileIds: [],
  };
}

describe("distinctSeasons", () => {
  it("returns distinct, sorted season numbers from episode codes", () => {
    const episodes = [episode(1, 1), episode(1, 2), episode(2, 1), episode(3, 1), episode(3, 2)];
    expect(distinctSeasons(episodes)).toEqual([1, 2, 3]);
  });
  it("single season → [n]", () => {
    expect(distinctSeasons([episode(1, 1), episode(1, 2)])).toEqual([1]);
    expect(distinctSeasons([episode(2, 1)])).toEqual([2]);
  });
  it("empty → []", () => {
    expect(distinctSeasons([])).toEqual([]);
  });
  it("sorts numerically (not lexically) and dedupes out-of-order codes", () => {
    expect(distinctSeasons([episode(10, 1), episode(2, 1), episode(2, 2), episode(1, 1)])).toEqual([1, 2, 10]);
  });
});

describe("seasonLabelText", () => {
  it("movie → empty string regardless of seasons", () => {
    expect(seasonLabelText("movie", [1, 2], 1)).toBe("");
  });
  it("no seasons (empty list, null single) → empty string", () => {
    expect(seasonLabelText("tv", [], null)).toBe("");
  });
  it("single season → 第 N 季", () => {
    expect(seasonLabelText("tv", [2], 2)).toBe("第 2 季");
  });
  it("multiple seasons → joined 第 1/2/3/4 季", () => {
    expect(seasonLabelText("tv", [1, 2, 3, 4], 1)).toBe("第 1/2/3/4 季");
  });
  it("falls back to the single seasonNumber when the list is empty", () => {
    expect(seasonLabelText("tv", [], 3)).toBe("第 3 季");
  });
});
