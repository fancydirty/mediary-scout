import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import { seedDemoWorkflowRepository } from "./demo-workflow";

async function seededStates() {
  const repo = new InMemoryWorkflowRepository();
  await seedDemoWorkflowRepository(repo);
  const a = await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: "cs_demo_115" });
  const b = await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: "cs_demo_quark" });
  return { a, b, all: [...a, ...b] };
}

describe("seedDemoWorkflowRepository (rich demo library)", () => {
  it("seeds two drives so the switcher shows", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedDemoWorkflowRepository(repo);
    const providers = (await repo.listConnectedStorages("acct_default")).map((d) => d.provider).sort();
    expect(providers).toEqual(["pan115", "quark"]);
  });

  it("seeds a rich wall: >=18 titles spanning movie/tv/anime across both drives", async () => {
    const { a, b, all } = await seededStates();
    const tmdbIds = new Set(all.map((s) => s.title.tmdbId));
    expect(tmdbIds.size).toBeGreaterThanOrEqual(18);
    const types = new Set(all.map((s) => s.title.type));
    expect(types.has("movie")).toBe(true);
    expect(types.has("tv")).toBe(true);
    expect(types.has("anime")).toBe(true);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });

  it("every title carries a real TMDB poster_path", async () => {
    const { all } = await seededStates();
    for (const s of all) {
      expect(s.title.posterPath, `${s.title.title} poster`).toBeTruthy();
      expect(s.title.posterPath!.startsWith("/")).toBe(true);
    }
  });

  it("seeds report-bearing notifications inside the 7-day window (通知 page isn't empty/filtered)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedDemoWorkflowRepository(repo);
    // Mirrors NOTIFICATION_WINDOW_DAYS (=7) / notificationWindowSince() in
    // workflow-runtime.ts. Kept as a literal on purpose: that module is Next
    // server-only (next/headers, pg) and shouldn't be imported into a workflow
    // unit test. The real invariant being guarded is "demo notifs are recent
    // (now-relative), not fixed past dates" — seed max is 52h, far inside 7d, so
    // this stays correct unless the window is cut below ~2 days (implausible).
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await repo.listNotifications({ accountId: "acct_default", since });
    expect(recent.length).toBeGreaterThan(0);
    // Rich L2 cards: report-bearing (status pill + poster), not legacy plain rows.
    expect(recent.some((n) => n.report != null)).toBe(true);
  });

  it("covers reserved / partial / tracking states", async () => {
    const { all } = await seededStates();
    // reserved: a movie with a future release date (复仇者联盟5, 2026-12-16)
    const reserved = all.some((s) => s.title.type === "movie" && (s.title.releaseDate ?? "") >= "2026-07-01");
    expect(reserved, "a reserved (unreleased) movie").toBe(true);
    // partial: a season whose obtained < aired (怪奇物语 / 鬼灭)
    const partial = all.some((s) => {
      const aired = Math.min(s.season.latestAiredEpisode, s.season.totalEpisodes);
      const obtained = s.episodes.filter((e) => e.obtained).length;
      return obtained < aired;
    });
    expect(partial, "a partial (有缺集) season").toBe(true);
    // tracking: an active season (still airing)
    expect(all.some((s) => s.season.status === "active"), "an active (追更中) season").toBe(true);
  });
});
