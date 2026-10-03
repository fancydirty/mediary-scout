import { describe, expect, it } from "vitest";
import { formatBeijingTime } from "./instance-link-time.js";

describe("formatBeijingTime", () => {
  it("renders the request time in Beijing time", () => {
    expect(formatBeijingTime("2026-10-03T12:57:39.585Z")).toBe(
      "2026-10-03 20:57（北京时间）",
    );
  });

  it("uses 00 for midnight instead of 24", () => {
    expect(formatBeijingTime("2026-10-03T16:00:00.000Z")).toBe(
      "2026-10-04 00:00（北京时间）",
    );
  });
});
