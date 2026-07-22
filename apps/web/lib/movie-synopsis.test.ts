import { describe, expect, it } from "vitest";
import {
  MOVIE_SYNOPSIS_COLLAPSE_AT,
  collapseMovieSynopsis,
  shouldCollapseMovieSynopsis,
} from "./movie-synopsis";

describe("movie synopsis collapse", () => {
  it("keeps short text fully expanded", () => {
    expect(shouldCollapseMovieSynopsis("短简介")).toBe(false);
    expect(collapseMovieSynopsis("短简介")).toBe("短简介");
  });

  it("collapses long text at the threshold", () => {
    const long = "字".repeat(MOVIE_SYNOPSIS_COLLAPSE_AT + 20);
    expect(shouldCollapseMovieSynopsis(long)).toBe(true);
    const collapsed = collapseMovieSynopsis(long);
    expect(collapsed.endsWith("…")).toBe(true);
    expect(collapsed.length).toBe(MOVIE_SYNOPSIS_COLLAPSE_AT + 1);
  });
});
