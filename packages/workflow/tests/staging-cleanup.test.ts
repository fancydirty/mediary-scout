import { describe, expect, it } from "vitest";
import { withStagingCleanup } from "../src/index.js";

function recordingExecutor(behavior?: () => Promise<void>) {
  const removed: string[] = [];
  return {
    removed,
    executor: {
      async removeDirectory(id: string) {
        removed.push(id);
        if (behavior) await behavior();
        return { removed: true };
      },
    },
  };
}

describe("withStagingCleanup", () => {
  it("removes the run's staging dir after the body succeeds", async () => {
    const { executor, removed } = recordingExecutor();
    const result = await withStagingCleanup(
      { executor, stagingDirectoryId: "stg" },
      async () => "coverage-result",
    );
    expect(result).toBe("coverage-result");
    expect(removed).toEqual(["stg"]);
  });

  it("removes staging EVEN WHEN the body throws — the harness-level leak guard", async () => {
    // This is the 斗破苍穹 fix: the agent reportNoCoverage'd / the loop blew up and
    // never discardStaging'd, leaking 335 files. The finally cleans it regardless.
    const { executor, removed } = recordingExecutor();
    await expect(
      withStagingCleanup({ executor, stagingDirectoryId: "stg" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(removed).toEqual(["stg"]);
  });

  it("is idempotent — a removeDirectory failure (agent already discarded) is swallowed", async () => {
    const { executor } = recordingExecutor(async () => {
      throw new Error("PAN115_DIRECTORY_NOT_FOUND: already gone");
    });
    const result = await withStagingCleanup({ executor, stagingDirectoryId: "stg" }, async () => "ok");
    expect(result).toBe("ok"); // cleanup error must not mask the real result
  });
});

describe("withStagingCleanup leak detection (verify the landing point, don't trust the call)", () => {
  // 2026-09-20 123网盘: file/trash answered code:0 to a string FileId and deleted
  // NOTHING; removeDirectory reported {removed:true}; this finally swallowed the
  // rest. 80 staging dirs / ~1.4 TB accumulated over a month with zero signal.
  // The swallow stays (idempotency), but the cleanup must READ BACK whether the
  // staging dir is still under its parent and report a leak when it is.
  function executorWithParentListing(opts: {
    removeBehavior?: () => Promise<void>;
    childrenAfterCleanup: Array<{ id: string; name: string }>;
  }) {
    const calls: string[] = [];
    return {
      calls,
      executor: {
        async removeDirectory(id: string) {
          calls.push(`remove:${id}`);
          if (opts.removeBehavior) await opts.removeBehavior();
          return { removed: true };
        },
        async listChildDirectories(parentId: string) {
          calls.push(`list:${parentId}`);
          return opts.childrenAfterCleanup;
        },
      },
    };
  }

  it("reports a leak when the staging dir is STILL under its parent after cleanup — even though removeDirectory 'succeeded'", async () => {
    const leaks: Array<{ stagingDirectoryId: string; showDirectoryId: string; error?: unknown }> = [];
    const { executor, calls } = executorWithParentListing({
      childrenAfterCleanup: [{ id: "stg", name: "staging-run1" }],
    });
    const result = await withStagingCleanup(
      { executor, stagingDirectoryId: "stg", parentDirectoryId: "show", onLeak: (leak) => leaks.push(leak) },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(calls).toEqual(["remove:stg", "list:show"]);
    // The leak names its parent too: a user cleaning up by hand needs the show dir,
    // and the failure persist path has no `directories` object to look it up from.
    expect(leaks).toEqual([{ stagingDirectoryId: "stg", showDirectoryId: "show", error: undefined }]);
  });

  it("carries the removeDirectory error into the leak report when the dir survived a throwing cleanup", async () => {
    const leaks: Array<{ stagingDirectoryId: string; showDirectoryId: string; error?: unknown }> = [];
    const { executor } = executorWithParentListing({
      removeBehavior: async () => {
        throw new Error("PAN123_TRASH_NOOP: file/trash answered code:0 but did not act on stg");
      },
      childrenAfterCleanup: [{ id: "stg", name: "staging-run1" }],
    });
    await withStagingCleanup(
      { executor, stagingDirectoryId: "stg", parentDirectoryId: "show", onLeak: (leak) => leaks.push(leak) },
      async () => "ok",
    );
    expect(leaks).toHaveLength(1);
    expect(String(leaks[0]?.error)).toContain("PAN123_TRASH_NOOP");
  });

  it("does NOT report a leak when the dir is gone (agent already discarded → cleanup threw 'not found' → read-back confirms gone)", async () => {
    const leaks: unknown[] = [];
    const { executor } = executorWithParentListing({
      removeBehavior: async () => {
        throw new Error("PAN115_DIRECTORY_NOT_FOUND: already gone");
      },
      childrenAfterCleanup: [{ id: "season1", name: "Season 01" }],
    });
    const result = await withStagingCleanup(
      { executor, stagingDirectoryId: "stg", parentDirectoryId: "show", onLeak: (leak) => leaks.push(leak) },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(leaks).toEqual([]);
  });

  it("still returns the body's result when the read-back listing itself fails (never mask the real outcome)", async () => {
    const leaks: unknown[] = [];
    const executor = {
      async removeDirectory() {
        return { removed: true };
      },
      async listChildDirectories() {
        throw new Error("network down");
      },
    };
    const result = await withStagingCleanup(
      { executor, stagingDirectoryId: "stg", parentDirectoryId: "show", onLeak: (leak) => leaks.push(leak) },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(leaks).toEqual([]);
  });

  it("keeps the legacy no-parent form: no read-back, no leak report, still swallows", async () => {
    const { executor, calls } = executorWithParentListing({
      removeBehavior: async () => {
        throw new Error("whatever");
      },
      childrenAfterCleanup: [{ id: "stg", name: "staging-run1" }],
    });
    const result = await withStagingCleanup({ executor, stagingDirectoryId: "stg" }, async () => "ok");
    expect(result).toBe("ok");
    expect(calls).toEqual(["remove:stg"]);
  });
});
