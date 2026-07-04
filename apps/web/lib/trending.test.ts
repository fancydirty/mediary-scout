import { describe, expect, it } from "vitest";
import { mapTrendingResults } from "./trending";

describe("mapTrendingResults", () => {
  it("maps a movie result (title/release_date/poster_path)", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 27205, title: "盗梦空间", release_date: "2010-07-15", poster_path: "/a.jpg" }] },
      "movie",
    );
    expect(cards).toEqual([
      { tmdbId: 27205, title: "盗梦空间", year: 2010, posterPath: "/a.jpg", mediaType: "movie" },
    ]);
  });

  it("maps a tv/anime result (name/first_air_date) to mediaType tv", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 240411, name: "葬送的芙莉莲", first_air_date: "2023-09-29", poster_path: "/b.jpg" }] },
      "anime",
    );
    expect(cards).toEqual([
      { tmdbId: 240411, title: "葬送的芙莉莲", year: 2023, posterPath: "/b.jpg", mediaType: "tv" },
    ]);
  });

  it("keeps a missing poster_path as null", () => {
    const cards = mapTrendingResults({ results: [{ id: 1, title: "X", release_date: "2020-01-01" }] }, "movie");
    expect(cards[0]!.posterPath).toBeNull();
  });

  it("drops entries with no id or no title, and yields [] on a missing results array", () => {
    expect(mapTrendingResults({ results: [{ title: "no id" }, { id: 2 }] }, "movie")).toEqual([]);
    expect(mapTrendingResults({}, "movie")).toEqual([]);
    expect(mapTrendingResults(null, "movie")).toEqual([]);
  });

  it("null/empty air date → year null", () => {
    const cards = mapTrendingResults({ results: [{ id: 3, title: "Y" }] }, "movie");
    expect(cards[0]!.year).toBeNull();
  });
});
