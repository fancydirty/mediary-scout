import { describe, expect, it } from "vitest";
import { AUTO_UPDATE_HOURS, DEFAULT_AUTO_UPDATE_TIME, isAutoUpdateTime, shouldAutoUpdate } from "./auto-update-schedule";

const base = {
  enabled: true,
  time: "04:00",
  now: { date: "2026-10-03", hhmm: "04:05" },
  lastAttemptDate: "2026-10-02",
  available: "v2026.10.02",
  failStreak: null as { tag: string; count: number } | null,
  updater: { phase: "idle" as const },
  updateHoldActive: false,
};

describe("shouldAutoUpdate", () => {
  it("starts after the set time once a day", () => {
    expect(shouldAutoUpdate(base)).toBe(true);
    expect(shouldAutoUpdate({ ...base, lastAttemptDate: "2026-10-03" })).toBe(false);
    expect(shouldAutoUpdate({ ...base, now: { date: "2026-10-03", hhmm: "03:59" } })).toBe(false);
  });

  it("does nothing when off or up to date", () => {
    expect(shouldAutoUpdate({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoUpdate({ ...base, available: null })).toBe(false);
  });

  it("does nothing while the updater is already updating", () => {
    for (const phase of ["waiting", "backing_up", "building", "switching", "verifying"] as const) {
      expect(shouldAutoUpdate({ ...base, updater: { phase } })).toBe(false);
    }
    for (const phase of ["idle", "done", "rolled_back", "failed"] as const) {
      expect(shouldAutoUpdate({ ...base, updater: { phase } })).toBe(true);
    }
  });

  it("does nothing while the updater has a restore pending", () => {
    expect(shouldAutoUpdate({ ...base, updater: { phase: "failed", pendingRestore: true } })).toBe(false);
    expect(shouldAutoUpdate({ ...base, updater: { phase: "failed", pendingRestore: false } })).toBe(true);
  });

  it("does nothing when a failed rollback needs a person", () => {
    expect(shouldAutoUpdate({ ...base, updater: { phase: "failed", needsManualRecovery: true } })).toBe(false);
    expect(shouldAutoUpdate({ ...base, updater: { phase: "failed", needsManualRecovery: false } })).toBe(true);
  });

  it("does nothing when what the deploy folder serves is unknown", () => {
    expect(shouldAutoUpdate({ ...base, updater: { phase: "failed", servingUnknown: true } })).toBe(false);
    expect(shouldAutoUpdate({ ...base, updater: { phase: "failed", servingUnknown: false } })).toBe(true);
  });

  it("does nothing while this web instance holds new tasks for an update", () => {
    expect(shouldAutoUpdate({ ...base, updateHoldActive: true })).toBe(false);
  });

  it("stops after two failures on the same tag, resumes for a newer tag", () => {
    expect(shouldAutoUpdate({ ...base, failStreak: { tag: "v2026.10.02", count: 1 } })).toBe(true);
    expect(shouldAutoUpdate({ ...base, failStreak: { tag: "v2026.10.02", count: 2 } })).toBe(false);
    expect(shouldAutoUpdate({ ...base, failStreak: { tag: "v2026.10.01", count: 2 } })).toBe(true);
  });
});

describe("the auto-update hour", () => {
  it("is a whole hour, 00:00 to 23:00, and 04:00 by default", () => {
    expect(AUTO_UPDATE_HOURS).toHaveLength(24);
    expect(AUTO_UPDATE_HOURS[0]).toBe("00:00");
    expect(AUTO_UPDATE_HOURS[4]).toBe("04:00");
    expect(AUTO_UPDATE_HOURS[23]).toBe("23:00");
    expect(DEFAULT_AUTO_UPDATE_TIME).toBe("04:00");
    for (const hour of AUTO_UPDATE_HOURS) expect(isAutoUpdateTime(hour)).toBe(true);
    for (const bad of ["04:30", "24:00", "4:00", "04:00 ", "", "04", "ab:cd", "99:99"]) {
      expect(isAutoUpdateTime(bad)).toBe(false);
    }
  });
});
