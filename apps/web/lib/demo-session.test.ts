import { describe, expect, it } from "vitest";
import {
  listDemoAcquisitions,
  recordDemoAcquisition,
  demoCompletedItems,
  type DemoAcquisitionEntry,
  startDemoInProgress,
  listDemoInProgress,
  clearDemoInProgress,
  demoInProgressView,
  demoInProgressLibraryCards,
  demoInProgressActivityItems,
  demoSessionNotifications,
  type DemoInProgressEntry,
  type DemoInProgressActive,
} from "./demo-session";
import { DEMO_PLAYBACK_TOTAL_MS } from "./demo-playback-timeline";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

const entry = (tmdbId: number, title = `T${tmdbId}`): DemoAcquisitionEntry => ({
  tmdbId,
  title,
  year: 2020,
  type: "movie",
  posterPath: "/p.jpg",
});

describe("demo-session", () => {
  it("records then lists the entry", () => {
    const s = fakeStorage();
    recordDemoAcquisition(entry(1), s);
    expect(listDemoAcquisitions(s).map((e) => e.tmdbId)).toEqual([1]);
  });

  it("dedups by tmdbId and moves the re-recorded one to the front", () => {
    const s = fakeStorage();
    recordDemoAcquisition(entry(1), s);
    recordDemoAcquisition(entry(2), s);
    recordDemoAcquisition(entry(1, "again"), s);
    const list = listDemoAcquisitions(s);
    expect(list.map((e) => e.tmdbId)).toEqual([1, 2]);
    expect(list[0]!.title).toBe("again");
  });

  it("caps at 20 (newest first)", () => {
    const s = fakeStorage();
    for (let i = 1; i <= 25; i++) recordDemoAcquisition(entry(i), s);
    const list = listDemoAcquisitions(s);
    expect(list).toHaveLength(20);
    expect(list[0]!.tmdbId).toBe(25);
  });

  it("malformed / non-array JSON → empty list", () => {
    expect(listDemoAcquisitions(fakeStorage({ "mediary-demo-acquired": "not json" }))).toEqual([]);
    expect(listDemoAcquisitions(fakeStorage({ "mediary-demo-acquired": '{"a":1}' }))).toEqual([]);
  });

  it("drops entries with the wrong shape", () => {
    const bad = JSON.stringify([{ tmdbId: "x" }, entry(7)]);
    expect(listDemoAcquisitions(fakeStorage({ "mediary-demo-acquired": bad })).map((e) => e.tmdbId)).toEqual([7]);
  });

  it("null storage (SSR) → empty list, record is a no-op (no throw)", () => {
    expect(listDemoAcquisitions(null)).toEqual([]);
    expect(() => recordDemoAcquisition(entry(1), null)).not.toThrow();
  });
});

describe("demoCompletedItems", () => {
  it("empty → []", () => {
    expect(demoCompletedItems([])).toEqual([]);
  });
  it("maps entries to completed activity items (status complete, demo runId)", () => {
    const items = demoCompletedItems([
      { tmdbId: 27205, title: "盗梦空间", year: 2010, type: "movie", posterPath: "/p.jpg" },
    ]);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.workflowRunId).toBe("demo-27205");
    expect(it0.title).toBe("盗梦空间");
    expect(it0.status).toBe("complete");
    expect(it0.posterPath).toBe("/p.jpg");
    expect(it0.seasonLabel).toBeNull();
    expect(it0.sizeText).toBeNull();
    expect(typeof it0.createdAt).toBe("string");
  });
});

describe("demo in-progress overlay", () => {
  const ip = (tmdbId: number, startedAt: number): DemoInProgressEntry => ({
    tmdbId,
    title: `T${tmdbId}`,
    year: 2026,
    type: "tv",
    posterPath: "/p.jpg",
    startedAt,
  });

  it("records, lists, dedups by tmdbId (replace, front), clears", () => {
    const s = fakeStorage();
    startDemoInProgress(ip(1, 1000), s);
    startDemoInProgress(ip(2, 1500), s);
    startDemoInProgress({ ...ip(1, 2000) }, s); // same tmdbId → replace, move front
    const list = listDemoInProgress(s);
    expect(list.map((e) => e.tmdbId)).toEqual([1, 2]);
    expect(list[0]!.startedAt).toBe(2000);
    clearDemoInProgress(1, s);
    expect(listDemoInProgress(s).map((e) => e.tmdbId)).toEqual([2]);
  });

  it("null storage (SSR) → empty list, no throw", () => {
    expect(listDemoInProgress(null)).toEqual([]);
    expect(() => startDemoInProgress(ip(1, 0), null)).not.toThrow();
    expect(() => clearDemoInProgress(1, null)).not.toThrow();
  });

  it("drops wrong-shape entries", () => {
    const bad = JSON.stringify([{ tmdbId: "x", startedAt: 1 }, ip(7, 0)]);
    expect(
      listDemoInProgress(fakeStorage({ "mediary-demo-inprogress": bad })).map((e) => e.tmdbId),
    ).toEqual([7]);
  });

  it("rejects non-finite startedAt (corruption guard → never stuck 获取中)", () => {
    const raw = JSON.stringify([
      { tmdbId: 1, title: "A", year: 2026, type: "tv", posterPath: null, startedAt: "x" },
      { tmdbId: 7, title: "B", year: 2026, type: "tv", posterPath: null, startedAt: 5 },
    ]);
    expect(
      listDemoInProgress(fakeStorage({ "mediary-demo-inprogress": raw })).map((e) => e.tmdbId),
    ).toEqual([7]);
  });

  it("caps at 20 (newest first) — no unbounded growth", () => {
    const s = fakeStorage();
    for (let i = 1; i <= 25; i++) startDemoInProgress(ip(i, i), s);
    const list = listDemoInProgress(s);
    expect(list).toHaveLength(20);
    expect(list[0]!.tmdbId).toBe(25);
  });
});

describe("demoInProgressView", () => {
  const base = { tmdbId: 1, title: "A", year: 2026, type: "tv" as const, posterPath: null };

  it("splits active vs done by the clock", () => {
    const started = { ...base, startedAt: 0 };
    const mid = demoInProgressView([started], Math.floor(DEMO_PLAYBACK_TOTAL_MS / 2));
    expect(mid.done).toEqual([]);
    expect(mid.active).toHaveLength(1);
    expect(mid.active[0]!.progress).toBeGreaterThan(0);
    expect(mid.active[0]!.progress).toBeLessThanOrEqual(100);
    expect(typeof mid.active[0]!.step).toBe("string");
    expect(mid.active[0]!.step.length).toBeGreaterThan(0);

    const after = demoInProgressView([started], DEMO_PLAYBACK_TOTAL_MS + 10);
    expect(after.active).toEqual([]);
    expect(after.done).toEqual([started]);
  });

  it("clamps negative elapsed (clock skew) to the first step, never crashes", () => {
    const future = { ...base, startedAt: 100 };
    const view = demoInProgressView([future], 0); // now < startedAt
    expect(view.active).toHaveLength(1);
    expect(view.active[0]!.progress).toBeGreaterThan(0);
  });
});

describe("demo in-progress view mappers", () => {
  const active: DemoInProgressActive[] = [
    {
      tmdbId: 7,
      title: "X",
      year: 2026,
      type: "anime",
      posterPath: "/p.jpg",
      startedAt: 0,
      progress: 40,
      step: "转存到网盘…",
    },
  ];

  it("maps active entries to library 获取中 cards", () => {
    expect(demoInProgressLibraryCards(active)).toEqual([
      { tmdbId: 7, title: "X", year: 2026, type: "anime", posterPath: "/p.jpg", acquiring: true },
    ]);
  });

  it("maps active entries to activity 获取中 items with progress", () => {
    const items = demoInProgressActivityItems(active);
    expect(items[0]!.id).toBe("demo-inprogress-7");
    expect(items[0]!.title).toBe("X");
    expect(items[0]!.progress).toBe(40);
    expect(items[0]!.step).toBe("转存到网盘…");
    expect(items[0]!.posterPath).toBe("/p.jpg");
  });
});

describe("demoSessionNotifications", () => {
  it("maps completed demo acquisitions to session notification cards (newest first by acquiredAt)", () => {
    const n = demoSessionNotifications([
      { tmdbId: 7, title: "X", year: 2026, type: "movie", posterPath: "/p.jpg", acquiredAt: 2000 },
      { tmdbId: 8, title: "Y", year: 2025, type: "tv", posterPath: null, acquiredAt: 3000 },
    ]);
    expect(n).toHaveLength(2);
    expect(n[0]!.tmdbId).toBe(8); // newest acquiredAt first
    expect(n[0]!.kind).toBe("acquired");
    expect(n[0]!.id).toBe("demo-notif-8");
    expect(n[1]!.title).toBe("X");
    // createdAt is an ISO string derived from acquiredAt so the seen-marker can diff it.
    expect(typeof n[0]!.createdAt).toBe("string");
    expect(new Date(n[0]!.createdAt).toISOString()).toBe(n[0]!.createdAt);
  });

  it("entries without acquiredAt still render (stable fallback createdAt)", () => {
    const n = demoSessionNotifications([{ tmdbId: 9, title: "Z", year: 2024, type: "movie", posterPath: null }]);
    expect(n).toHaveLength(1);
    expect(typeof n[0]!.createdAt).toBe("string");
  });

  it("tolerates corrupted acquiredAt (NaN/string) without throwing", () => {
    const corrupted = [
      { tmdbId: 1, title: "A", year: 2026, type: "movie", posterPath: null, acquiredAt: NaN },
      { tmdbId: 2, title: "B", year: 2026, type: "tv", posterPath: null, acquiredAt: "oops" },
    ] as unknown as DemoAcquisitionEntry[];
    let out!: ReturnType<typeof demoSessionNotifications>;
    expect(() => {
      out = demoSessionNotifications(corrupted);
    }).not.toThrow();
    expect(out).toHaveLength(2);
    for (const n of out) {
      // createdAt must be a real ISO string (fallback), never "Invalid Date".
      expect(new Date(n.createdAt).toISOString()).toBe(n.createdAt);
    }
  });
});

describe("recordDemoAcquisition acquiredAt stability", () => {
  it("preserves the first acquiredAt across a second (no-arg) record of the same tmdbId", () => {
    const s = fakeStorage();
    recordDemoAcquisition({ tmdbId: 5, title: "A", year: 2026, type: "movie", posterPath: null, acquiredAt: 1000 }, s);
    // Second promotion (e.g. hook tick) for the same title, no acquiredAt → must
    // NOT re-stamp, or the 通知 NEW/unread diff would jump forward and the badge
    // would wrongly reappear after the user already saw it.
    recordDemoAcquisition({ tmdbId: 5, title: "A", year: 2026, type: "movie", posterPath: null }, s);
    const list = listDemoAcquisitions(s);
    expect(list).toHaveLength(1);
    expect(list[0]!.acquiredAt).toBe(1000);
  });

  it("does NOT preserve a corrupted existing acquiredAt — re-stamps a finite value", () => {
    const raw = JSON.stringify([
      { tmdbId: 5, title: "A", year: 2026, type: "movie", posterPath: null, acquiredAt: "bad" },
    ]);
    const s = fakeStorage({ "mediary-demo-acquired": raw });
    recordDemoAcquisition({ tmdbId: 5, title: "A", year: 2026, type: "movie", posterPath: null }, s);
    const list = listDemoAcquisitions(s);
    expect(list).toHaveLength(1);
    expect(Number.isFinite(list[0]!.acquiredAt)).toBe(true);
  });
});
