import { describe, expect, it, vi } from "vitest";
import type { MediaTitle, TrackedSeason, WorkflowRun } from "../src/domain.js";
import type { PersistedWorkflowRunSnapshot, PersistWorkflowRunSnapshotInput } from "../src/repository.js";
import { QuarkAuthError } from "../src/quark-cookie-client.js";
import { attachStagingLeaks } from "../src/acquisition-v2/directory-lifecycle.js";
import { handleWorkflowRunFailure } from "../src/worker.js";

const title: MediaTitle = {
  id: "tmdb_movie_1",
  tmdbId: 1,
  type: "movie",
  title: "测试电影",
  originalTitle: "Test",
  year: 2020,
  aliases: [],
};

const season: TrackedSeason = {
  id: "tmdb_movie_1_movie",
  mediaTitleId: "tmdb_movie_1",
  seasonNumber: 1,
  status: "completed",
  qualityPreference: "4K",
  storageDirectoryId: "",
  totalEpisodes: 1,
  latestAiredEpisode: 1,
  latestAiredSource: "manual",
};

function snapshot(run: Partial<WorkflowRun> = {}): PersistedWorkflowRunSnapshot {
  const workflowRun: WorkflowRun = {
    id: "r1",
    kind: "movie_init",
    status: "running",
    trackedSeasonId: "tmdb_movie_1_movie",
    startedAt: "2026-06-21T05:00:00.000Z",
    finishedAt: null,
    auditEvents: [],
    ...run,
  };
  return {
    accountId: "acct_default",
    connectedStorageId: "cs_1",
    title,
    season,
    workflowRun,
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    obtainedEpisodes: [],
    providerAheadEpisodes: [],
  } as PersistedWorkflowRunSnapshot;
}

const now = () => "2026-06-21T05:30:00.000Z";

describe("handleWorkflowRunFailure", () => {
  it("auto-requeues a transient error under the cap (queued + retrying notification)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Cannot connect to API: socket disconnected"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("auto_requeued");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("queued");
    expect(saved.workflowRun.autoRequeueCount).toBe(1);
    expect(saved.workflowRun.nextAttemptAt).toBeDefined();
    expect(saved.notifications[0]?.report?.status).toBe("retrying");
  });

  it("surfaces the real cause in the retry notification (no longer hidden behind 网络波动, issue #196)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("fetch failed: 夸克访问频繁,请稍后再试"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.status).toBe("retrying");
    // 既保留「网络波动·重试」那句,又多一句「原因:…」把真错亮出来。
    expect(report?.lines.some((l) => l.includes("网络波动"))).toBe(true);
    expect(report?.lines.some((l) => l.includes("原因:") && l.includes("夸克访问频繁"))).toBe(true);
  });

  it("redacts secrets from the retry-cause line (never leak a cookie/token into a push)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("fetch failed https://u:sup3rSecretPw@drive.quark.cn/x timeout"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const body = save.mock.calls[0]![0].notifications[0]?.body ?? "";
    expect(body).not.toContain("sup3rSecretPw");
    expect(body).toContain("原因:");
  });

  it("terminally fails a transient error AT the cap (failed + failed notification)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot({ autoRequeueCount: 3 }),
      error: new Error("socket hang up"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.notifications[0]?.report?.status).toBe("failed");
  });

  it("preserves the claimed snapshot's episode bucket across auto-requeue (does NOT wipe it)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const episodes = [
      {
        trackedSeasonId: "tmdb_movie_1_movie",
        episodeCode: "S01E01",
        airDate: null,
        airStatus: "aired" as const,
        obtained: false,
      },
    ];
    const claimed = { ...snapshot(), episodes } as PersistedWorkflowRunSnapshot;
    await handleWorkflowRunFailure({
      claimed,
      error: new Error("read ECONNRESET"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const saved = save.mock.calls[0]![0];
    // Bug (Copilot): saving with episodes:[] deletes the season's reserved bucket
    // (replaceWorkflowRunSnapshot wipes by season then re-inserts) — losing tracked
    // state on a run that is going BACK to queued. Must round-trip claimed.episodes.
    expect(saved.episodes).toHaveLength(1);
    expect(saved.episodes[0]?.episodeCode).toBe("S01E01");
  });

  it("maps an LLM 401 'Unauthorized' failure to actionable guidance in the user-facing message (#49)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Unauthorized"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    expect(out.errorMessage).toContain("AI 模型鉴权失败");
    expect(out.errorMessage).not.toBe("Unauthorized");
    const saved = save.mock.calls[0]![0];
    const body = saved.notifications[0]?.body ?? "";
    expect(body).toContain("设置 → AI 模型");
    expect(body).not.toContain("Unauthorized");
  });

  it("leaves a non-LLM failure message unchanged (no false positive)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("QUARK_TRANSFER_FAILED: dead share"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.errorMessage).toBe("QUARK_TRANSFER_FAILED: dead share");
  });

  it("terminally fails a NON-transient error immediately (count=0)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("agent gave up: no coverage"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.notifications[0]?.report?.status).toBe("failed");
  });

  it("persists staging_leaked audit events carried on the error into the FAILED run (Copilot #260 r1)", async () => {
    // A leak detected by withStagingCleanup on the throw path rides on the error;
    // the failure handler is the only code that persists that run, so it must
    // append the event — otherwise a failed run can leave 1.4 TB behind unseen.
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const error = attachStagingLeaks(new Error("agent gave up: no coverage"), [
      {
        stagingDirectoryId: "stg-77",
        showDirectoryId: "show-7",
        error: new Error("PAN123_TRASH_NOOP: did not act on stg-77"),
      },
    ]);
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    const leak = saved.workflowRun.auditEvents.find((event) => event.type === "staging_leaked");
    expect(leak).toBeDefined();
    // Same shape as the success path (Copilot #260 r2): the show dir rides along so
    // a hand cleanup knows WHERE the leaked staging dir lives.
    expect(leak?.data).toMatchObject({
      stagingDirectoryId: "stg-77",
      showDirectoryId: "show-7",
      cleanupError: expect.stringContaining("PAN123_TRASH_NOOP"),
    });
    // the failure itself is still recorded
    expect(saved.workflowRun.auditEvents.some((event) => event.type === "workflow_failed")).toBe(true);
  });

  it("persists staging_leaked audit events on the REQUEUED run too (transient failure + surviving staging)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const error = attachStagingLeaks(new Error("read ECONNRESET"), [
      { stagingDirectoryId: "stg-78", showDirectoryId: "show-8" },
    ]);
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("auto_requeued");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.auditEvents.some((event) => event.type === "staging_leaked")).toBe(true);
  });

  it("attaching leaks does NOT change the error's identity: a brand auth error still freezes the drive", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async (_storageId: string, _reason: string) => {});
    const error = attachStagingLeaks(new QuarkAuthError("QUARK_AUTH_FAILED: require login"), [
      { stagingDirectoryId: "stg-79", showDirectoryId: "show-9" },
    ]);
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now,
      onAuthErrorFreeze,
    });
    expect(onAuthErrorFreeze).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].workflowRun.auditEvents.some((event) => event.type === "staging_leaked")).toBe(true);
  });

  it("freezes the connected drive once on brand QuarkAuthError", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async (_storageId: string, _reason: string) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new QuarkAuthError("QUARK_AUTH_FAILED: require login"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      onAuthErrorFreeze,
    });
    expect(onAuthErrorFreeze).toHaveBeenCalledTimes(1);
    expect(onAuthErrorFreeze).toHaveBeenCalledWith("cs_1", "QUARK_AUTH_FAILED: require login");
  });

  it("does not freeze on a plain Error (even if message looks auth-like)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async () => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Unauthorized"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      onAuthErrorFreeze,
    });
    expect(onAuthErrorFreeze).not.toHaveBeenCalled();
  });

  it("does not freeze / does not throw when connectedStorageId is null", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async () => {});
    const claimed = { ...snapshot(), connectedStorageId: null };
    await expect(
      handleWorkflowRunFailure({
        claimed,
        error: new QuarkAuthError("QUARK_AUTH_FAILED: require login"),
        repository: { saveWorkflowRunSnapshot: save },
        now,
        onAuthErrorFreeze,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(onAuthErrorFreeze).not.toHaveBeenCalled();
  });
});

describe("handleWorkflowRunFailure — model content-filter before any transfer", () => {
  it("terminal failure naming the model, not a retry and not no-coverage (《出入平安》)", async () => {
    const { AgentContentFilterError } = await import("../src/agent-error.js");
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new AgentContentFilterError(),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    const report = saved.notifications[0]?.report;
    expect(report?.status).toBe("failed");
    expect(report?.lines.join("\n")).toContain("内容审查");
    expect(report?.lines.join("\n")).toContain("不是没有资源");
  });
});

describe("handleWorkflowRunFailure — stdout trail", () => {
  it("logs one secret-safe line per failure (the 出入平安 cause was only recoverable from dead heap tuples)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleWorkflowRunFailure({
        claimed: snapshot(),
        error: new Error("PAN123_REQUEST_FAILED(yun.123pan.com /file/list): TimeoutError token=abcdefghijklmnop"),
        repository: { saveWorkflowRunSnapshot: save },
        now,
      });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.startsWith("[workflow] run r1"));
      expect(line).toBeDefined();
      expect(line).toContain("movie_init");
      expect(line).toContain("auto_requeued");
      expect(line).toContain("yun.123pan.com");
      expect(line).not.toContain("abcdefghijklmnop");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleWorkflowRunFailure — log survives a failing save", () => {
  it("writes the stdout line even when persistence rejects", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const save = vi.fn(async () => { throw new Error("db down"); });
      await expect(
        handleWorkflowRunFailure({ claimed: snapshot(), error: new Error("boom"), repository: { saveWorkflowRunSnapshot: save }, now }),
      ).rejects.toThrow("db down");
      expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("[workflow] run r1") && l.includes("boom"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleWorkflowRunFailure — terminal failure push is redacted", () => {
  it("a non-retried failure never pushes a raw token, but the run row keeps the raw message", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("PAN123_FAILED(/x): code=5 bad cookie=UID_abcdefghijkl"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    const push = [saved.notifications[0]!.body, ...(saved.notifications[0]!.report?.lines ?? [])].join("\n");
    expect(push).not.toContain("UID_abcdefghijkl");
    expect(push).toContain("PAN123_FAILED");
  });
});

describe("summarizeErrorForNotification — bare secret names", () => {
  it("redacts token=/cookie= with no name prefix, and keeps a short harmless value", async () => {
    const { summarizeErrorForNotification } = await import("../src/agent-error.js");
    expect(summarizeErrorForNotification("x token=abcdefghijkl y")).toBe("x token=*** y");
    expect(summarizeErrorForNotification("cookie: UID=12345678_abc")).not.toContain("12345678_abc");
    expect(summarizeErrorForNotification("key=ab")).toBe("key=ab");
  });
});
