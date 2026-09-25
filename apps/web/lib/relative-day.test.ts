import { describe, expect, it } from "vitest";
import { relativeDayLabel } from "./relative-day";

describe("relativeDayLabel (China time)", () => {
  const now = "2026-09-25T04:00:00.000Z"; // 12:00 CST
  it("today shows the time, then 昨天 / N 天前 / a date", () => {
    expect(relativeDayLabel("2026-09-24T22:03:00.000Z", now)).toBe("今天 06:03");
    expect(relativeDayLabel("2026-09-24T03:00:00.000Z", now)).toBe("昨天");
    expect(relativeDayLabel("2026-09-22T03:00:00.000Z", now)).toBe("3 天前");
    expect(relativeDayLabel("2026-09-02T03:00:00.000Z", now)).toBe("9月2日");
  });
  it("a UTC date that is already tomorrow in China counts by China day", () => {
    // 15:30Z = 23:30 CST on the 24th; at 15:50Z it is still the 24th in China …
    expect(relativeDayLabel("2026-09-24T15:30:00.000Z", "2026-09-24T15:50:00.000Z")).toBe("今天 23:30");
    // … and at 16:30Z (00:30 CST on the 25th) it is yesterday, though UTC still says the 24th.
    expect(relativeDayLabel("2026-09-24T15:30:00.000Z", "2026-09-24T16:30:00.000Z")).toBe("昨天");
  });
  it("garbage in → empty", () => {
    expect(relativeDayLabel("nope", now)).toBe("");
  });
});
