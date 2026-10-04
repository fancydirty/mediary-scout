import { describe, it, expect, afterEach } from "vitest";
import {
  DuplicateUsernameError,
  type ReserveWorkflowRunInput,
  type TrackedSeasonState,
  type WorkflowRepository,
} from "../src/repository.js";
import type { Account } from "../src/account-credentials.js";
import type { TransferAttempt } from "../src/domain.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";
import { queueReplaceRequest } from "../src/replace-request.js";
import { handleWorkflowRunFailure } from "../src/worker.js";

/** A factory that yields a FRESH, empty repository and a teardown. Postgres/SQLite
 *  return async; InMemory is sync — accept both. */
export interface RepoHarness {
  make: () => Promise<WorkflowRepository> | WorkflowRepository;
  teardown?: (repo: WorkflowRepository) => Promise<void> | void;
}

export function runRepositoryContract(name: string, harness: RepoHarness): void {
  describe(`WorkflowRepository contract: ${name}`, () => {
    // Track every repository a test opened and tear it down afterwards, so SQLite
    // file handles / future engine pools don't leak across the (many) contract tests.
    const opened: WorkflowRepository[] = [];
    afterEach(async () => {
      for (const repo of opened.splice(0)) {
        await harness.teardown?.(repo);
      }
    });
    async function fresh(): Promise<WorkflowRepository> {
      const repo = await harness.make();
      opened.push(repo);
      return repo;
    }

    describe("settings", () => {
      it("round-trips an instance setting and returns null for unknown keys", async () => {
        const repo = await fresh();
        expect(await repo.getSetting("missing")).toBeNull();
        await repo.setSetting("daily_sweep_time", "06:00");
        expect(await repo.getSetting("daily_sweep_time")).toBe("06:00");
        await repo.setSetting("daily_sweep_time", "07:30"); // upsert overwrites
        expect(await repo.getSetting("daily_sweep_time")).toBe("07:30");
      });

      it("deleteSetting removes a key and is a no-op for unknown keys", async () => {
        const repo = await fresh();
        await repo.setSetting("pan115.cookie", "UID=1;CID=2");
        await repo.deleteSetting("pan115.cookie");
        expect(await repo.getSetting("pan115.cookie")).toBeNull();
        await repo.deleteSetting("pan115.cookie"); // no-op
        expect(await repo.getSetting("pan115.cookie")).toBeNull();
      });

      it("scopes account settings per account", async () => {
        const repo = await fresh();
        await repo.setAccountSetting("acct_a", "llm_key", "A");
        await repo.setAccountSetting("acct_b", "llm_key", "B");
        expect(await repo.getAccountSetting("acct_a", "llm_key")).toBe("A");
        expect(await repo.getAccountSetting("acct_b", "llm_key")).toBe("B");
        expect(await repo.getAccountSetting("acct_a", "missing")).toBeNull();
      });
    });

    describe("user requests", () => {
      const scope = { accountId: "acct_a", drive: "cs_1", titleKey: "tmdb_tv_1" };
      const t0 = "2026-09-26T00:00:00.000Z";
      const t1 = "2026-09-26T00:01:00.000Z";

      it("creates, lists newest-first, edits and withdraws only while pending", async () => {
        const repo = await fresh();
        const a = await repo.createUserMessage({ ...scope, body: "E13 发蓝", episodeTags: ["S01E13"], now: t0 });
        const b = await repo.createUserMessage({ ...scope, body: "E24 也是", episodeTags: [], now: t1 });
        expect((await repo.listUserMessages(scope)).map((m) => m.id)).toEqual([b.id, a.id]);
        expect(a).toMatchObject({ status: "pending", urgent: false, episodeTags: ["S01E13"], runId: null, reply: null });

        const edited = await repo.editUserMessage({ accountId: "acct_a", id: a.id, body: "E13 偏蓝", episodeTags: ["S01E13", "S01E14"], now: t1 });
        expect(edited).toMatchObject({ body: "E13 偏蓝", episodeTags: ["S01E13", "S01E14"], updatedAt: t1 });
        expect(await repo.withdrawUserMessage({ accountId: "acct_a", id: b.id, now: t1 })).toBe(true);
        expect((await repo.listUserMessages(scope)).map((m) => m.id)).toEqual([a.id]);

        await repo.claimUserMessages({ ...scope, runId: "run_1", now: t1 });
        expect(await repo.editUserMessage({ accountId: "acct_a", id: a.id, body: "x", episodeTags: [], now: t1 })).toBeNull();
        expect(await repo.withdrawUserMessage({ accountId: "acct_a", id: a.id, now: t1 })).toBe(false);
      });

      it("never lets another account touch a message", async () => {
        const repo = await fresh();
        const a = await repo.createUserMessage({ ...scope, body: "hi", episodeTags: [], now: t0 });
        expect(await repo.editUserMessage({ accountId: "acct_b", id: a.id, body: "x", episodeTags: [], now: t1 })).toBeNull();
        expect(await repo.withdrawUserMessage({ accountId: "acct_b", id: a.id, now: t1 })).toBe(false);
        expect(await repo.listUserMessages({ ...scope, accountId: "acct_b" })).toEqual([]);
        const [still] = await repo.listUserMessages(scope);
        expect(still).toMatchObject({ id: a.id, body: "hi", status: "pending", updatedAt: t0 });
      });

      it("isolates drives: urgency, claims and pending replacements never cross drives", async () => {
        const repo = await fresh();
        const other = { ...scope, drive: "cs_2" };
        await repo.createUserMessage({ ...scope, body: "on cs_1", episodeTags: [], now: t0 });
        await repo.claimUserMessages({ ...scope, runId: "run_1", now: t0 });
        const onOther = await repo.createUserMessage({ ...other, body: "on cs_2", episodeTags: [], now: t1 });
        expect(onOther.urgent).toBe(false);
        expect(await repo.claimUserMessages({ ...scope, runId: "run_2", now: t1 })).toEqual([]);
        expect((await repo.listUserMessages(other)).map((m) => [m.id, m.status])).toEqual([[onOther.id, "pending"]]);

        await repo.addPendingReplacements({ ...scope, episodes: ["S01E13"], messageId: "m1", now: t0 });
        expect(await repo.listPendingReplacements(other)).toEqual([]);
        expect(await repo.removePendingReplacements({ ...other, episodes: ["S01E13"] })).toBe(0);
        expect((await repo.listPendingReplacements(scope)).map((p) => p.episode)).toEqual(["S01E13"]);
      });

      it("does not claim a withdrawn message", async () => {
        const repo = await fresh();
        const a = await repo.createUserMessage({ ...scope, body: "gone", episodeTags: [], now: t0 });
        const b = await repo.createUserMessage({ ...scope, body: "kept", episodeTags: [], now: t1 });
        expect(await repo.withdrawUserMessage({ accountId: "acct_a", id: a.id, now: t1 })).toBe(true);
        expect((await repo.claimUserMessages({ ...scope, runId: "run_1", now: t1 })).map((m) => m.id)).toEqual([b.id]);
      });

      it("finish/release only touch their own run; release after finish keeps done", async () => {
        const repo = await fresh();
        const a = await repo.createUserMessage({ ...scope, body: "a", episodeTags: [], now: t0 });
        const b = await repo.createUserMessage({ ...scope, titleKey: "tmdb_tv_2", body: "b", episodeTags: [], now: t0 });
        await repo.claimUserMessages({ ...scope, runId: "run_1", now: t0 });
        await repo.claimUserMessages({ ...scope, titleKey: "tmdb_tv_2", runId: "run_2", now: t0 });
        const reply = { results: [], oldFiles: [], runId: "run_x" };

        await repo.finishUserMessages({ runId: "run_other", reply, now: t1 });
        await repo.releaseUserMessages({ runId: "run_other", now: t1 });
        expect((await repo.listUserMessages(scope))[0]).toMatchObject({ id: a.id, status: "processing", runId: "run_1", reply: null });

        await repo.finishUserMessages({ runId: "run_1", reply: { ...reply, runId: "run_1" }, now: t1 });
        await repo.releaseUserMessages({ runId: "run_1", now: t1 });
        expect((await repo.listUserMessages(scope))[0]).toMatchObject({ id: a.id, status: "done", runId: "run_1", urgent: false, processedAt: t1 });
        expect((await repo.listUserMessages({ ...scope, titleKey: "tmdb_tv_2" }))[0]).toMatchObject({
          id: b.id, status: "processing", runId: "run_2", reply: null, processedAt: null,
        });
      });

      it("a message written while another is processing is urgent; claim takes only what is pending", async () => {
        const repo = await fresh();
        const a = await repo.createUserMessage({ ...scope, body: "first", episodeTags: [], now: t0 });
        const claimed = await repo.claimUserMessages({ ...scope, runId: "run_1", now: t0 });
        expect(claimed.map((m) => m.id)).toEqual([a.id]);
        expect(claimed[0]).toMatchObject({ status: "processing", runId: "run_1" });
        const b = await repo.createUserMessage({ ...scope, body: "second", episodeTags: [], now: t1 });
        expect(b.urgent).toBe(true);
        expect(await repo.claimUserMessages({ ...scope, runId: "run_2", now: t1 })).toHaveLength(1);
        expect(await repo.claimUserMessages({ ...scope, runId: "run_3", now: t1 })).toHaveLength(0);
      });

      it("finish writes the reply; release puts processing back to pending+urgent", async () => {
        const repo = await fresh();
        await repo.createUserMessage({ ...scope, body: "a", episodeTags: [], now: t0 });
        await repo.claimUserMessages({ ...scope, runId: "run_1", now: t0 });
        await repo.releaseUserMessages({ runId: "run_1", now: t1 });
        let [m] = await repo.listUserMessages(scope);
        expect(m).toMatchObject({ status: "pending", urgent: true, runId: null });
        await repo.claimUserMessages({ ...scope, runId: "run_1b", now: t1 });
        await repo.releaseUserMessages({ runId: "run_1b", now: t1, urgent: false });
        [m] = await repo.listUserMessages(scope);
        expect(m).toMatchObject({ status: "pending", urgent: false, runId: null });

        await repo.claimUserMessages({ ...scope, runId: "run_2", now: t1 });
        const reply = { results: [{ episode: "S01E13", outcome: "replaced" as const, label: "x", sizeBytes: 1, note: "ok" }], oldFiles: ["Season 01/a.mkv"], runId: "run_2" };
        await repo.finishUserMessages({ runId: "run_2", reply, now: t1 });
        [m] = await repo.listUserMessages(scope);
        expect(m).toMatchObject({ status: "done", processedAt: t1, reply });
      });

      it("claim is idempotent per run: the same run gets its processing messages back, another run does not", async () => {
        const repo = await fresh();
        const a = await repo.createUserMessage({ ...scope, body: "a", episodeTags: [], now: t0 });
        expect((await repo.claimUserMessages({ ...scope, runId: "run_1", now: t0 })).map((m) => m.id)).toEqual([a.id]);
        const b = await repo.createUserMessage({ ...scope, body: "b", episodeTags: [], now: t1 });
        // The crashed-and-requeued run_1 re-claims a (still its own) and the new pending b.
        const again = await repo.claimUserMessages({ ...scope, runId: "run_1", now: t1 });
        expect(again.map((m) => [m.id, m.status, m.runId])).toEqual([[a.id, "processing", "run_1"], [b.id, "processing", "run_1"]]);
        expect(await repo.claimUserMessages({ ...scope, runId: "run_2", now: t1 })).toEqual([]);
        expect(await repo.listWorksWithProcessingMessages()).toEqual([scope]);
      });

      it("releaseOrphanedUserMessages releases processing messages whose run is gone or finished, keeps live ones", async () => {
        const repo = await fresh();
        const base = workflowPersistenceFixture();
        const run = (id: string, status: "queued" | "running" | "failed", seasonId: string) => ({
          ...base,
          accountId: "acct_a",
          connectedStorageId: "cs_1",
          season: { ...base.season, id: seasonId },
          workflowRun: { ...base.workflowRun, id, kind: "replace_request" as const, status, trackedSeasonId: seasonId, finishedAt: status === "failed" ? t0 : null },
          episodes: [],
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });
        await repo.saveWorkflowRunSnapshot(run("run_live", "running", "season_live"));
        await repo.saveWorkflowRunSnapshot(run("run_dead", "failed", "season_dead"));
        // Just saved its final status; its bookkeeping (finishUserMessages) is still to come.
        const fresh_ = run("run_just_done", "failed", "season_just");
        await repo.saveWorkflowRunSnapshot({ ...fresh_, workflowRun: { ...fresh_.workflowRun, finishedAt: t1 } });
        const works = ["tmdb_tv_live", "tmdb_tv_just", "tmdb_tv_dead", "tmdb_tv_gone"].map((titleKey) => ({ ...scope, titleKey }));
        for (const work of works) await repo.createUserMessage({ ...work, body: "x", episodeTags: [], now: t0 });
        await repo.claimUserMessages({ ...works[0]!, runId: "run_live", now: t0 });
        await repo.claimUserMessages({ ...works[1]!, runId: "run_just_done", now: t0 });
        await repo.claimUserMessages({ ...works[2]!, runId: "run_dead", now: t0 });
        await repo.claimUserMessages({ ...works[3]!, runId: "run_never_saved", now: t0 });

        expect(await repo.releaseOrphanedUserMessages({ now: t1, finishedBefore: t1 })).toBe(2);
        expect((await repo.listUserMessages(works[0]!))[0]).toMatchObject({ status: "processing", runId: "run_live" });
        expect((await repo.listUserMessages(works[1]!))[0]).toMatchObject({ status: "processing", runId: "run_just_done" });
        // Handed to the patrol, like every other way a run ends without finishing its messages.
        for (const work of works.slice(2)) {
          expect((await repo.listUserMessages(work))[0]).toMatchObject({ status: "pending", urgent: false, runId: null, updatedAt: t1 });
        }
        expect(await repo.releaseOrphanedUserMessages({ now: t1, finishedBefore: t1 })).toBe(0);
      });

      it("clearUserMessagesUrgent hands this work's pending messages to the patrol, and only them", async () => {
        const repo = await fresh();
        const otherTitle = { ...scope, titleKey: "tmdb_tv_2" };
        const otherDrive = { ...scope, drive: "cs_2" };
        const held = await repo.createUserMessage({ ...scope, body: "held by a run", episodeTags: [], now: t0 });
        await repo.claimUserMessages({ ...scope, runId: "run_1", now: t0 });
        // Written while the first one is processing: urgent.
        const later = await repo.createUserMessage({ ...scope, body: "written mid-run", episodeTags: [], now: "2026-09-26T00:00:30.000Z" });
        expect(later.urgent).toBe(true);
        for (const work of [otherTitle, otherDrive]) {
          await repo.createUserMessage({ ...work, body: "someone else", episodeTags: [], now: t0 });
          await repo.markUserMessagesUrgent({ ...work, now: t0 });
        }

        expect(await repo.clearUserMessagesUrgent({ ...scope, now: t1 })).toBe(1);

        expect((await repo.listUserMessages(scope)).map((m) => [m.id, m.status, m.urgent, m.updatedAt])).toEqual([
          [later.id, "pending", false, t1],
          [held.id, "processing", false, t0],
        ]);
        const urgentWorks = await repo.listWorksWithPendingMessages({ urgentOnly: true });
        expect(urgentWorks).toHaveLength(2);
        expect(urgentWorks).toEqual(expect.arrayContaining([otherTitle, otherDrive]));
        expect(await repo.clearUserMessagesUrgent({ ...scope, now: t1 })).toBe(0);
      });

      it("markUserMessagesUrgent and listWorksWithPendingMessages", async () => {
        const repo = await fresh();
        await repo.createUserMessage({ ...scope, body: "a", episodeTags: [], now: t0 });
        await repo.createUserMessage({ ...scope, titleKey: "tmdb_tv_2", body: "b", episodeTags: [], now: t0 });
        expect(await repo.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([]);
        expect(await repo.markUserMessagesUrgent({ ...scope, now: t1 })).toBe(1);
        expect(await repo.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([scope]);
        const all = await repo.listWorksWithPendingMessages({ urgentOnly: false });
        expect(all.map((w) => w.titleKey).sort()).toEqual(["tmdb_tv_1", "tmdb_tv_2"]);
      });

      it("pending replacements add idempotently and remove by episode", async () => {
        const repo = await fresh();
        await repo.addPendingReplacements({ ...scope, episodes: ["S01E13", "S01E24"], messageId: "m1", now: t0 });
        await repo.addPendingReplacements({ ...scope, episodes: ["S01E24"], messageId: "m2", now: t1 });
        expect((await repo.listPendingReplacements(scope)).map((p) => p.episode).sort()).toEqual(["S01E13", "S01E24"]);
        expect(await repo.listWorksWithPendingReplacements()).toEqual([scope]);
        expect(await repo.removePendingReplacements({ ...scope, episodes: ["S01E13", "S01E99"] })).toBe(1);
        expect((await repo.listPendingReplacements(scope)).map((p) => p.episode)).toEqual(["S01E24"]);
        expect(await repo.removePendingReplacements({ ...scope, episodes: ["S01E24", "S01E24"] })).toBe(1);
        expect(await repo.listPendingReplacements(scope)).toEqual([]);
      });

      it("rejected resources are scoped by account + work, across drives", async () => {
        const repo = await fresh();
        await repo.addRejectedResources({
          accountId: "acct_a", titleKey: "tmdb_movie_9", now: t0,
          items: [{ episode: "MOVIE", linkKey: "115:abc", label: "The.Odyssey.2026.mkv", sizeBytes: 100, reason: "假片", messageId: "m1" }],
        });
        const list = await repo.listRejectedResources({ accountId: "acct_a", titleKey: "tmdb_movie_9" });
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ episode: "MOVIE", linkKey: "115:abc", sizeBytes: 100, reason: "假片" });
        expect(await repo.listRejectedResources({ accountId: "acct_b", titleKey: "tmdb_movie_9" })).toEqual([]);
      });

      it("rejected resources round-trip null link/size and sizes beyond 32 bits", async () => {
        const repo = await fresh();
        const big = 60 * 1024 ** 3;
        await repo.addRejectedResources({
          accountId: "acct_a", titleKey: "tmdb_movie_9", now: t0,
          items: [{ episode: "MOVIE", linkKey: null, label: "unknown.mkv", sizeBytes: null, reason: "假片", messageId: null }],
        });
        await repo.addRejectedResources({
          accountId: "acct_a", titleKey: "tmdb_movie_9", now: t1,
          items: [{ episode: "MOVIE", linkKey: "magnet:bb", label: "remux.mkv", sizeBytes: big, reason: "发蓝", messageId: "m2" }],
        });
        const list = await repo.listRejectedResources({ accountId: "acct_a", titleKey: "tmdb_movie_9" });
        expect(list.map((r) => ({ linkKey: r.linkKey, sizeBytes: r.sizeBytes, messageId: r.messageId, createdAt: r.createdAt }))).toEqual([
          { linkKey: null, sizeBytes: null, messageId: null, createdAt: t0 },
          { linkKey: "magnet:bb", sizeBytes: big, messageId: "m2", createdAt: t1 },
        ]);
      });

      it("episode sources upsert per episode", async () => {
        const repo = await fresh();
        const base = { ...scope, episode: "S01E13", linkKey: "magnet:aa", label: "old", sizeBytes: 1, runId: "r1", recordedAt: t0 };
        await repo.upsertEpisodeSource(base);
        await repo.upsertEpisodeSource({ ...base, label: "new", runId: "r2", recordedAt: t1 });
        expect(await repo.listEpisodeSources(scope)).toEqual([{ ...base, label: "new", runId: "r2", recordedAt: t1 }]);
      });

      it("episode sources round-trip null link/size and sizes beyond 32 bits", async () => {
        const repo = await fresh();
        const big = 60 * 1024 ** 3;
        const unknown = { ...scope, episode: "S01E01", linkKey: null, label: "a.mkv", sizeBytes: null, runId: "r1", recordedAt: t0 };
        const large = { ...scope, episode: "S01E02", linkKey: "115:cc", label: "b.mkv", sizeBytes: big, runId: "r1", recordedAt: t0 };
        await repo.upsertEpisodeSource(unknown);
        await repo.upsertEpisodeSource(large);
        expect(await repo.listEpisodeSources(scope)).toEqual([unknown, large]);
        expect(await repo.listEpisodeSources({ ...scope, drive: "cs_2" })).toEqual([]);
      });

      describe("listLandingSources", () => {
        const magnet = (c: string) => `magnet:?xt=urn:btih:${c.repeat(40)}`;
        const titleOf = (runId: string, key: string) => `title ${runId} ${key}`;
        /** A finished run with one snapshot of `candidates` and one transfer attempt per
         *  entry of `transfers` (in order). Snapshot / attempt ids are per run: they are
         *  primary keys in both SQL engines. */
        function landingRun(input: {
          id: string;
          startedAt: string;
          accountId?: string;
          /** Omitted: saved with no connected storage. */
          drive?: string;
          candidates: Array<{ key: string; url?: unknown }>;
          transfers: Array<{ key: string; fileIds: unknown; status?: TransferAttempt["status"] }>;
        }) {
          const base = workflowPersistenceFixture();
          const seasonId = `season_${input.id}`;
          const snapshotId = `snap_${input.id}`;
          return {
            ...base,
            accountId: input.accountId ?? "acct_a",
            ...(input.drive === undefined ? {} : { connectedStorageId: input.drive }),
            season: { ...base.season, id: seasonId },
            workflowRun: { ...base.workflowRun, id: input.id, trackedSeasonId: seasonId, startedAt: input.startedAt, finishedAt: input.startedAt },
            episodes: [],
            resourceSnapshots: [
              {
                id: snapshotId,
                provider: "pansou",
                keyword: "奥德赛",
                createdAt: input.startedAt,
                candidates: input.candidates.map((c, index) => ({
                  id: `${input.id}_${c.key}`,
                  snapshotId,
                  index,
                  title: titleOf(input.id, c.key),
                  type: "magnet" as const,
                  source: "pansou",
                  providerPayload: c.url === undefined ? {} : { url: c.url },
                })),
              },
            ],
            decisions: [],
            transferAttempts: input.transfers.map((t, ordinal) => ({
              id: `ta_${input.id}_${ordinal}`,
              workflowRunId: input.id,
              candidateId: `${input.id}_${t.key}`,
              status: t.status ?? ("succeeded" as const),
              providerMessage: "",
              materializedFileIds: t.fileIds as string[],
            })),
            notifications: [],
          };
        }

        it("returns the link and title of the candidate whose transfer landed each id, from runs of this account on this drive only", async () => {
          const repo = await fresh();
          // Older runs of another drive and of another account claim the same file id.
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_other_drive", drive: "cs_2", startedAt: "2026-09-01T00:00:00.000Z",
            candidates: [{ key: "x", url: magnet("d") }], transfers: [{ key: "x", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_other_account", accountId: "acct_b", drive: "cs_1", startedAt: "2026-09-01T00:00:00.000Z",
            candidates: [{ key: "x", url: magnet("e") }], transfers: [{ key: "x", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_landed", drive: "cs_1", startedAt: "2026-09-10T00:00:00.000Z",
            candidates: [{ key: "a", url: magnet("a") }, { key: "b", url: magnet("b") }],
            // A transfer the provider called failed still landed f3: status is not a filter.
            transfers: [{ key: "a", fileIds: ["f1", "f2"] }, { key: "b", fileIds: ["f3"], status: "failed" }],
          }));

          expect(await repo.listLandingSources({ accountId: "acct_a", drive: "cs_1", fileIds: ["f1", "f3", "f_never_landed"] })).toEqual([
            { fileId: "f1", url: magnet("a"), title: titleOf("run_landed", "a") },
            { fileId: "f3", url: magnet("b"), title: titleOf("run_landed", "b") },
          ]);
        });

        it("an empty id list reads nothing", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_landed", drive: "cs_1", startedAt: t0, candidates: [{ key: "a", url: magnet("a") }], transfers: [{ key: "a", fileIds: ["f1"] }],
          }));
          expect(await repo.listLandingSources({ accountId: "acct_a", drive: "cs_1", fileIds: [] })).toEqual([]);
        });

        it("drive '' is the run saved with no connected storage, and only that run", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_unbound", startedAt: t0, candidates: [{ key: "u", url: magnet("a") }], transfers: [{ key: "u", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_bound", drive: "cs_1", startedAt: t0, candidates: [{ key: "b", url: magnet("b") }], transfers: [{ key: "b", fileIds: ["f1"] }],
          }));
          expect(await repo.listLandingSources({ accountId: "acct_a", drive: "", fileIds: ["f1"] })).toEqual([
            { fileId: "f1", url: magnet("a"), title: titleOf("run_unbound", "u") },
          ]);
          expect(await repo.listLandingSources({ accountId: "acct_a", drive: "cs_1", fileIds: ["f1"] })).toEqual([
            { fileId: "f1", url: magnet("b"), title: titleOf("run_bound", "b") },
          ]);
        });

        it("oldest run first, then the run's transfers in order, each transfer's files in landing order", async () => {
          const repo = await fresh();
          // Saved first, started later.
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_late", drive: "cs_1", startedAt: "2026-09-20T00:00:00.000Z",
            candidates: [{ key: "l", url: magnet("c") }], transfers: [{ key: "l", fileIds: ["f7"] }],
          }));
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_early", drive: "cs_1", startedAt: "2026-09-10T00:00:00.000Z",
            candidates: [{ key: "e1", url: magnet("a") }, { key: "e2", url: magnet("b") }],
            transfers: [{ key: "e1", fileIds: ["f7"] }, { key: "e2", fileIds: ["f7", "f8"] }],
          }));

          expect(await repo.listLandingSources({ accountId: "acct_a", drive: "cs_1", fileIds: ["f8", "f7"] })).toEqual([
            { fileId: "f7", url: magnet("a"), title: titleOf("run_early", "e1") },
            { fileId: "f7", url: magnet("b"), title: titleOf("run_early", "e2") },
            { fileId: "f8", url: magnet("b"), title: titleOf("run_early", "e2") },
            { fileId: "f7", url: magnet("c"), title: titleOf("run_late", "l") },
          ]);
        });

        it("lists a transfer whose candidate has no usable url — missing, empty or not a string — with url null: the file still has a source of its own", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_urls", drive: "cs_1", startedAt: t0,
            candidates: [{ key: "missing" }, { key: "empty", url: "" }, { key: "number", url: 42 }, { key: "good", url: magnet("a") }],
            transfers: [
              { key: "missing", fileIds: ["f1"] },
              { key: "empty", fileIds: ["f2"] },
              { key: "number", fileIds: ["f3"] },
              { key: "good", fileIds: ["f4"] },
            ],
          }));
          expect(await repo.listLandingSources({ accountId: "acct_a", drive: "cs_1", fileIds: ["f1", "f2", "f3", "f4"] })).toEqual([
            { fileId: "f1", url: null, title: titleOf("run_urls", "missing") },
            { fileId: "f2", url: null, title: titleOf("run_urls", "empty") },
            { fileId: "f3", url: null, title: titleOf("run_urls", "number") },
            { fileId: "f4", url: magnet("a"), title: titleOf("run_urls", "good") },
          ]);
        });

        it("a transfer whose landed files are not a list counts as landing nothing, without breaking the read", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(landingRun({
            id: "run_odd", drive: "cs_1", startedAt: t0,
            candidates: [{ key: "a", url: magnet("a") }],
            transfers: [{ key: "a", fileIds: "f1" }, { key: "a", fileIds: undefined }, { key: "a", fileIds: ["f1"] }],
          }));
          expect(await repo.listLandingSources({ accountId: "acct_a", drive: "cs_1", fileIds: ["f1"] })).toEqual([
            { fileId: "f1", url: magnet("a"), title: titleOf("run_odd", "a") },
          ]);
        });
      });

      describe("listLinkHistory", () => {
        const share = "https://www.123pan.com/s/Ab-cD_12";
        const otherShare = "https://www.123pan.com/s/OtherKey1";
        /** A finished run of one work. Snapshot and attempt ids are per run (SQL primary keys). */
        function historyRun(input: {
          id: string;
          startedAt: string;
          accountId?: string;
          /** Omitted: saved with no connected storage. */
          drive?: string;
          titleKey?: string;
          candidates: Array<{ key: string; url?: unknown }>;
          /** Further snapshots in this run, after the first. Same candidate shape. */
          laterSnapshots?: Array<Array<{ key: string; url?: unknown }>>;
          transfers: Array<{ key: string; fileIds: unknown; fate?: unknown }>;
        }) {
          const base = workflowPersistenceFixture();
          const titleKey = input.titleKey ?? "title_1";
          const seasonId = `season_${input.id}`;
          const snapshots = [input.candidates, ...(input.laterSnapshots ?? [])];
          return {
            ...base,
            accountId: input.accountId ?? "acct_a",
            ...(input.drive === undefined ? {} : { connectedStorageId: input.drive }),
            title: { ...base.title, id: titleKey },
            season: { ...base.season, id: seasonId, mediaTitleId: titleKey },
            workflowRun: { ...base.workflowRun, id: input.id, trackedSeasonId: seasonId, startedAt: input.startedAt, finishedAt: input.startedAt },
            episodes: [],
            resourceSnapshots: snapshots.map((candidates, ordinal) => {
              const snapshotId = `snap_${input.id}_${ordinal}`;
              return {
                id: snapshotId,
                provider: "pansou",
                keyword: "黄泉",
                createdAt: input.startedAt,
                candidates: candidates.map((c, index) => ({
                  id: `${input.id}_${c.key}`,
                  snapshotId,
                  index,
                  title: `${input.id} ${c.key}`,
                  type: "123" as const,
                  source: "pansou",
                  providerPayload: c.url === undefined ? {} : { url: c.url },
                })),
              };
            }),
            decisions: [],
            transferAttempts: input.transfers.map((t, ordinal) => {
              const attempt: TransferAttempt = {
                id: `ta_${input.id}_${ordinal}`,
                workflowRunId: input.id,
                candidateId: `${input.id}_${t.key}`,
                status: "succeeded",
                providerMessage: "",
                materializedFileIds: t.fileIds as string[],
              };
              // Malformed values are stored on purpose; the cast only satisfies the field type.
              if (t.fate !== undefined) attempt.fate = t.fate as NonNullable<TransferAttempt["fate"]>;
              return attempt;
            }),
            notifications: [],
          };
        }

        const query = {
          accountId: "acct_a",
          drive: "cs_1",
          titleKey: "title_1",
          since: "2026-08-28T00:00:00.000Z",
        };

        it("returns this work's transfers only: same account, drive and title, including another season of that title", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_other_account", accountId: "acct_b", drive: "cs_1", startedAt: "2026-09-10T00:00:00.000Z",
            candidates: [{ key: "x", url: otherShare }], transfers: [{ key: "x", fileIds: ["f1", "f2"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_other_drive", drive: "cs_2", startedAt: "2026-09-10T00:00:00.000Z",
            candidates: [{ key: "x", url: otherShare }], transfers: [{ key: "x", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_other_title", drive: "cs_1", titleKey: "tmdb_movie_9", startedAt: "2026-09-10T00:00:00.000Z",
            candidates: [{ key: "x", url: otherShare }], transfers: [{ key: "x", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_s1", drive: "cs_1", startedAt: "2026-09-10T00:00:00.000Z",
            candidates: [{ key: "a", url: share }], transfers: [{ key: "a", fileIds: ["f1", "f2", "f3"] }],
          }));
          // Another season of the same title is the same work.
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_s2", drive: "cs_1", titleKey: "title_1", startedAt: "2026-09-11T00:00:00.000Z",
            candidates: [{ key: "b", url: otherShare }], transfers: [{ key: "b", fileIds: ["g1"] }],
          }));

          expect(await repo.listLinkHistory(query)).toEqual([
            { url: share, startedAt: "2026-09-10T00:00:00.000Z", materializedCount: 3 },
            { url: otherShare, startedAt: "2026-09-11T00:00:00.000Z", materializedCount: 1 },
          ]);
        });

        it("since is inclusive on the run's startedAt; an earlier run is absent", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_before", drive: "cs_1", startedAt: "2026-08-27T23:59:59.000Z",
            candidates: [{ key: "a", url: share }], transfers: [{ key: "a", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_on", drive: "cs_1", startedAt: "2026-08-28T00:00:00.000Z",
            candidates: [{ key: "b", url: share }], transfers: [{ key: "b", fileIds: ["f1", "f2"] }],
          }));
          expect(await repo.listLinkHistory(query)).toEqual([
            { url: share, startedAt: "2026-08-28T00:00:00.000Z", materializedCount: 2 },
          ]);
        });

        it("excludeRunId drops that run and no other", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_keep", drive: "cs_1", startedAt: "2026-09-01T00:00:00.000Z",
            candidates: [{ key: "a", url: share }], transfers: [{ key: "a", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_skip", drive: "cs_1", startedAt: "2026-09-02T00:00:00.000Z",
            candidates: [{ key: "b", url: otherShare }], transfers: [{ key: "b", fileIds: ["f2"] }],
          }));
          expect(await repo.listLinkHistory({ ...query, excludeRunId: "run_skip" })).toEqual([
            { url: share, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 1 },
          ]);
          expect(await repo.listLinkHistory(query)).toHaveLength(2);
        });

        it("drive '' is the run saved with no connected storage", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_unbound", startedAt: "2026-09-01T00:00:00.000Z",
            candidates: [{ key: "u", url: share }], transfers: [{ key: "u", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_bound", drive: "cs_1", startedAt: "2026-09-01T00:00:00.000Z",
            candidates: [{ key: "b", url: otherShare }], transfers: [{ key: "b", fileIds: ["f1"] }],
          }));
          expect(await repo.listLinkHistory({ ...query, drive: "" })).toEqual([
            { url: share, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 1 },
          ]);
        });

        it("looks the url up in that run's own snapshots: unusable urls are null, and the earliest snapshot wins", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_urls", drive: "cs_1", startedAt: "2026-09-01T00:00:00.000Z",
            candidates: [
              { key: "missing" },
              { key: "empty", url: "" },
              { key: "number", url: 42 },
              { key: "good", url: share },
            ],
            transfers: [
              { key: "missing", fileIds: ["f1"] },
              { key: "empty", fileIds: ["f2"] },
              { key: "number", fileIds: ["f3"] },
              { key: "good", fileIds: ["f4"] },
            ],
          }));
          // The candidate is in two snapshots. The earliest one's url is the one recorded.
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_two", drive: "cs_1", startedAt: "2026-09-02T00:00:00.000Z",
            candidates: [{ key: "a", url: "" }],
            laterSnapshots: [[{ key: "a", url: share }]],
            transfers: [{ key: "a", fileIds: ["f9"] }],
          }));
          // Not in the first snapshot: the later one is used.
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_later", drive: "cs_1", startedAt: "2026-09-03T00:00:00.000Z",
            candidates: [{ key: "other", url: otherShare }],
            laterSnapshots: [[{ key: "a", url: share }]],
            transfers: [{ key: "a", fileIds: ["f8"] }],
          }));

          expect(await repo.listLinkHistory(query)).toEqual([
            { url: null, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 1 },
            { url: null, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 1 },
            { url: null, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 1 },
            { url: null, startedAt: "2026-09-02T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-03T00:00:00.000Z", materializedCount: 1 },
          ]);
        });

        it("materializedCount is the landed-file list length; a non-list counts as 0 and does not break the read", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_count", drive: "cs_1", startedAt: "2026-09-05T00:00:00.000Z",
            candidates: [{ key: "a", url: share }],
            transfers: [
              { key: "a", fileIds: ["f1", "f2"] },
              { key: "a", fileIds: "f1" },
              { key: "a", fileIds: undefined },
              { key: "a", fileIds: [] },
            ],
          }));
          expect(await repo.listLinkHistory(query)).toEqual([
            { url: share, startedAt: "2026-09-05T00:00:00.000Z", materializedCount: 2 },
            { url: share, startedAt: "2026-09-05T00:00:00.000Z", materializedCount: 0 },
            { url: share, startedAt: "2026-09-05T00:00:00.000Z", materializedCount: 0 },
            { url: share, startedAt: "2026-09-05T00:00:00.000Z", materializedCount: 0 },
          ]);
        });

        it("round-trips fate, and a missing, non-object or incomplete fate is absent", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_fate", drive: "cs_1", startedAt: "2026-09-06T00:00:00.000Z",
            candidates: [{ key: "a", url: share }],
            transfers: [
              { key: "a", fileIds: ["f1"], fate: { kept: 2, thrownAway: 10 } },
              { key: "a", fileIds: ["f2"] },
              { key: "a", fileIds: ["f3"], fate: "nope" },
              { key: "a", fileIds: ["f4"], fate: { kept: 1 } },
              { key: "a", fileIds: ["f5"], fate: { kept: "1", thrownAway: 0 } },
              { key: "a", fileIds: ["f6"], fate: null },
            ],
          }));
          expect(await repo.listLinkHistory(query)).toEqual([
            { url: share, startedAt: "2026-09-06T00:00:00.000Z", materializedCount: 1, fate: { kept: 2, thrownAway: 10 } },
            { url: share, startedAt: "2026-09-06T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-06T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-06T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-06T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-06T00:00:00.000Z", materializedCount: 1 },
          ]);
        });

        it("a stored fate that is not two non-negative integers counting at least one file comes back without fate", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_bad_fate", drive: "cs_1", startedAt: "2026-09-07T00:00:00.000Z",
            candidates: [{ key: "a", url: share }],
            transfers: [
              { key: "a", fileIds: ["f1"], fate: { kept: 0, thrownAway: -1 } },
              { key: "a", fileIds: ["f2"], fate: { kept: 0.5, thrownAway: 2 } },
              { key: "a", fileIds: ["f3"], fate: { kept: 0, thrownAway: 0 } },
              { key: "a", fileIds: ["f4"], fate: { kept: 0, thrownAway: 12 } },
            ],
          }));
          expect(await repo.listLinkHistory(query)).toEqual([
            { url: share, startedAt: "2026-09-07T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-07T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-07T00:00:00.000Z", materializedCount: 1 },
            { url: share, startedAt: "2026-09-07T00:00:00.000Z", materializedCount: 1, fate: { kept: 0, thrownAway: 12 } },
          ]);
        });

        it("orders by startedAt, then run id, then the run's transfer order", async () => {
          const repo = await fresh();
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_b", drive: "cs_1", startedAt: "2026-09-02T00:00:00.000Z",
            candidates: [{ key: "a", url: share }, { key: "b", url: otherShare }],
            transfers: [{ key: "b", fileIds: ["f2"] }, { key: "a", fileIds: ["f1"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_a", drive: "cs_1", startedAt: "2026-09-02T00:00:00.000Z",
            candidates: [{ key: "a", url: share }],
            transfers: [{ key: "a", fileIds: ["f3"] }],
          }));
          await repo.saveWorkflowRunSnapshot(historyRun({
            id: "run_early", drive: "cs_1", startedAt: "2026-09-01T00:00:00.000Z",
            candidates: [{ key: "a", url: otherShare }],
            transfers: [{ key: "a", fileIds: ["f0"] }],
          }));
          expect((await repo.listLinkHistory(query)).map((row) => `${row.startedAt} ${row.url} ${row.materializedCount}`)).toEqual([
            `2026-09-01T00:00:00.000Z ${otherShare} 1`,
            `2026-09-02T00:00:00.000Z ${share} 1`,
            `2026-09-02T00:00:00.000Z ${otherShare} 1`,
            `2026-09-02T00:00:00.000Z ${share} 1`,
          ]);
        });
      });
    });

    describe("agent memories", () => {
      const now = "2026-09-25T00:00:00.000Z";
      const entry = (over: Record<string, unknown> = {}) => ({
        scope: "title" as const,
        name: "no-2025-year",
        description: "2026 首播,带 2025 搜不到",
        kind: "search" as const,
        body: "搜「黄泉的使者 2025」0 命中。",
        ...over,
      });

      it("onlyDrive: a row tagged with another drive is neither overwritten nor deleted; untagged/same drive are", async () => {
        const repo = await fresh();
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "g", provider: "guangya" }), now });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "u" }), now });
        await expect(
          repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "g", body: "改", provider: "pan115" }), now, onlyDrive: "pan115" }),
        ).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
        await expect(
          repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1", name: "g", onlyDrive: "pan115" }),
        ).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
        const g = (await repo.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1" })).find((m) => m.name === "g");
        expect(g).toMatchObject({ provider: "guangya", body: entry().body });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "u", body: "补", provider: "pan115" }), now, onlyDrive: "pan115" });
        expect(await repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1", name: "u", onlyDrive: "pan115" })).toBe(true);
        expect(await repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1", name: "missing", onlyDrive: "pan115" })).toBe(false);
        // Concurrent FIRST writes of the same new name from two drives: exactly one
        // lands, the other is refused — the winner's tag is never flipped.
        const race = await Promise.allSettled([
          repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "race", provider: "guangya" }), now, onlyDrive: "guangya" }),
          repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "race", provider: "pan115" }), now, onlyDrive: "pan115" }),
        ]);
        expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const winner = (race.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ provider: string | null }>).value.provider;
        const raced = (await repo.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1" })).find((m) => m.name === "race");
        expect(raced!.provider).toBe(winner);
        // Legacy brand tag: accepted (and retagged) only when the caller names that brand.
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "legacy", provider: "pan115" }), now });
        await expect(
          repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "legacy", provider: "cs_115" }), now, onlyDrive: "cs_115" }),
        ).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
        const retagged = await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "legacy", provider: "cs_115" }), now, onlyDrive: "cs_115", legacyDrive: "pan115" });
        expect(retagged.provider).toBe("cs_115");
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry({ name: "legacy2", provider: "pan115" }), now });
        expect(await repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1", name: "legacy2", onlyDrive: "cs_115", legacyDrive: "pan115" })).toBe(true);
        // Without onlyDrive (UI path) the user can still edit/delete anything.
        expect(await repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1", name: "g" })).toBe(true);
      });

      it("getMediaTitleName reads one title's display name by its id (the memory title key)", async () => {
        const repo = await fresh();
        expect(await repo.getMediaTitleName("title_1")).toBeNull();
        await repo.saveWorkflowRunSnapshot(workflowPersistenceFixture());
        expect(await repo.getMediaTitleName("title_1")).toBe("Show");
        expect(await repo.getMediaTitleName("tmdb_tv_404")).toBeNull();
      });

      it("summarizes counts across works and scopes for one account (settings page numbers)", async () => {
        const repo = await fresh();
        expect(await repo.summarizeAgentMemories({ accountId: "acct_1", since: "2026-09-01T00:00:00.000Z" })).toEqual({
          titleEntries: 0, titleWorks: 0, globalEntries: 0, createdSince: 0, latest: null,
        });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ name: "a" }), now: "2026-08-01T00:00:00.000Z" });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ name: "b" }), now: "2026-09-20T00:00:00.000Z" });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_2", entry: entry({ name: "c" }), now: "2026-09-21T00:00:00.000Z" });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: entry({ scope: "global", name: "g" }), now: "2026-09-22T00:00:00.000Z" });
        await repo.upsertAgentMemory({ accountId: "acct_2", titleKey: "tmdb_tv_9", entry: entry({ name: "other" }), now: "2026-09-23T00:00:00.000Z" });
        // An overwrite moves updatedAt, not createdAt.
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ name: "a", body: "改" }), now: "2026-09-24T00:00:00.000Z" });
        expect(await repo.summarizeAgentMemories({ accountId: "acct_1", since: "2026-09-18T00:00:00.000Z" })).toEqual({
          titleEntries: 3,
          titleWorks: 2,
          globalEntries: 1,
          createdSince: 3,
          latest: { scope: "title", titleKey: "tmdb_tv_1", updatedAt: "2026-09-24T00:00:00.000Z" },
        });
      });

      it("title scope refuses a missing or blank titleKey on every operation (no shared keyless bucket)", async () => {
        const repo = await fresh();
        for (const titleKey of [undefined, null, "", "  "] as unknown as string[]) {
          await expect(repo.upsertAgentMemory({ accountId: "acct_1", titleKey, entry: entry(), now })).rejects.toThrow(/MEMORY_TITLE_KEY_REQUIRED/);
          await expect(repo.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey })).rejects.toThrow(/MEMORY_TITLE_KEY_REQUIRED/);
          await expect(repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey, name: "no-2025-year" })).rejects.toThrow(/MEMORY_TITLE_KEY_REQUIRED/);
        }
        // Global scope needs no key.
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: entry({ scope: "global" }), now });
        expect(await repo.listAgentMemories({ accountId: "acct_1", scope: "global" })).toHaveLength(1);
      });

      it("upserts by (account, scope, titleKey, name) and lists newest update first", async () => {
        const repo = await fresh();
        const a = await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry(), sourceRunId: "r1", now });
        expect(a).toMatchObject({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1", name: "no-2025-year", sourceRunId: "r1", createdAt: now, updatedAt: now, lastUsedAt: null, provider: null });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ name: "good-group", kind: "resource" }), now: "2026-09-25T01:00:00.000Z" });
        const b = await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ body: "改过的正文", provider: "pan123" }), now: "2026-09-25T02:00:00.000Z" });
        expect(b.id).toBe(a.id); // same row, overwritten
        expect(b).toMatchObject({ body: "改过的正文", provider: "pan123", createdAt: now, updatedAt: "2026-09-25T02:00:00.000Z" });
        const list = await repo.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1" });
        expect(list.map((m) => m.name)).toEqual(["no-2025-year", "good-group"]);
      });

      it("isolates by titleKey, scope and account", async () => {
        const repo = await fresh();
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry(), now });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: entry(), now });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: entry({ scope: "global" }), now });
        await repo.upsertAgentMemory({ accountId: "acct_2", titleKey: "tmdb_tv_1", entry: entry(), now });
        expect(await repo.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1" })).toHaveLength(1);
        expect(await repo.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1" })).toHaveLength(1);
        const global = await repo.listAgentMemories({ accountId: "acct_1", scope: "global" });
        expect(global).toHaveLength(1);
        expect(global[0]).toMatchObject({ scope: "global", titleKey: null });
        expect(await repo.listAgentMemories({ accountId: "acct_2", scope: "global" })).toHaveLength(0);
      });

      it("deletes only the addressed row, and reports whether one was removed", async () => {
        const repo = await fresh();
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry(), now });
        await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_2", entry: entry(), now });
        expect(await repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1", name: "no-2025-year" })).toBe(true);
        expect(await repo.deleteAgentMemory({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1", name: "no-2025-year" })).toBe(false);
        expect(await repo.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_2" })).toHaveLength(1);
      });

      it("enforces maxEntries atomically in the store: a new name at the cap is refused, an overwrite is not", async () => {
        const repo = await fresh();
        for (let i = 0; i < 3; i += 1) {
          await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ name: `m-${i}` }), now, maxEntries: 3 });
        }
        await expect(
          repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ name: "m-extra" }), now, maxEntries: 3 }),
        ).rejects.toThrow(/MEMORY_FULL/);
        await expect(
          repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: entry({ name: "m-0", body: "overwrite" }), now, maxEntries: 3 }),
        ).resolves.toMatchObject({ body: "overwrite" });
        // Concurrent distinct inserts at the edge: never more than the cap.
        const repo2 = await fresh();
        await repo2.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: entry({ scope: "global", name: "g-0" }), now, maxEntries: 2 });
        const results = await Promise.allSettled(
          ["g-1", "g-2", "g-3", "g-4"].map((name) =>
            repo2.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: entry({ scope: "global", name }), now, maxEntries: 2 }),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(await repo2.listAgentMemories({ accountId: "acct_1", scope: "global" })).toHaveLength(2);
      });

      it("touch refreshes lastUsedAt only for this account's ids", async () => {
        const repo = await fresh();
        const a = await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: entry({ scope: "global" }), now });
        const b = await repo.upsertAgentMemory({ accountId: "acct_2", titleKey: null, entry: entry({ scope: "global" }), now });
        await repo.touchAgentMemories({ accountId: "acct_1", ids: [a.id, b.id], now: "2026-09-26T00:00:00.000Z" });
        expect((await repo.listAgentMemories({ accountId: "acct_1", scope: "global" }))[0]!.lastUsedAt).toBe("2026-09-26T00:00:00.000Z");
        expect((await repo.listAgentMemories({ accountId: "acct_2", scope: "global" }))[0]!.lastUsedAt).toBeNull();
      });
    });

    describe("accounts + sessions", () => {
      const account = (over: Partial<Account> = {}): Account => ({
        id: "acct_1",
        username: "alice",
        passwordHash: "h",
        groupId: null,
        isOwner: true,
        createdAt: "2026-07-04T00:00:00.000Z",
        ...over,
      });

      // The implicit default account exists as a seeded schema row on SQLite/Postgres
      // but not on InMemory. Establish it through the public interface so the
      // adoptDefaultAccount contract starts from identical state on every engine.
      async function ensureDefaultAccount(repo: WorkflowRepository): Promise<void> {
        if (!(await repo.getAccountById("acct_default"))) {
          await repo.createAccount(
            account({ id: "acct_default", username: "default", passwordHash: "", isOwner: true }),
          );
        }
      }

      it("creates and reads back an account (discrete columns, is_owner round-trips)", async () => {
        const repo = await fresh();
        await repo.createAccount(account());
        const byName = await repo.getAccountByUsername("alice");
        expect(byName?.id).toBe("acct_1");
        expect(byName?.isOwner).toBe(true);
        expect(byName?.groupId).toBeNull();
        expect((await repo.getAccountById("acct_1"))?.username).toBe("alice");
        expect(await repo.getAccountByUsername("nobody")).toBeNull();
      });

      it("rejects a duplicate username", async () => {
        const repo = await fresh();
        await repo.createAccount(account());
        await expect(repo.createAccount(account({ id: "acct_2" }))).rejects.toBeInstanceOf(
          DuplicateUsernameError,
        );
      });

      it("round-trips and deletes a session", async () => {
        const repo = await fresh();
        await repo.createSession({
          id: "sess_1",
          accountId: "acct_1",
          createdAt: "2026-07-04T00:00:00.000Z",
          expiresAt: "2026-08-04T00:00:00.000Z",
        });
        expect((await repo.getSession("sess_1"))?.accountId).toBe("acct_1");
        await repo.deleteSession("sess_1");
        expect(await repo.getSession("sess_1")).toBeNull();
      });

      it("adoptDefaultAccount claims the seeded acct_default in place", async () => {
        const repo = await fresh();
        await ensureDefaultAccount(repo);
        await repo.adoptDefaultAccount({ username: "owner", passwordHash: "ph" });
        const acct = await repo.getAccountByUsername("owner");
        expect(acct?.id).toBe("acct_default");
        expect(acct?.isOwner).toBe(true);
      });

      it("deletes an account's sessions except an optional kept one", async () => {
        const repo = await fresh();
        await repo.createSession({ id: "s1", accountId: "acct_x", createdAt: "t", expiresAt: "t2" });
        await repo.createSession({ id: "s2", accountId: "acct_x", createdAt: "t", expiresAt: "t2" });
        await repo.deleteSessionsForAccount("acct_x", "s2");
        expect(await repo.getSession("s1")).toBeNull();
        expect(await repo.getSession("s2")).not.toBeNull();
      });
    });

    describe("connected_storages", () => {
      const drive = (over = {}) => ({
        id: "cs_1",
        accountId: "acct_a",
        provider: "pan115",
        providerUid: "uid1",
        payload: { cookie: "A" },
        createdAt: "2026-07-04T00:00:00.000Z",
        ...over,
      });

      it("upserts and lists a drive for its account", async () => {
        const repo = await fresh();
        await repo.upsertConnectedStorage(drive());
        const list = await repo.listConnectedStorages("acct_a");
        expect(list).toHaveLength(1);
        expect(list[0]?.provider).toBe("pan115");
      });

      it("refuses to let a different account overwrite an existing drive binding", async () => {
        const repo = await fresh();
        await repo.upsertConnectedStorage(drive());
        await repo.upsertConnectedStorage(
          drive({ id: "cs_2", accountId: "acct_b", payload: { cookie: "B" } }),
        );
        expect(await repo.listConnectedStorages("acct_a")).toHaveLength(1);
        expect(await repo.listConnectedStorages("acct_b")).toHaveLength(0);
      });

      it("refresh preserves status (frozen stays frozen across re-scan)", async () => {
        const repo = await fresh();
        await repo.upsertConnectedStorage(drive());
        await repo.setConnectedStorageStatus(
          "cs_1",
          "frozen",
          "cookie died",
          "2026-07-04T01:00:00.000Z",
        );
        await repo.upsertConnectedStorage(drive({ payload: { cookie: "refreshed" } })); // same provider/uid
        const found = await repo.findConnectedStorageByUid("pan115", "uid1");
        expect(found?.status).toBe("frozen");
        expect(found?.frozenReason).toBe("cookie died");
      });

      it("finds by uid and deletes fail-closed on account", async () => {
        const repo = await fresh();
        await repo.upsertConnectedStorage(drive());
        expect((await repo.findConnectedStorageByUid("pan115", "uid1"))?.id).toBe("cs_1");
        await repo.deleteConnectedStorage("acct_WRONG", "cs_1"); // wrong account = no-op
        expect(await repo.findConnectedStorageByUid("pan115", "uid1")).not.toBeNull();
        await repo.deleteConnectedStorage("acct_a", "cs_1");
        expect(await repo.findConnectedStorageByUid("pan115", "uid1")).toBeNull();
      });
    });

    describe("dead_links", () => {
      it("records idempotently and hides expired non-permanent links but keeps permanent ones", async () => {
        const repo = await fresh();
        await repo.recordDeadLink({ key: "k_temp", kind: "magnet", reason: "r", permanent: false, ttlMs: 1000, now: "2026-07-04T00:00:00.000Z" });
        await repo.recordDeadLink({ key: "k_temp", kind: "magnet", reason: "changed", permanent: true, now: "2026-07-04T00:00:00.000Z" }); // idempotent: ignored
        await repo.recordDeadLink({ key: "k_perm", kind: "magnet", reason: "r", permanent: true, now: "2026-07-04T00:00:00.000Z" });
        const soon = await repo.listDeadLinkKeys({ now: "2026-07-04T00:00:00.500Z" });
        expect(new Set(soon)).toEqual(new Set(["k_temp", "k_perm"]));
        const later = await repo.listDeadLinkKeys({ now: "2026-07-04T00:00:02.000Z" });
        expect(new Set(later)).toEqual(new Set(["k_perm"]));
      });
    });

    describe("snapshot persist + reserve", () => {
      it("persists a snapshot and reads it back with derived episode summaries", async () => {
        const repo = await fresh();
        const snap = workflowPersistenceFixture();
        await repo.saveWorkflowRunSnapshot(snap);
        const got = await repo.getWorkflowRunSnapshot(snap.workflowRun.id);
        expect(got?.workflowRun.id).toBe(snap.workflowRun.id);
        expect(got?.obtainedEpisodes).toContain("S01E01"); // episode 1 obtained in the fixture
        expect(got?.obtainedEpisodes).not.toContain("S01E02");
      });

      // A snapshot whose transfer_attempts / notifications reference the run's id
      // (validateWorkflowRunSnapshot enforces this). When a test re-ids the run, the
      // child collections must be cleared or re-parented, exactly as the oracle's own
      // reserve tests do (repository.test.ts). These helpers keep the run id coherent.
      const reIded = (id: string, over: Record<string, unknown> = {}) => {
        const base = workflowPersistenceFixture();
        return {
          ...base,
          workflowRun: { ...base.workflowRun, id, status: "queued" as const, finishedAt: null },
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
          ...over,
        };
      };

      it("reserves once, then reports already_active for the same season+kind+scope", async () => {
        const repo = await fresh();
        expect((await repo.reserveWorkflowRun(reIded("run_a"))).status).toBe("reserved");
        const again = await repo.reserveWorkflowRun(reIded("run_b"));
        expect(again.status).toBe("already_active");
      });

      it("two concurrent title-locked reservations for the same title: exactly one is reserved", async () => {
        const repo = await fresh();
        // Different seasons AND kinds, so only the title lock (not the per-season+kind
        // check) can keep the second one out. Postgres runs both transactions at once.
        const base = workflowPersistenceFixture();
        const reserveFor = (id: string, seasonId: string, kind: "type2_init" | "replace_request") =>
          repo.reserveWorkflowRun(
            reIded(id, {
              season: { ...base.season, id: seasonId, seasonNumber: seasonId === "season_x1" ? 1 : 2 },
              workflowRun: { ...base.workflowRun, id, kind, status: "queued" as const, trackedSeasonId: seasonId, finishedAt: null },
              episodes: [],
              connectedStorageId: "cs_lock",
              blockIfTitleHasActiveRun: true,
            }),
          );
        for (let round = 0; round < 5; round++) {
          const results = await Promise.all([
            reserveFor(`run_c1_${round}`, "season_x1", "type2_init"),
            reserveFor(`run_c2_${round}`, "season_x2", "replace_request"),
          ]);
          expect(results.map((r) => r.status).sort()).toEqual(["already_active", "reserved"]);
          // Clear the winner so the next round races again from an idle title.
          const winner = results.find((r) => r.status === "reserved") as { snapshot: { workflowRun: { id: string } } };
          const done = await repo.getWorkflowRunSnapshot(winner.snapshot.workflowRun.id);
          await repo.saveWorkflowRunSnapshot({ ...done!, workflowRun: { ...done!.workflowRun, status: "succeeded", finishedAt: "2026-06-11T03:00:00.000Z" } });
        }
      });

      it("blockIfTitleHasActiveKinds refuses only while a run of those kinds is active for the title", async () => {
        const repo = await fresh();
        const base = workflowPersistenceFixture();
        const forSeason = (id: string, seasonNumber: number, kind: "type3_monitor" | "replace_request", over: Record<string, unknown> = {}) =>
          reIded(id, {
            season: { ...base.season, id: `season_k${seasonNumber}`, seasonNumber },
            workflowRun: { ...base.workflowRun, id, kind, status: "queued" as const, trackedSeasonId: `season_k${seasonNumber}`, finishedAt: null },
            episodes: [],
            connectedStorageId: "cs_kinds",
            ...over,
          });
        // A type3 run on season 1 does not block type3 on season 2.
        expect((await repo.reserveWorkflowRun(forSeason("run_k1", 1, "type3_monitor"))).status).toBe("reserved");
        expect(
          (await repo.reserveWorkflowRun(forSeason("run_k2", 2, "type3_monitor", { blockIfTitleHasActiveKinds: ["replace_request"] }))).status,
        ).toBe("reserved");
        // An active replace_request (on season 1) blocks type3 on season 3 with the option...
        expect((await repo.reserveWorkflowRun(forSeason("run_rr", 1, "replace_request"))).status).toBe("reserved");
        const blocked = await repo.reserveWorkflowRun(
          forSeason("run_k3", 3, "type3_monitor", { blockIfTitleHasActiveKinds: ["replace_request"] }),
        );
        expect(blocked.status).toBe("already_active");
        expect((blocked as { snapshot: { workflowRun: { id: string } } }).snapshot.workflowRun.id).toBe("run_rr");
        // ...and not without it.
        expect((await repo.reserveWorkflowRun(forSeason("run_k3", 3, "type3_monitor"))).status).toBe("reserved");
        // Another drive's replace_request does not block.
        expect(
          (await repo.reserveWorkflowRun(
            forSeason("run_k4", 4, "type3_monitor", { connectedStorageId: "cs_other", blockIfTitleHasActiveKinds: ["replace_request"] }),
          )).status,
        ).toBe("reserved");
      });

      it("blockIfTitleHasActiveRun does not let a queued staging_recovery pin the title", async () => {
        const repo = await fresh();
        const base = workflowPersistenceFixture();
        const queued = (
          id: string,
          titleId: string,
          seasonNumber: number,
          kind: "staging_recovery" | "type2_init" | "type3_monitor" | "replace_request" | "movie_init",
          over: Record<string, unknown> = {},
        ) =>
          reIded(id, {
            title: { ...base.title, id: titleId },
            season: { ...base.season, id: `${titleId}_s${seasonNumber}`, mediaTitleId: titleId, seasonNumber },
            workflowRun: {
              ...base.workflowRun,
              id,
              kind,
              status: "queued" as const,
              trackedSeasonId: `${titleId}_s${seasonNumber}`,
              finishedAt: null,
              auditEvents: [],
            },
            episodes: [],
            connectedStorageId: "cs_pin",
            ...over,
          });
        expect((await repo.reserveWorkflowRun(queued("run_pin_recovery", "title_pin", 1, "staging_recovery"))).status).toBe("reserved");
        // User acquire sets this flag. A leftover recovery must not refuse it.
        expect(
          (await repo.reserveWorkflowRun(queued("run_pin_user", "title_pin", 2, "type2_init", { blockIfTitleHasActiveRun: true }))).status,
        ).toBe("reserved");
        // A real user run still pins the title.
        expect(
          (await repo.reserveWorkflowRun(queued("run_pin_again", "title_pin", 3, "movie_init", { blockIfTitleHasActiveRun: true }))).status,
        ).toBe("already_active");
        // Replace, on its own title, is likewise not pinned by a recovery.
        expect((await repo.reserveWorkflowRun(queued("run_rep_recovery", "title_replace", 1, "staging_recovery"))).status).toBe("reserved");
        expect(
          (await repo.reserveWorkflowRun(queued("run_rep_user", "title_replace", 2, "replace_request", { blockIfTitleHasActiveRun: true }))).status,
        ).toBe("reserved");
        // The janitor lists every kind, so a recovery still refuses another recovery.
        expect((await repo.reserveWorkflowRun(queued("run_jan_recovery", "title_janitor", 1, "staging_recovery"))).status).toBe("reserved");
        expect(
          (await repo.reserveWorkflowRun(
            queued("run_jan_again", "title_janitor", 2, "staging_recovery", {
              blockIfTitleHasActiveKinds: [
                "type1_package_init",
                "type2_init",
                "type3_monitor",
                "movie_init",
                "replace_request",
                "staging_recovery",
              ],
            }),
          )).status,
        ).toBe("already_active");
        // Patrol blocks only on replace_request.
        expect((await repo.reserveWorkflowRun(queued("run_pat_recovery", "title_patrol", 1, "staging_recovery"))).status).toBe("reserved");
        expect(
          (await repo.reserveWorkflowRun(
            queued("run_pat_user", "title_patrol", 2, "type3_monitor", { blockIfTitleHasActiveKinds: ["replace_request"] }),
          )).status,
        ).toBe("reserved");
      });

      it("blockIfEpisodeStatesExist returns already_has_episode_state when the scoped bucket is non-empty", async () => {
        const repo = await fresh();
        // Seed episode states via a TERMINAL (succeeded) run so the active-run check
        // (which precedes the episode-state check) does not short-circuit to
        // already_active — mirrors the oracle's own already_has_episode_state test.
        await repo.saveWorkflowRunSnapshot(workflowPersistenceFixture());
        const blocked = await repo.reserveWorkflowRun(
          reIded("run_d", { blockIfEpisodeStatesExist: true }),
        );
        expect(blocked.status).toBe("already_has_episode_state");
      });

      it("does NOT block reserving the same title on a DIFFERENT drive (cross-drive isolation)", async () => {
        const repo = await fresh();
        await repo.reserveWorkflowRun(reIded("run_A", { connectedStorageId: "cs_A" }));
        const onB = await repo.reserveWorkflowRun(
          reIded("run_B", { connectedStorageId: "cs_B", blockIfEpisodeStatesExist: true }),
        );
        expect(onB.status).toBe("reserved"); // cs_B is a different bucket
      });

      it("re-persist without connectedStorageId preserves the run's original storage", async () => {
        const repo = await fresh();
        const snap = reIded("run_e");
        await repo.saveWorkflowRunSnapshot({ ...snap, connectedStorageId: "cs_keep" });
        await repo.saveWorkflowRunSnapshot({ ...snap }); // omit connectedStorageId
        const got = await repo.getWorkflowRunSnapshot("run_e");
        expect(got?.connectedStorageId).toBe("cs_keep");
      });

      it("re-persist without connectedStorageId writes episodes into the run's ORIGINAL storage bucket", async () => {
        const repo = await fresh();
        const snap = reIded("run_f");
        await repo.saveWorkflowRunSnapshot({ ...snap, connectedStorageId: "cs_keep" });
        // Finalize path: re-persist omits the storage but flips episode 2 to obtained.
        const updatedEpisodes = snap.episodes.map((episode) =>
          episode.episodeCode === "S01E02"
            ? { ...episode, airStatus: "aired" as const, obtained: true, verifiedFileIds: ["file_2"] }
            : episode,
        );
        await repo.saveWorkflowRunSnapshot({ ...snap, episodes: updatedEpisodes });
        const got = await repo.getWorkflowRunSnapshot("run_f");
        // The update must land in the cs_keep bucket the run was persisted onto —
        // not a parallel unscoped bucket that reads never resolve.
        expect(got?.obtainedEpisodes).toContain("S01E02");
      });
    });

    describe("claim + active queries", () => {
      // Build a standalone queued run for a UNIQUE (season, drive) bucket so several
      // can coexist without tripping the same-season active-run guard. Episodes +
      // children are cleared and re-parented so the re-ided season stays coherent
      // (validateWorkflowRunSnapshot rejects orphaned episodes/attempts otherwise).
      const queued = (
        id: string,
        over: {
          startedAt?: string;
          kind?: string;
          /** null = a run with no bound drive. */
          connectedStorageId?: string | null;
          nextAttemptAt?: string;
        } = {},
      ) => {
        const base = workflowPersistenceFixture();
        const seasonId = `season_${id}`;
        return {
          ...base,
          connectedStorageId: over.connectedStorageId === undefined ? `cs_${id}` : over.connectedStorageId,
          season: { ...base.season, id: seasonId },
          workflowRun: {
            ...base.workflowRun,
            id,
            trackedSeasonId: seasonId,
            status: "queued" as const,
            finishedAt: null,
            startedAt: over.startedAt ?? base.workflowRun.startedAt,
            ...(over.kind ? { kind: over.kind as typeof base.workflowRun.kind } : {}),
            ...(over.nextAttemptAt ? { nextAttemptAt: over.nextAttemptAt } : {}),
          },
          episodes: [],
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        };
      };

      it("claims the OLDEST queued run of the kind first, then the next, then null", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(queued("older", { startedAt: "2026-06-11T00:00:00.000Z" }));
        await repo.saveWorkflowRunSnapshot(queued("newer", { startedAt: "2026-06-11T00:05:00.000Z" }));

        const now = "2026-06-11T01:00:00.000Z";
        const first = await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now });
        expect(first?.workflowRun.id).toBe("older");
        expect(first?.workflowRun.status).toBe("running");

        const second = await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now });
        expect(second?.workflowRun.id).toBe("newer");
        expect(second?.workflowRun.status).toBe("running");

        // Both drained (now running) → a third claim finds nothing queued.
        const third = await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now });
        expect(third).toBeNull();
      });

      // The worker runs queued runs on different drives side by side, never two on one
      // drive: it passes the drives that already have a run going.
      it("skips queued runs on drives that already have a run going", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queued("on-busy", { startedAt: "2026-06-11T00:00:00.000Z", connectedStorageId: "cs_busy" }),
        );
        await repo.saveWorkflowRunSnapshot(
          queued("on-free", { startedAt: "2026-06-11T00:05:00.000Z", connectedStorageId: "cs_free" }),
        );
        const now = "2026-06-11T01:00:00.000Z";

        const claimed = await repo.claimNextQueuedWorkflowRun({
          kind: "type2_init",
          now,
          excludeConnectedStorageIds: ["cs_busy"],
        });
        expect(claimed?.workflowRun.id).toBe("on-free");
        expect(claimed?.connectedStorageId).toBe("cs_free");
        expect(
          await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now, excludeConnectedStorageIds: ["cs_busy"] }),
        ).toBeNull();
        // Skipped, not dropped: claimable again once its drive is free.
        expect((await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now }))?.workflowRun.id).toBe("on-busy");
      });

      it("skips runs with no bound drive only when asked; a drive list never hides them", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queued("unbound", { startedAt: "2026-06-11T00:00:00.000Z", connectedStorageId: null }),
        );
        await repo.saveWorkflowRunSnapshot(
          queued("bound", { startedAt: "2026-06-11T00:05:00.000Z", connectedStorageId: "cs_bound" }),
        );
        const now = "2026-06-11T01:00:00.000Z";

        const bound = await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now, excludeUnbound: true });
        expect(bound?.workflowRun.id).toBe("bound");
        // NULL is not "in" a list: excluding other drives must still find the unbound run.
        const unbound = await repo.claimNextQueuedWorkflowRun({
          kind: "type2_init",
          now,
          excludeConnectedStorageIds: ["cs_other"],
        });
        expect(unbound?.workflowRun.id).toBe("unbound");
        expect(unbound?.connectedStorageId).toBeNull();
      });

      it("claims an immediately-claimable run and does not pick a later gated one", async () => {
        const repo = await fresh();
        // A claimable run (older startedAt) alongside one gated by a FUTURE
        // nextAttemptAt (newer startedAt). Every engine claims the claimable run:
        //  - the gating-aware engines (SQLite/Postgres via claimableQueuedRuns) filter
        //    the gated run out entirely;
        //  - the InMemory oracle ignores nextAttemptAt but its FIFO-by-startedAt still
        //    picks the older claimable run first.
        // NOTE: the InMemory oracle does NOT honor nextAttemptAt, so a "gated-run-ALONE
        // → null" scenario legitimately diverges across engines and is intentionally
        // NOT asserted here — the pure gate is unit-tested in run-retry-transitions.test.ts.
        await repo.saveWorkflowRunSnapshot(
          queued("claimable", { startedAt: "2026-06-11T00:00:00.000Z" }),
        );
        await repo.saveWorkflowRunSnapshot(
          queued("gated", {
            startedAt: "2026-06-11T00:05:00.000Z",
            nextAttemptAt: "2030-01-01T00:00:00.000Z",
          }),
        );

        const claimed = await repo.claimNextQueuedWorkflowRun({
          kind: "type2_init",
          now: "2026-06-11T01:00:00.000Z",
        });
        expect(claimed?.workflowRun.id).toBe("claimable");
      });

      it("requeueRunningWorkflowRuns turns a running run back to queued and returns the count", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(queued("q1", { startedAt: "2026-06-11T00:00:00.000Z" }));
        // Claim it → running.
        await repo.claimNextQueuedWorkflowRun({ kind: "type2_init", now: "2026-06-11T01:00:00.000Z" });
        expect((await repo.getWorkflowRunSnapshot("q1"))?.workflowRun.status).toBe("running");

        const count = await repo.requeueRunningWorkflowRuns("2026-06-11T02:00:00.000Z");
        expect(count).toBe(1);
        const requeued = await repo.getWorkflowRunSnapshot("q1");
        expect(requeued?.workflowRun.status).toBe("queued");
        expect(requeued?.workflowRun.finishedAt).toBeNull();
        expect(requeued?.workflowRun.orphanRequeueCount).toBe(1);
      });

      it("requeueRunningWorkflowRuns fails a poison run once orphan cap is hit", async () => {
        const repo = await fresh();
        const snap = queued("poison", { startedAt: "2026-06-11T00:00:00.000Z" });
        // Seed already at the cap as a running orphan.
        await repo.saveWorkflowRunSnapshot({
          ...snap,
          workflowRun: {
            ...snap.workflowRun,
            id: "poison",
            status: "running",
            finishedAt: null,
            orphanRequeueCount: 5,
          },
        });
        const count = await repo.requeueRunningWorkflowRuns("2026-06-11T03:00:00.000Z");
        expect(count).toBe(0);
        const failed = await repo.getWorkflowRunSnapshot("poison");
        expect(failed?.workflowRun.status).toBe("failed");
        expect(failed?.workflowRun.finishedAt).toBe("2026-06-11T03:00:00.000Z");
        expect(
          failed?.workflowRun.auditEvents.some((event) => event.type === "orphan_requeue_capped"),
        ).toBe(true);
      });

      it("requeueRunningWorkflowRuns: a replace run at the cap is failed and hands its messages back; a requeued one keeps them", async () => {
        const repo = await fresh();
        const work = { accountId: "acct_default", drive: "cs_rr", titleKey: "tmdb_tv_rr" };
        for (const [id, count] of [["rr_capped", 5], ["rr_requeued", 0]] as const) {
          const snap = queued(id, { startedAt: "2026-06-11T00:00:00.000Z", connectedStorageId: "cs_rr" });
          await repo.saveWorkflowRunSnapshot({
            ...snap,
            workflowRun: { ...snap.workflowRun, id, kind: "replace_request", status: "running", finishedAt: null, orphanRequeueCount: count },
          });
          const titleKey = `${work.titleKey}_${id}`;
          await repo.createUserMessage({ ...work, titleKey, body: id, episodeTags: [], now: "2026-06-11T00:00:00.000Z" });
          await repo.claimUserMessages({ ...work, titleKey, runId: id, now: "2026-06-11T00:00:00.000Z" });
        }

        expect(await repo.requeueRunningWorkflowRuns("2026-06-11T03:00:00.000Z")).toBe(1);
        expect((await repo.getWorkflowRunSnapshot("rr_capped", { accountId: "acct_default", connectedStorageId: "cs_rr" }))?.workflowRun.status).toBe("failed");
        // Not urgent: a run that crashed the worker five times waits for the patrol or 现在处理.
        expect((await repo.listUserMessages({ ...work, titleKey: `${work.titleKey}_rr_capped` }))[0]).toMatchObject({ status: "pending", urgent: false, runId: null });
        expect((await repo.listUserMessages({ ...work, titleKey: `${work.titleKey}_rr_requeued` }))[0]).toMatchObject({ status: "processing", runId: "rr_requeued" });
      });

      it("requeueRunningWorkflowRuns: a replace run failed at the cap also takes the urgency off the rest of its work's pending messages", async () => {
        const repo = await fresh();
        const snap = queued("rr_cap_work", { startedAt: "2026-06-11T00:00:00.000Z", connectedStorageId: "cs_rw" });
        await repo.saveWorkflowRunSnapshot({
          ...snap,
          workflowRun: { ...snap.workflowRun, kind: "replace_request", status: "running", finishedAt: null, orphanRequeueCount: 5 },
        });
        // The run's own work: its title on its drive.
        const work = { accountId: "acct_default", drive: "cs_rw", titleKey: snap.title.id };
        const other = { ...work, titleKey: "title_untouched" };
        await repo.createUserMessage({ ...work, body: "claimed", episodeTags: [], now: "2026-06-11T00:00:00.000Z" });
        await repo.claimUserMessages({ ...work, runId: "rr_cap_work", now: "2026-06-11T00:00:00.000Z" });
        await repo.createUserMessage({ ...work, body: "written mid-run", episodeTags: [], now: "2026-06-11T00:00:05.000Z" });
        await repo.createUserMessage({ ...other, body: "another work", episodeTags: [], now: "2026-06-11T00:00:00.000Z" });
        await repo.markUserMessagesUrgent({ ...other, now: "2026-06-11T00:00:00.000Z" });

        expect(await repo.requeueRunningWorkflowRuns("2026-06-11T03:00:00.000Z")).toBe(0);

        expect((await repo.listUserMessages(work)).map((m) => [m.body, m.status, m.urgent])).toEqual([
          ["written mid-run", "pending", false],
          ["claimed", "pending", false],
        ]);
        expect(await repo.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([other]);
      });

      it("requeueRunningWorkflowRuns terminates an orphaned type3_monitor instead of queueing it", async () => {
        const repo = await fresh();
        const snap = queued("orphan3", { startedAt: "2026-06-11T00:00:00.000Z" });
        await repo.saveWorkflowRunSnapshot({
          ...snap,
          workflowRun: {
            ...snap.workflowRun,
            id: "orphan3",
            kind: "type3_monitor",
            status: "running",
            finishedAt: null,
          },
        });

        const count = await repo.requeueRunningWorkflowRuns("2026-06-11T02:00:00.000Z");
        expect(count).toBe(0);

        const recovered = await repo.getWorkflowRunSnapshot("orphan3");
        expect(recovered?.workflowRun.status).toBe("failed");
        expect(recovered?.workflowRun.finishedAt).toBe("2026-06-11T02:00:00.000Z");
        // Assert both presence and position: `.some` matches the neighbouring
        // poison-cap test's convention and survives a future trailing event,
        // while `.at(-1)` additionally pins that recovery appended it last.
        expect(recovered?.workflowRun.auditEvents.some((e) => e.type === "orphan_unclaimable")).toBe(
          true,
        );
        expect(recovered?.workflowRun.auditEvents.at(-1)?.type).toBe("orphan_unclaimable");
        // The unclaimable path must NOT pretend a requeue happened.
        expect(
          recovered?.workflowRun.auditEvents.some((e) => e.type === "orphan_requeued"),
        ).toBe(false);
      });

      it("a recovered type3_monitor no longer blocks the season from being reserved again", async () => {
        const repo = await fresh();
        const snap = queued("orphan3b", { startedAt: "2026-06-11T00:00:00.000Z" });
        await repo.saveWorkflowRunSnapshot({
          ...snap,
          workflowRun: {
            ...snap.workflowRun,
            id: "orphan3b",
            kind: "type3_monitor",
            status: "running",
            finishedAt: null,
          },
        });
        await repo.requeueRunningWorkflowRuns("2026-06-11T02:00:00.000Z");

        // Reserving the same season + kind must now succeed rather than report
        // already_active — that was the user-visible hang: patrol permanently
        // blocked by a dead run. Deliberately no stale-expiry field is passed,
        // so this proves the fix works on its own rather than leaning on the
        // 30-minute stale sweep (which also deletes episode_states).
        const reservation = await repo.reserveWorkflowRun({
          connectedStorageId: snap.connectedStorageId,
          title: snap.title,
          season: snap.season,
          workflowRun: {
            ...snap.workflowRun,
            id: "fresh3",
            kind: "type3_monitor",
            status: "running",
            trackedSeasonId: snap.season.id,
            startedAt: "2026-06-11T03:00:00.000Z",
            finishedAt: null,
            auditEvents: [
              { type: "type3_scheduled", message: "Scheduled Type 3 monitoring reserved" },
            ],
          },
          episodes: snap.episodes,
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });
        // Pin the positive status, not merely "not already_active":
        // WorkflowRunReservationResult has a third arm (already_has_episode_state),
        // so a negative assertion would silently pass on it.
        expect(reservation.status).toBe("reserved");
      });

      it("pruneFinishedWorkflowRuns drops old finished runs and keeps active ones", async () => {
        const repo = await fresh();
        const old = queued("old_done", { startedAt: "2026-05-01T00:00:00.000Z" });
        await repo.saveWorkflowRunSnapshot({
          ...old,
          workflowRun: {
            ...old.workflowRun,
            id: "old_done",
            status: "succeeded",
            finishedAt: "2026-05-01T01:00:00.000Z",
          },
        });
        const recent = queued("recent_done", { startedAt: "2026-06-10T00:00:00.000Z" });
        await repo.saveWorkflowRunSnapshot({
          ...recent,
          workflowRun: {
            ...recent.workflowRun,
            id: "recent_done",
            status: "succeeded",
            finishedAt: "2026-06-10T01:00:00.000Z",
          },
        });
        await repo.saveWorkflowRunSnapshot(queued("still_queued", { startedAt: "2026-06-11T00:00:00.000Z" }));

        const pruned = await repo.pruneFinishedWorkflowRuns("2026-06-01T00:00:00.000Z");
        expect(pruned).toBe(1);
        expect(await repo.getWorkflowRunSnapshot("old_done")).toBeNull();
        expect(await repo.getWorkflowRunSnapshot("recent_done")).not.toBeNull();
        expect(await repo.getWorkflowRunSnapshot("still_queued")).not.toBeNull();
      });

      it("findActiveWorkflowRun matches (season, kind) and rejects a different scope", async () => {
        const repo = await fresh();
        const snap = queued("find", { startedAt: "2026-06-11T00:00:00.000Z" });
        await repo.saveWorkflowRunSnapshot(snap);

        const found = await repo.findActiveWorkflowRun({
          trackedSeasonId: snap.season.id,
          kind: "type2_init",
          accountId: "acct_default",
          connectedStorageId: snap.connectedStorageId,
        });
        expect(found?.workflowRun.id).toBe("find");

        // Wrong kind → none.
        expect(
          await repo.findActiveWorkflowRun({
            trackedSeasonId: snap.season.id,
            kind: "movie_init",
            accountId: "acct_default",
            connectedStorageId: snap.connectedStorageId,
          }),
        ).toBeNull();
        // Wrong drive scope → none.
        expect(
          await repo.findActiveWorkflowRun({
            trackedSeasonId: snap.season.id,
            kind: "type2_init",
            accountId: "acct_default",
            connectedStorageId: "cs_other",
          }),
        ).toBeNull();
      });

      it("listActiveWorkflowRuns returns queued+running for the scope, excludes terminal, newest-first", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_shared" };
        // Two active runs (different seasons, same drive) + one terminal run.
        await repo.saveWorkflowRunSnapshot(
          queued("act_old", { startedAt: "2026-06-11T00:00:00.000Z", connectedStorageId: "cs_shared" }),
        );
        await repo.saveWorkflowRunSnapshot(
          queued("act_new", { startedAt: "2026-06-11T00:05:00.000Z", connectedStorageId: "cs_shared" }),
        );
        // Terminal (succeeded) run on the same drive — must be excluded.
        const done = queued("done", { startedAt: "2026-06-11T00:03:00.000Z", connectedStorageId: "cs_shared" });
        await repo.saveWorkflowRunSnapshot({
          ...done,
          workflowRun: {
            ...done.workflowRun,
            status: "succeeded" as const,
            finishedAt: "2026-06-11T00:04:00.000Z",
          },
        });

        const active = await repo.listActiveWorkflowRuns(scope);
        expect(active.map((snapshot) => snapshot.workflowRun.id)).toEqual(["act_new", "act_old"]);
      });
    });

    describe("tracked-season + episode queries", () => {
      // A fully self-contained snapshot for a UNIQUE (title, season, drive) tuple.
      // Re-ids the title/season/run so several coexist; children are dropped/re-parented
      // so validateWorkflowRunSnapshot accepts the re-ided run. Episodes are carried on
      // the fixture's default (S01E01 obtained + S01E02) unless overridden.
      const trackedSnapshot = (over: {
        key: string;
        titleName?: string;
        seasonNumber?: number;
        accountId?: string;
        connectedStorageId?: string;
        startedAt?: string;
        runId?: string;
      }) => {
        const base = workflowPersistenceFixture();
        const titleId = `title_${over.key}`;
        const seasonId = `season_${over.key}`;
        return {
          accountId: over.accountId ?? "acct_default",
          connectedStorageId: over.connectedStorageId ?? "cs_default",
          title: { ...base.title, id: titleId, title: over.titleName ?? base.title.title },
          season: {
            ...base.season,
            id: seasonId,
            mediaTitleId: titleId,
            seasonNumber: over.seasonNumber ?? base.season.seasonNumber,
          },
          workflowRun: {
            ...base.workflowRun,
            id: over.runId ?? `run_${over.key}`,
            trackedSeasonId: seasonId,
            startedAt: over.startedAt ?? base.workflowRun.startedAt,
          },
          episodes: base.episodes.map((episode) => ({ ...episode, trackedSeasonId: seasonId })),
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        };
      };

      it("getTrackedSeasonState returns the LATEST run's state for the season", async () => {
        const repo = await fresh();
        const seasonKey = "latest";
        // Two runs for the SAME (season, drive), different startedAt.
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: seasonKey, runId: "run_old", startedAt: "2026-06-11T00:00:00.000Z" }),
        );
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: seasonKey, runId: "run_new", startedAt: "2026-06-12T00:00:00.000Z" }),
        );
        const state = await repo.getTrackedSeasonState(`season_${seasonKey}`, {
          accountId: "acct_default",
          connectedStorageId: "cs_default",
        });
        expect(state).not.toBeNull();
        expect(state?.season.id).toBe(`season_${seasonKey}`);
        expect(state?.connectedStorageId).toBe("cs_default");
        // Episodes come from the season+drive bucket: S01E01 obtained + S01E02.
        expect(state?.episodes.map((episode) => episode.episodeCode)).toEqual(["S01E01", "S01E02"]);
        expect(state?.episodes.find((episode) => episode.episodeCode === "S01E01")?.obtained).toBe(true);
        // Unknown season → null.
        expect(
          await repo.getTrackedSeasonState("season_missing", {
            accountId: "acct_default",
            connectedStorageId: "cs_default",
          }),
        ).toBeNull();
      });

      it("hides a legacy staging-janitor inbox row and still returns a real staging_recovery", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_default" };
        const real = trackedSnapshot({ key: "show", runId: "run_show_done", startedAt: "2026-09-27T00:00:00.000Z" });
        await repo.saveWorkflowRunSnapshot(real);
        await repo.saveWorkflowRunSnapshot({
          ...real,
          workflowRun: {
            ...real.workflowRun,
            id: "recovery-real",
            kind: "staging_recovery",
            status: "queued",
            finishedAt: null,
            startedAt: "2026-09-28T03:00:00.000Z",
            auditEvents: [
              {
                type: "staging_recovery_queued",
                message: "queued",
                data: { stagingDirectoryId: "stg-real" },
              },
            ],
          },
        });
        const legacyBase = trackedSnapshot({ key: "janitor" });
        const legacyTitleId = "staging-janitor-title:drive1";
        const legacySeasonId = "staging-janitor-season:drive1";
        await repo.saveWorkflowRunSnapshot({
          ...legacyBase,
          title: { ...legacyBase.title, id: legacyTitleId, title: "暂存残留" },
          season: { ...legacyBase.season, id: legacySeasonId, mediaTitleId: legacyTitleId },
          workflowRun: {
            ...legacyBase.workflowRun,
            id: "staging-janitor:drive1",
            trackedSeasonId: legacySeasonId,
            kind: "type3_monitor",
            status: "succeeded",
          },
          episodes: legacyBase.episodes.map((episode) => ({ ...episode, trackedSeasonId: legacySeasonId })),
        });

        const listed = await repo.listTrackedSeasonStates(scope);
        expect(listed.map((state) => state.season.id)).toContain("season_show");
        expect(listed.map((state) => state.season.id)).not.toContain(legacySeasonId);
        expect(await repo.getTrackedSeasonState(legacySeasonId, scope)).toBeNull();
        expect((await repo.getTrackedSeasonState("season_show", scope))?.title.id).toBe("title_show");
        expect((await repo.listAllTrackedSeasonStates()).map((state) => state.season.id)).not.toContain(legacySeasonId);
        const claimed = await repo.claimNextQueuedWorkflowRun({ kind: "staging_recovery", now: "2026-09-28T04:00:00.000Z" });
        expect(claimed?.workflowRun.id).toBe("recovery-real");
        expect(claimed?.workflowRun.trackedSeasonId).toBe("season_show");
      });

      it("listTrackedSeasonStates returns seasons ordered by compareTrackedSeasonStates (title, season, id)", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: "zulu", titleName: "Zulu", connectedStorageId: "cs_default" }),
        );
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: "alpha", titleName: "Alpha", connectedStorageId: "cs_default" }),
        );
        const states = await repo.listTrackedSeasonStates({
          accountId: "acct_default",
          connectedStorageId: "cs_default",
        });
        expect(states.map((state) => state.title.title)).toEqual(["Alpha", "Zulu"]);
      });

      it("listTrackedSeasonStates isolates by drive scope", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: "onA", connectedStorageId: "cs_A" }),
        );
        const onB = await repo.listTrackedSeasonStates({
          accountId: "acct_default",
          connectedStorageId: "cs_B",
        });
        expect(onB).toHaveLength(0);
        const onA = await repo.listTrackedSeasonStates({
          accountId: "acct_default",
          connectedStorageId: "cs_A",
        });
        expect(onA.map((state) => state.season.id)).toEqual(["season_onA"]);
      });

      it("listAllTrackedSeasonStates returns seasons across accounts, each with its own accountId", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: "acctA", titleName: "Alpha", accountId: "acct_A", connectedStorageId: "cs_A" }),
        );
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: "acctB", titleName: "Bravo", accountId: "acct_B", connectedStorageId: "cs_B" }),
        );
        const all = await repo.listAllTrackedSeasonStates();
        const bySeason = new Map(all.map((state) => [state.season.id, state]));
        expect(bySeason.get("season_acctA")?.accountId).toBe("acct_A");
        expect(bySeason.get("season_acctB")?.accountId).toBe("acct_B");
        // Ordered by title.
        expect(all.map((state) => state.title.title)).toEqual(["Alpha", "Bravo"]);
      });

      it("findActiveStagingRecovery returns the queued run for that leftover dir and not a finished one", async () => {
        const repo = await fresh();
        const storageId = "cs_recovery";
        const scope = { accountId: "acct_default", connectedStorageId: storageId };
        const base = trackedSnapshot({ key: "rec", titleName: "Recovered", connectedStorageId: storageId });
        await repo.saveWorkflowRunSnapshot({
          ...base,
          workflowRun: {
            ...base.workflowRun,
            id: "recovery_live",
            kind: "staging_recovery",
            status: "queued",
            auditEvents: [
              {
                type: "staging_recovery_queued",
                message: "queued",
                data: { stagingDirectoryId: "stg_live", showDirectoryId: "show_rec", seasonNumbers: [1] },
              },
            ],
          },
          notifications: [],
        });
        await repo.saveWorkflowRunSnapshot({
          ...trackedSnapshot({ key: "done", titleName: "Done", connectedStorageId: storageId }),
          workflowRun: {
            id: "recovery_done",
            kind: "staging_recovery",
            status: "succeeded",
            trackedSeasonId: "season_done",
            startedAt: "2026-09-27T03:00:00.000Z",
            finishedAt: "2026-09-27T04:00:00.000Z",
            auditEvents: [
              {
                type: "staging_recovery_queued",
                message: "queued",
                data: { stagingDirectoryId: "stg_done", showDirectoryId: "show_done", seasonNumbers: [1] },
              },
            ],
          },
        });
        const live = await repo.findActiveStagingRecovery({ ...scope, stagingDirectoryId: "stg_live" });
        expect(live?.workflowRun.id).toBe("recovery_live");
        expect(await repo.findActiveStagingRecovery({ ...scope, stagingDirectoryId: "stg_done" })).toBeNull();
        expect(await repo.findActiveStagingRecovery({ ...scope, stagingDirectoryId: "stg_other" })).toBeNull();
        expect(
          await repo.findActiveStagingRecovery({
            accountId: "acct_default",
            connectedStorageId: "cs_other",
            stagingDirectoryId: "stg_live",
          }),
        ).toBeNull();
        const active = await repo.listActiveWorkflowRuns(scope);
        expect(active.map((run) => run.workflowRun.id)).toContain("recovery_live");
        expect(active.map((run) => run.workflowRun.id)).not.toContain("recovery_done");
      });

      it("listEpisodeStates returns the drive's episodes for a concrete scope", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          trackedSnapshot({ key: "eps", connectedStorageId: "cs_default" }),
        );
        const episodes = await repo.listEpisodeStates("season_eps", {
          accountId: "acct_default",
          connectedStorageId: "cs_default",
        });
        expect(episodes.map((episode) => episode.episodeCode)).toEqual(["S01E01", "S01E02"]);
        expect(episodes.find((episode) => episode.episodeCode === "S01E01")?.obtained).toBe(true);
        // A different drive has no episodes for this season.
        expect(
          await repo.listEpisodeStates("season_eps", {
            accountId: "acct_default",
            connectedStorageId: "cs_other",
          }),
        ).toHaveLength(0);
      });
    });

    describe("agent_steps + progress", () => {
      const step = (ordinal: number, toolName: string) => ({
        ordinal,
        toolName,
        args: { keyword: "x" },
        activity: "搜",
        phase: "search" as const,
        at: "2026-06-22T00:00:00.000Z",
      });

      // NOTE: idempotency on (run, ordinal) is a PRODUCTION-engine invariant
      // (SQLite/Postgres ON CONFLICT DO NOTHING). The InMemory oracle intentionally
      // just pushes (no dedup), so a duplicate-ordinal append legitimately diverges
      // across engines and is asserted engine-specifically (repository-contract-sqlite
      // / agent-steps.pg), NOT in this shared contract.
      it("appends steps and lists them ordered by ordinal", async () => {
        const repo = await fresh();
        // Persist the run so its ownership row exists for the scope-gated read below.
        const snapshot = workflowPersistenceFixture();
        await repo.saveWorkflowRunSnapshot(snapshot);
        const runId = snapshot.workflowRun.id;

        await repo.appendAgentStep(runId, step(1, "transferCandidate"));
        await repo.appendAgentStep(runId, step(0, "searchResources"));
        const steps = await repo.listAgentSteps(runId);
        expect(steps.map((s) => s.ordinal)).toEqual([0, 1]);
        expect(steps[0]!.toolName).toBe("searchResources");
      });

      it("listAgentSteps is fail-closed on scope (wrong scope → [], correct scope → steps)", async () => {
        const repo = await fresh();
        const snapshot = workflowPersistenceFixture();
        await repo.saveWorkflowRunSnapshot(snapshot);
        const runId = snapshot.workflowRun.id;
        await repo.appendAgentStep(runId, step(0, "searchResources"));

        // Wrong account → not visible → [].
        expect(
          await repo.listAgentSteps(runId, { accountId: "acct_other", connectedStorageId: null }),
        ).toEqual([]);
        // Correct scope (the fixture run is owned by acct_default, unscoped storage) → steps.
        const visible = await repo.listAgentSteps(runId, {
          accountId: "acct_default",
          connectedStorageId: null,
        });
        expect(visible.map((s) => s.ordinal)).toEqual([0]);
      });

      it("clearAgentSteps empties the run's steps", async () => {
        const repo = await fresh();
        const snapshot = workflowPersistenceFixture();
        await repo.saveWorkflowRunSnapshot(snapshot);
        const runId = snapshot.workflowRun.id;
        await repo.appendAgentStep(runId, step(0, "searchResources"));
        await repo.appendAgentStep(runId, step(1, "transferCandidate"));
        await repo.clearAgentSteps(runId);
        expect(await repo.listAgentSteps(runId)).toEqual([]);
      });

      it("updateWorkflowRunProgress clamps percent monotonically; unknown run is a no-op", async () => {
        const repo = await fresh();
        const snapshot = workflowPersistenceFixture();
        await repo.saveWorkflowRunSnapshot(snapshot);
        const runId = snapshot.workflowRun.id;

        await repo.updateWorkflowRunProgress(runId, {
          activity: "转存",
          phase: "transfer",
          percent: 40,
          updatedAt: "2026-06-22T00:00:10.000Z",
        });
        expect((await repo.getWorkflowRunSnapshot(runId))?.workflowRun.progress?.percent).toBe(40);

        // Lower percent never rewinds the bar (monotonic clamp), but text follows latest.
        await repo.updateWorkflowRunProgress(runId, {
          activity: "整理(相位回退)",
          phase: "organize",
          percent: 20,
          updatedAt: "2026-06-22T00:00:20.000Z",
        });
        const clamped = (await repo.getWorkflowRunSnapshot(runId))?.workflowRun.progress;
        expect(clamped?.percent).toBe(40);
        expect(clamped?.activity).toBe("整理(相位回退)");

        // Higher percent advances.
        await repo.updateWorkflowRunProgress(runId, {
          activity: "完成收尾",
          phase: "finalize",
          percent: 70,
          updatedAt: "2026-06-22T00:00:30.000Z",
        });
        expect((await repo.getWorkflowRunSnapshot(runId))?.workflowRun.progress?.percent).toBe(70);

        // Unknown run → no-op (never throws).
        await expect(
          repo.updateWorkflowRunProgress("unknown_run", {
            activity: "x",
            phase: "search",
            percent: 5,
            updatedAt: "t",
          }),
        ).resolves.toBeUndefined();
      });
    });

    describe("notifications", () => {
      it("listNotifications returns a run's notification for its (account, storage) scope", async () => {
        const repo = await fresh();
        // The fixture run is owned by acct_default with an explicit drive here.
        await repo.saveWorkflowRunSnapshot({
          ...workflowPersistenceFixture(),
          connectedStorageId: "cs_notif",
        });
        const got = await repo.listNotifications({
          accountId: "acct_default",
          connectedStorageId: "cs_notif",
        });
        expect(got.map((n) => n.id)).toEqual(["notification_1"]);
      });

      it("listNotifications applies a future `since` cutoff (returns []) and a scope mismatch (returns [])", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot({
          ...workflowPersistenceFixture(),
          connectedStorageId: "cs_notif",
        });
        // since strictly after the notification's createdAt → filtered out.
        expect(
          await repo.listNotifications({
            accountId: "acct_default",
            connectedStorageId: "cs_notif",
            since: "2030-01-01T00:00:00.000Z",
          }),
        ).toEqual([]);
        // Wrong drive scope → not visible.
        expect(
          await repo.listNotifications({
            accountId: "acct_default",
            connectedStorageId: "cs_other",
          }),
        ).toEqual([]);
      });

      it("listRecentNotificationsWithAccount tags each notification with its owning account", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot({
          ...workflowPersistenceFixture(),
          accountId: "acct_default",
          connectedStorageId: "cs_notif",
        });
        const recent = await repo.listRecentNotificationsWithAccount();
        expect(recent).toHaveLength(1);
        expect(recent[0]?.accountId).toBe("acct_default");
        expect(recent[0]?.connectedStorageId).toBe("cs_notif");
        expect(recent[0]?.notification.id).toBe("notification_1");
      });

      it("hidden notification kinds are dropped before the limit", async () => {
        const repo = await fresh();
        const base = workflowPersistenceFixture();
        const ordinary = {
          id: "note_real",
          workflowRunId: base.workflowRun.id,
          kind: "tracking_initialized",
          title: "Show",
          body: "real",
          createdAt: "2026-09-01T00:00:00.000Z",
        };
        const hidden = Array.from({ length: 40 }, (_, index) => ({
          id: `note_hidden_${index}`,
          workflowRunId: base.workflowRun.id,
          kind: "staging_leftover",
          title: "hidden",
          body: "hidden",
          createdAt: `2026-09-28T00:${String(index).padStart(2, "0")}:00.000Z`,
        }));
        await repo.saveWorkflowRunSnapshot({
          ...base,
          accountId: "acct_default",
          connectedStorageId: "cs_hidden",
          notifications: [ordinary, ...hidden],
        });
        const listed = await repo.listNotifications({
          accountId: "acct_default",
          connectedStorageId: "cs_hidden",
          limit: 30,
        });
        expect(listed.map((notification) => notification.id)).toEqual(["note_real"]);
        const recent = await repo.listRecentNotificationsWithAccount({ limit: 30 });
        expect(recent.map((row) => row.notification.id)).toEqual(["note_real"]);
        expect(recent.some((row) => row.notification.kind === "staging_leftover" || row.notification.kind === "staging_recovery")).toBe(false);
      });

      it("listRecentNotificationsWithAccount surfaces unscoped runs as null, never the internal sentinel", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot({
          ...workflowPersistenceFixture(),
          accountId: "acct_default",
        });
        const recent = await repo.listRecentNotificationsWithAccount();
        expect(recent).toHaveLength(1);
        expect(recent[0]?.connectedStorageId).toBeNull();
      });
    });

    describe("lifecycle mutations", () => {
      // A standalone QUEUED run for a unique (season, drive) bucket, children cleared so
      // the re-ided run passes validateWorkflowRunSnapshot.
      const queuedRun = (over: {
        id: string;
        status?: "queued" | "running" | "failed" | "succeeded";
        connectedStorageId?: string;
        tmdbId?: number;
        type?: "movie" | "tv" | "anime";
        seasonNumber?: number;
      }) => {
        const base = workflowPersistenceFixture();
        const seasonId = `season_${over.id}`;
        const titleId = `title_${over.id}`;
        return {
          accountId: "acct_default",
          connectedStorageId: over.connectedStorageId ?? `cs_${over.id}`,
          title: {
            ...base.title,
            id: titleId,
            tmdbId: over.tmdbId ?? base.title.tmdbId,
            type: over.type ?? base.title.type,
          },
          season: {
            ...base.season,
            id: seasonId,
            mediaTitleId: titleId,
            seasonNumber: over.seasonNumber ?? base.season.seasonNumber,
          },
          workflowRun: {
            ...base.workflowRun,
            id: over.id,
            trackedSeasonId: seasonId,
            status: over.status ?? ("queued" as const),
            finishedAt: over.status === "succeeded" ? base.workflowRun.finishedAt : null,
          },
          episodes: base.episodes.map((e) => ({ ...e, trackedSeasonId: seasonId })),
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        };
      };

      it("cancelQueuedWorkflowRun cancels a QUEUED run and it disappears from reads", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(queuedRun({ id: "cancelme", connectedStorageId: "cs_c" }));
        const scope = { accountId: "acct_default", connectedStorageId: "cs_c" };
        expect((await repo.cancelQueuedWorkflowRun("cancelme", scope)).status).toBe("cancelled");
        expect(await repo.getWorkflowRunSnapshot("cancelme", scope)).toBeNull();
        expect(await repo.listActiveWorkflowRuns(scope)).toHaveLength(0);
      });

      it("cancelQueuedWorkflowRun of a replace_request only removes the run: the season stays tracked, its messages go back to pending", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_rc" };
        // A tracked, acquired season…
        await repo.saveWorkflowRunSnapshot(queuedRun({ id: "rc", status: "succeeded", connectedStorageId: "cs_rc" }));
        const tracked = await repo.getTrackedSeasonState("season_rc", scope);
        expect(tracked?.episodes.length).toBeGreaterThan(0);
        // …with a queued replace_request on it (sole active run) holding a message.
        const base = queuedRun({ id: "rc", connectedStorageId: "cs_rc" });
        await repo.saveWorkflowRunSnapshot({
          ...base,
          workflowRun: { ...base.workflowRun, id: "rc_replace", kind: "replace_request", startedAt: "2026-06-12T00:00:00.000Z" },
          episodes: tracked!.episodes,
        });
        const work = { accountId: "acct_default", drive: "cs_rc", titleKey: "title_rc" };
        await repo.createUserMessage({ ...work, body: "换", episodeTags: [], now: "2026-06-12T00:00:00.000Z" });
        await repo.claimUserMessages({ ...work, runId: "rc_replace", now: "2026-06-12T00:00:00.000Z" });

        expect((await repo.cancelQueuedWorkflowRun("rc_replace", scope)).status).toBe("cancelled");
        expect(await repo.getWorkflowRunSnapshot("rc_replace", scope)).toBeNull();
        const after = await repo.getTrackedSeasonState("season_rc", scope);
        expect(after?.episodes).toEqual(tracked!.episodes);
        expect(await repo.listTrackedSeasonStates(scope)).toHaveLength(1);
        // Back to pending but NOT urgent: the idle scan would re-queue it within seconds.
        expect((await repo.listUserMessages(work))[0]).toMatchObject({ status: "pending", urgent: false, runId: null });
      });

      it("cancelling a queued replace_request sticks: the work's urgent pending messages wait for the patrol", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_rs" };
        await repo.saveWorkflowRunSnapshot(queuedRun({ id: "rs", status: "succeeded", connectedStorageId: "cs_rs" }));
        const base = queuedRun({ id: "rs", connectedStorageId: "cs_rs" });
        await repo.saveWorkflowRunSnapshot({
          ...base,
          workflowRun: { ...base.workflowRun, id: "rs_replace", kind: "replace_request", startedAt: "2026-06-12T00:00:00.000Z" },
        });
        const work = { accountId: "acct_default", drive: "cs_rs", titleKey: "title_rs" };
        const other = { ...work, titleKey: "title_other" };
        // 现在处理 was pressed (urgent), and one more message came in after it.
        await repo.createUserMessage({ ...work, body: "换 1", episodeTags: [], now: "2026-06-12T00:00:00.000Z" });
        await repo.markUserMessagesUrgent({ ...work, now: "2026-06-12T00:00:01.000Z" });
        await repo.createUserMessage({ ...work, body: "也换 2", episodeTags: [], now: "2026-06-12T00:00:02.000Z" });
        await repo.markUserMessagesUrgent({ ...work, now: "2026-06-12T00:00:03.000Z" });
        // Another work's urgent message is not the user's cancel.
        await repo.createUserMessage({ ...other, body: "别动我", episodeTags: [], now: "2026-06-12T00:00:00.000Z" });
        await repo.markUserMessagesUrgent({ ...other, now: "2026-06-12T00:00:01.000Z" });

        expect((await repo.cancelQueuedWorkflowRun("rs_replace", scope)).status).toBe("cancelled");

        expect((await repo.listUserMessages(work)).map((m) => [m.status, m.urgent])).toEqual([
          ["pending", false],
          ["pending", false],
        ]);
        expect(await repo.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([other]);
        expect(await repo.listWorksWithPendingMessages({ urgentOnly: false })).toEqual(expect.arrayContaining([work, other]));
      });

      it("cancelQueuedWorkflowRun of the ONLY run of a replace_request season still leaves the tracking", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_rc2" };
        const base = queuedRun({ id: "rc2", connectedStorageId: "cs_rc2" });
        await repo.saveWorkflowRunSnapshot({ ...base, workflowRun: { ...base.workflowRun, kind: "replace_request" } });
        expect((await repo.cancelQueuedWorkflowRun("rc2", scope)).status).toBe("cancelled");
        expect((await repo.listEpisodeStates("season_rc2", scope)).length).toBeGreaterThan(0);
      });

      it("cancelQueuedWorkflowRun refuses a non-queued (succeeded) run", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queuedRun({ id: "donerun", status: "succeeded", connectedStorageId: "cs_d" }),
        );
        expect(
          (
            await repo.cancelQueuedWorkflowRun("donerun", {
              accountId: "acct_default",
              connectedStorageId: "cs_d",
            })
          ).status,
        ).toBe("not_cancellable");
      });

      it("untrackTitle removes a tracked tv season by tmdbId + mediaKind", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queuedRun({ id: "utv", status: "succeeded", connectedStorageId: "cs_u", tmdbId: 555, type: "tv" }),
        );
        const scope = { accountId: "acct_default", connectedStorageId: "cs_u" };
        const result = await repo.untrackTitle(555, scope, "tv");
        expect(result).toEqual({ status: "untracked", removedSeasons: 1 });
        expect(await repo.listTrackedSeasonStates(scope)).toHaveLength(0);
      });

      it("untrackTitle returns not_found for a mismatched mediaKind (movie vs tv namespace)", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queuedRun({ id: "utv2", status: "succeeded", connectedStorageId: "cs_u2", tmdbId: 777, type: "tv" }),
        );
        const scope = { accountId: "acct_default", connectedStorageId: "cs_u2" };
        expect((await repo.untrackTitle(777, scope, "movie")).status).toBe("not_found");
        // untouched
        expect(await repo.listTrackedSeasonStates(scope)).toHaveLength(1);
      });

      it("untrackTitle removes a season that only has a running staging_recovery, and a missing run's progress is a no-op", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_hid" };
        const tracked = queuedRun({ id: "hid_seed", status: "succeeded", connectedStorageId: "cs_hid", tmdbId: 4410 });
        await repo.saveWorkflowRunSnapshot(tracked);
        await repo.saveWorkflowRunSnapshot({
          ...tracked,
          workflowRun: {
            ...tracked.workflowRun,
            id: "hid_recovery",
            kind: "staging_recovery",
            status: "running",
            startedAt: "2026-09-28T03:00:00.000Z",
            finishedAt: null,
          },
        });
        expect(await repo.untrackTitle(4410, scope, "tv")).toEqual({ status: "untracked", removedSeasons: 1 });
        expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);
        expect(await repo.getWorkflowRunSnapshot("hid_recovery", scope)).toBeNull();
        await repo.updateWorkflowRunProgress("hid_recovery", {
          activity: "整理",
          phase: "organize",
          percent: 40,
          updatedAt: "2026-09-28T03:01:00.000Z",
        });
        await repo.appendAgentStep("hid_recovery", {
          ordinal: 0,
          toolName: "inspectStaging",
          args: {},
          activity: "查看暂存",
          phase: "verify",
          at: "2026-09-28T03:01:00.000Z",
        });
        expect(await repo.getWorkflowRunSnapshot("hid_recovery", scope)).toBeNull();
        expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);
      });

      it("untrackTitle returns in_flight and removes nothing when a target season has a running run", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queuedRun({ id: "urun", status: "running", connectedStorageId: "cs_u3", tmdbId: 888, type: "tv" }),
        );
        const scope = { accountId: "acct_default", connectedStorageId: "cs_u3" };
        expect(await repo.untrackTitle(888, scope, "tv")).toEqual({
          status: "in_flight",
          removedSeasons: 0,
        });
        expect(await repo.listTrackedSeasonStates(scope)).toHaveLength(1);
      });

      it("untrackTitle refuses (in_flight) every season of a title while a replace_request of it on that drive is queued or running — also a season the run is not recorded on", async () => {
        const repo = await fresh();
        const base = queuedRun({ id: "ur1", status: "succeeded", connectedStorageId: "cs_ur", tmdbId: 876, type: "tv", seasonNumber: 1 });
        await repo.saveWorkflowRunSnapshot(base);
        await repo.saveWorkflowRunSnapshot({
          ...base,
          season: { ...base.season, id: "season_ur2", seasonNumber: 2 },
          workflowRun: { ...base.workflowRun, id: "ur2", trackedSeasonId: "season_ur2" },
          episodes: base.episodes.map((e) => ({ ...e, trackedSeasonId: "season_ur2" })),
        });
        const scope = { accountId: "acct_default", connectedStorageId: "cs_ur" };
        const work = { accountId: "acct_default", drive: "cs_ur", titleKey: "title_ur1" };
        // Reserved on the lowest season (the lock); it covers S2 too and writes S2's record when it ends.
        expect(await queueReplaceRequest({ repository: repo, work, now: () => "2026-09-27T00:00:00.000Z", createWorkflowRunId: () => "ur_replace" })).toEqual({
          status: "queued",
          workflowRunId: "ur_replace",
        });

        expect(await repo.untrackTitle(876, scope, "tv", 2)).toEqual({ status: "in_flight", removedSeasons: 0 });
        await repo.claimNextQueuedWorkflowRun({ kind: "replace_request", now: "2026-09-27T00:00:01.000Z" });
        expect(await repo.untrackTitle(876, scope, "tv", 2)).toEqual({ status: "in_flight", removedSeasons: 0 });
        expect(await repo.untrackTitle(876, scope, "tv")).toEqual({ status: "in_flight", removedSeasons: 0 });
        expect((await repo.listTrackedSeasonStates(scope)).map((s) => s.season.seasonNumber)).toEqual([1, 2]);

        // Once it has ended, the season can go.
        const running = await repo.getWorkflowRunSnapshot("ur_replace", scope);
        await repo.saveWorkflowRunSnapshot({
          ...running!,
          workflowRun: { ...running!.workflowRun, status: "succeeded", finishedAt: "2026-09-27T00:05:00.000Z" },
        });
        expect(await repo.untrackTitle(876, scope, "tv", 2)).toEqual({ status: "untracked", removedSeasons: 1 });
        expect((await repo.listTrackedSeasonStates(scope)).map((s) => s.season.seasonNumber)).toEqual([1]);
      });

      it("a replace_request of the same title on ANOTHER drive does not hold back untracking it here", async () => {
        const repo = await fresh();
        const here = queuedRun({ id: "ux1", status: "succeeded", connectedStorageId: "cs_ux_here", tmdbId: 765, type: "tv" });
        await repo.saveWorkflowRunSnapshot(here);
        await repo.saveWorkflowRunSnapshot({ ...here, connectedStorageId: "cs_ux_there", workflowRun: { ...here.workflowRun, id: "ux1_there" } });
        const there = { accountId: "acct_default", drive: "cs_ux_there", titleKey: "title_ux1" };
        expect((await queueReplaceRequest({ repository: repo, work: there, now: () => "2026-09-27T00:00:00.000Z", createWorkflowRunId: () => "ux_replace" })).status).toBe("queued");

        expect(await repo.untrackTitle(765, { accountId: "acct_default", connectedStorageId: "cs_ux_here" }, "tv")).toEqual({
          status: "untracked",
          removedSeasons: 1,
        });
      });

      it("a replace run saved running with its evidence, then terminal with its notification, keeps one copy of each — and untracking waits for the terminal save", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_hold" };
        const evidence = workflowPersistenceFixture();
        const seed = queuedRun({ id: "hold_seed", status: "succeeded", connectedStorageId: "cs_hold", tmdbId: 654, type: "tv" });
        await repo.saveWorkflowRunSnapshot(seed);
        // The replace run's lock record, held open: episodes and evidence, no notification yet.
        const held = {
          ...seed,
          workflowRun: { ...seed.workflowRun, id: "hold_run", kind: "replace_request" as const, status: "running" as const, finishedAt: null },
          resourceSnapshots: evidence.resourceSnapshots,
          decisions: evidence.decisions,
          transferAttempts: evidence.transferAttempts.map((a) => ({ ...a, workflowRunId: "hold_run" })),
          notifications: [],
        };
        await repo.saveWorkflowRunSnapshot(held);
        expect(await repo.untrackTitle(654, scope, "tv")).toEqual({ status: "in_flight", removedSeasons: 0 });

        await repo.saveWorkflowRunSnapshot({
          ...held,
          workflowRun: { ...held.workflowRun, status: "succeeded" as const, finishedAt: "2026-09-27T00:05:00.000Z" },
          notifications: evidence.notifications.map((n) => ({ ...n, workflowRunId: "hold_run" })),
        });
        const saved = await repo.getWorkflowRunSnapshot("hold_run", scope);
        expect(saved?.workflowRun).toMatchObject({ status: "succeeded", finishedAt: "2026-09-27T00:05:00.000Z" });
        expect(saved?.resourceSnapshots.map((s) => s.id)).toEqual(["snapshot_1"]);
        expect(saved?.decisions).toHaveLength(1);
        expect(saved?.transferAttempts.map((a) => a.id)).toEqual(["transfer_1"]);
        expect(saved?.notifications.map((n) => n.id)).toEqual(["notification_1"]);
        expect(await repo.untrackTitle(654, scope, "tv")).toEqual({ status: "untracked", removedSeasons: 1 });
      });

      it("untrackTitle (whole title) withdraws pending messages and drops pending replacements for that work only", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queuedRun({ id: "uw", status: "succeeded", connectedStorageId: "cs_uw", tmdbId: 321, type: "tv" }),
        );
        const scope = { accountId: "acct_default", connectedStorageId: "cs_uw" };
        const work = { accountId: "acct_default", drive: "cs_uw", titleKey: "title_uw" };
        const t0 = "2026-09-26T00:00:00.000Z";
        const pending = await repo.createUserMessage({ ...work, body: "还在等", episodeTags: [], now: t0 });
        await repo.claimUserMessages({ ...work, runId: "run_x", now: t0 });
        await repo.releaseUserMessages({ runId: "run_x", now: t0 });
        await repo.addPendingReplacements({ ...work, episodes: ["S01E01"], messageId: pending.id, now: t0 });
        await repo.upsertEpisodeSource({ ...work, episode: "S01E01", linkKey: "115:aa", label: "a.mkv", sizeBytes: 1, runId: "run_x", recordedAt: t0 });
        await repo.addRejectedResources({
          accountId: "acct_default", titleKey: "title_uw", now: t0,
          items: [{ episode: "S01E01", linkKey: "115:bb", label: "b.mkv", sizeBytes: 1, reason: "假", messageId: null }],
        });

        // Another drive's work with the same title id must be untouched.
        const otherDriveWork = { accountId: "acct_default", drive: "cs_other", titleKey: "title_uw" };
        await repo.createUserMessage({ ...otherDriveWork, body: "别的盘", episodeTags: [], now: t0 });
        await repo.addPendingReplacements({ ...otherDriveWork, episodes: ["S01E02"], messageId: "m_other", now: t0 });
        // Another title on the same drive must be untouched.
        const otherTitleWork = { ...work, titleKey: "title_other" };
        await repo.createUserMessage({ ...otherTitleWork, body: "别的剧", episodeTags: [], now: t0 });
        await repo.addPendingReplacements({ ...otherTitleWork, episodes: ["S01E03"], messageId: "m_other2", now: t0 });

        const result = await repo.untrackTitle(321, scope, "tv");
        expect(result).toEqual({ status: "untracked", removedSeasons: 1 });

        // listUserMessages excludes withdrawn rows by design, so "gone from here" IS
        // the withdrawn assertion.
        expect(await repo.listUserMessages(work)).toEqual([]);
        expect(await repo.listPendingReplacements(work)).toEqual([]);
        expect(await repo.listEpisodeSources(work)).toHaveLength(1);
        expect(await repo.listRejectedResources({ accountId: "acct_default", titleKey: "title_uw" })).toHaveLength(1);

        expect((await repo.listUserMessages(otherDriveWork))[0]).toMatchObject({ status: "pending" });
        expect(await repo.listPendingReplacements(otherDriveWork)).toHaveLength(1);
        expect((await repo.listUserMessages(otherTitleWork))[0]).toMatchObject({ status: "pending" });
        expect(await repo.listPendingReplacements(otherTitleWork)).toHaveLength(1);
      });

      it("untrackTitle (single season) removes only that season's pending replacements, leaves messages alone", async () => {
        const repo = await fresh();
        // Two seasons of the SAME title (shared title.id, distinct season.id) —
        // mirrors how one tv title tracks multiple seasons in production.
        const base = queuedRun({ id: "us1", status: "succeeded", connectedStorageId: "cs_us", tmdbId: 654, type: "tv", seasonNumber: 1 });
        await repo.saveWorkflowRunSnapshot(base);
        await repo.saveWorkflowRunSnapshot({
          ...base,
          season: { ...base.season, id: "season_us2", seasonNumber: 2 },
          workflowRun: { ...base.workflowRun, id: "us2", trackedSeasonId: "season_us2" },
          episodes: base.episodes.map((e) => ({ ...e, trackedSeasonId: "season_us2" })),
        });
        const scope = { accountId: "acct_default", connectedStorageId: "cs_us" };
        const work = { accountId: "acct_default", drive: "cs_us", titleKey: "title_us1" };
        const t0 = "2026-09-26T00:00:00.000Z";
        const pending = await repo.createUserMessage({ ...work, body: "留着", episodeTags: [], now: t0 });
        await repo.addPendingReplacements({ ...work, episodes: ["S01E01", "S02E01"], messageId: pending.id, now: t0 });

        const result = await repo.untrackTitle(654, scope, "tv", 1);
        expect(result).toEqual({ status: "untracked", removedSeasons: 1 });

        expect((await repo.listPendingReplacements(work)).map((p) => p.episode)).toEqual(["S02E01"]);
        const [msg] = await repo.listUserMessages(work);
        expect(msg).toMatchObject({ status: "pending", id: pending.id });
      });

      it("untrackTitle (single season) of the LAST season tracked on that drive withdraws the work's pending messages and all its 待换 rows, like a whole-title untrack", async () => {
        const repo = await fresh();
        const base = queuedRun({ id: "ul1", status: "succeeded", connectedStorageId: "cs_ul", tmdbId: 987, type: "tv", seasonNumber: 1 });
        await repo.saveWorkflowRunSnapshot(base);
        await repo.saveWorkflowRunSnapshot({
          ...base,
          season: { ...base.season, id: "season_ul2", seasonNumber: 2 },
          workflowRun: { ...base.workflowRun, id: "ul2", trackedSeasonId: "season_ul2" },
          episodes: base.episodes.map((e) => ({ ...e, trackedSeasonId: "season_ul2" })),
        });
        const scope = { accountId: "acct_default", connectedStorageId: "cs_ul" };
        const work = { accountId: "acct_default", drive: "cs_ul", titleKey: "title_ul1" };
        const t0 = "2026-09-26T00:00:00.000Z";
        const msg = await repo.createUserMessage({ ...work, body: "换", episodeTags: [], now: t0 });
        await repo.markUserMessagesUrgent({ ...work, now: t0 });
        // S03 was never tracked here: a stale row that only a whole-work cleanup removes.
        await repo.addPendingReplacements({ ...work, episodes: ["S01E01", "S02E01", "S03E01"], messageId: msg.id, now: t0 });
        // The same title on another drive is another work.
        const otherDrive = { ...work, drive: "cs_ul_other" };
        await repo.createUserMessage({ ...otherDrive, body: "别的盘", episodeTags: [], now: t0 });

        // One season at a time: S02 is still tracked, so the message stays.
        expect(await repo.untrackTitle(987, scope, "tv", 1)).toEqual({ status: "untracked", removedSeasons: 1 });
        expect((await repo.listUserMessages(work))[0]).toMatchObject({ id: msg.id, status: "pending" });
        // The last one: nothing of the title is tracked on this drive any more.
        expect(await repo.untrackTitle(987, scope, "tv", 2)).toEqual({ status: "untracked", removedSeasons: 1 });

        expect(await repo.listUserMessages(work)).toEqual([]);
        expect(await repo.listPendingReplacements(work)).toEqual([]);
        expect(await repo.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([]);
        expect((await repo.listUserMessages(otherDrive))[0]).toMatchObject({ status: "pending" });
      });

      /** The reservation queueReplaceRequest makes from the states it read earlier. */
      const replaceReservationFrom = (
        state: TrackedSeasonState,
        id: string,
        over: Partial<ReserveWorkflowRunInput> = {},
      ): ReserveWorkflowRunInput => ({
        accountId: state.accountId,
        ...(state.connectedStorageId != null ? { connectedStorageId: state.connectedStorageId } : {}),
        title: state.title,
        season: state.season,
        workflowRun: {
          id,
          kind: "replace_request",
          status: "queued",
          trackedSeasonId: state.season.id,
          startedAt: "2026-09-27T00:00:00.000Z",
          finishedAt: null,
          auditEvents: [],
        },
        episodes: state.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
        blockIfTitleHasActiveRun: true,
        ...over,
      });

      it("requireTrackedSeason: a reservation from states read before the season was untracked is not_tracked and writes nothing; without it the reservation goes through as before", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_rt" };
        await repo.saveWorkflowRunSnapshot(queuedRun({ id: "rt", status: "succeeded", connectedStorageId: "cs_rt", tmdbId: 4321, type: "tv" }));
        // What queueReplaceRequest read; then the user untracks the work before it reserves.
        const [read] = await repo.listTrackedSeasonStates(scope);
        expect(await repo.untrackTitle(4321, scope, "tv")).toEqual({ status: "untracked", removedSeasons: 1 });

        expect(await repo.reserveWorkflowRun(replaceReservationFrom(read!, "rt_replace", { requireTrackedSeason: true }))).toEqual({
          status: "not_tracked",
        });

        expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);
        expect(await repo.listActiveWorkflowRuns(scope)).toEqual([]);
        expect(await repo.getWorkflowRunSnapshot("rt_replace", scope)).toBeNull();
        // Without the option the same reservation still creates the tracking (how init
        // runs start tracking a season).
        expect((await repo.reserveWorkflowRun(replaceReservationFrom(read!, "rt_plain"))).status).toBe("reserved");
        expect((await repo.listTrackedSeasonStates(scope)).map((s) => s.season.id)).toEqual(["season_rt"]);
      });

      it("untrackTitle racing a requireTrackedSeason replace reservation: never both — the untrack is in_flight or the reservation is not_tracked", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_race" };
        for (let round = 0; round < 10; round++) {
          const tmdbId = 9100 + round;
          const tracked = queuedRun({ id: `race${round}`, status: "succeeded", connectedStorageId: "cs_race", tmdbId, type: "tv" });
          await repo.saveWorkflowRunSnapshot(tracked);
          const read = (await repo.listTrackedSeasonStates(scope)).find((s) => s.title.id === tracked.title.id)!;
          const replaceId = `race${round}_replace`;
          const untrack = () => repo.untrackTitle(tmdbId, scope, "tv");
          const reserve = () => repo.reserveWorkflowRun(replaceReservationFrom(read, replaceId, { requireTrackedSeason: true }));
          // Alternate which one starts first (Postgres runs both transactions at once).
          const [untrackResult, reservation] =
            round % 2 === 0
              ? await Promise.all([untrack(), reserve()])
              : await Promise.all([reserve(), untrack()]).then(([r, u]) => [u, r] as const);

          const stillTracked = (await repo.listTrackedSeasonStates(scope)).some((s) => s.title.id === tracked.title.id);
          const replaceActive = (await repo.listActiveWorkflowRuns(scope)).some((run) => run.workflowRun.id === replaceId);
          if (reservation.status === "reserved") {
            expect(untrackResult).toEqual({ status: "in_flight", removedSeasons: 0 });
            expect({ stillTracked, replaceActive }).toEqual({ stillTracked: true, replaceActive: true });
          } else {
            expect(reservation).toEqual({ status: "not_tracked" });
            expect(untrackResult).toEqual({ status: "untracked", removedSeasons: 1 });
            expect({ stillTracked, replaceActive }).toEqual({ stillTracked: false, replaceActive: false });
          }
        }
      });

      it("saveWorkflowRunSnapshot requireTrackedSeason writes a tracked season and nothing after untrack", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_req" };
        const tracked = queuedRun({ id: "req_seed", status: "succeeded", connectedStorageId: "cs_req", tmdbId: 4401 });
        await repo.saveWorkflowRunSnapshot(tracked);

        await repo.saveWorkflowRunSnapshot({
          ...tracked,
          requireTrackedSeason: true,
          workflowRun: {
            ...tracked.workflowRun,
            id: "req_live",
            kind: "type3_monitor",
            startedAt: "2026-09-28T01:00:00.000Z",
            finishedAt: "2026-09-28T01:10:00.000Z",
          },
        });
        expect((await repo.getWorkflowRunSnapshot("req_live", scope))?.workflowRun.id).toBe("req_live");
        expect((await repo.listTrackedSeasonStates(scope)).map((state) => state.season.id)).toContain("season_req_seed");

        expect(await repo.untrackTitle(4401, scope, "tv")).toEqual({ status: "untracked", removedSeasons: 1 });
        expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);

        await repo.saveWorkflowRunSnapshot({
          ...tracked,
          requireTrackedSeason: true,
          workflowRun: {
            ...tracked.workflowRun,
            id: "req_back",
            startedAt: "2026-09-28T02:00:00.000Z",
            finishedAt: "2026-09-28T02:10:00.000Z",
          },
        });
        expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);
        expect(await repo.getWorkflowRunSnapshot("req_back", scope)).toBeNull();
      });

      it("saveWorkflowRunSnapshot keepCurrentEpisodes writes nothing once the season is untracked", async () => {
        const repo = await fresh();
        const scope = { accountId: "acct_default", connectedStorageId: "cs_keep_gone" };
        const tracked = queuedRun({ id: "keep_gone", status: "succeeded", connectedStorageId: "cs_keep_gone", tmdbId: 4402 });
        await repo.saveWorkflowRunSnapshot(tracked);
        expect(await repo.untrackTitle(4402, scope, "tv")).toEqual({ status: "untracked", removedSeasons: 1 });

        await repo.saveWorkflowRunSnapshot({
          ...tracked,
          keepCurrentEpisodes: true,
          workflowRun: {
            ...tracked.workflowRun,
            id: "keep_gone_write",
            startedAt: "2026-09-28T03:00:00.000Z",
            finishedAt: "2026-09-28T03:10:00.000Z",
          },
        });
        expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);
        expect(await repo.getWorkflowRunSnapshot("keep_gone_write", scope)).toBeNull();
      });

      it("keepCurrentEpisodes: a replace reservation from a stale read writes only the run — what a run persisted in between stays; without it the reservation writes what it was handed, as before", async () => {
        const repo = await fresh();
        /** Track a season, read it (S01E02 missing), let a patrol run of it finish (S01E02
         *  lands, the season and title records change), then reserve from the stale read. */
        const reserveFromStaleRead = async (id: string, tmdbId: number, over: Partial<ReserveWorkflowRunInput>) => {
          const scope = { accountId: "acct_default", connectedStorageId: `cs_${id}` };
          const tracked = queuedRun({ id, status: "succeeded", tmdbId, type: "tv" });
          await repo.saveWorkflowRunSnapshot(tracked);
          const [read] = await repo.listTrackedSeasonStates(scope);
          expect(read!.episodes.map((e) => [e.episodeCode, e.obtained])).toEqual([["S01E01", true], ["S01E02", false]]);
          await repo.saveWorkflowRunSnapshot({
            ...tracked,
            title: { ...tracked.title, aliases: ["Alias learned later"] },
            season: { ...tracked.season, latestAiredEpisode: 2 },
            workflowRun: {
              ...tracked.workflowRun,
              id: `${id}_patrol`,
              kind: "type3_monitor",
              startedAt: "2026-09-26T00:00:00.000Z",
              finishedAt: "2026-09-26T00:10:00.000Z",
            },
            episodes: tracked.episodes.map((e) => ({ ...e, airStatus: "aired" as const, obtained: true, verifiedFileIds: [`file_${e.episodeCode}`] })),
          });
          const current = (await repo.getTrackedSeasonState(`season_${id}`, scope))!;
          expect(current.episodes.map((e) => [e.episodeCode, e.obtained])).toEqual([["S01E01", true], ["S01E02", true]]);
          const reservation = await repo.reserveWorkflowRun(replaceReservationFrom(read!, `${id}_replace`, over));
          const after = (await repo.getTrackedSeasonState(`season_${id}`, scope))!;
          const active = (await repo.listActiveWorkflowRuns(scope)).map((run) => run.workflowRun.id);
          return { read: read!, current, reservation, after, active };
        };

        const kept = await reserveFromStaleRead("kc_keep", 5101, { requireTrackedSeason: true, keepCurrentEpisodes: true });
        expect(kept.reservation.status).toBe("reserved");
        expect(kept.active).toEqual(["kc_keep_replace"]);
        // The season record, its episode states and the title are exactly what was stored.
        expect(kept.after).toEqual(kept.current);
        // The reservation reports what it kept, not the stale copy it was handed.
        expect(kept.reservation.status === "reserved" && {
          title: kept.reservation.snapshot.title,
          season: kept.reservation.snapshot.season,
          episodes: kept.reservation.snapshot.episodes,
        }).toEqual({ title: kept.current.title, season: kept.current.season, episodes: kept.current.episodes });

        // Without the option the handed copy is written wholesale (how init and patrol
        // reservations set a season's state).
        const plain = await reserveFromStaleRead("kc_plain", 5102, { requireTrackedSeason: true });
        expect(plain.reservation.status).toBe("reserved");
        expect(plain.after.season).toEqual(plain.read.season);
        expect(plain.after.episodes).toEqual(plain.read.episodes);

        // There is nothing current to keep for a season that is not tracked: refused, nothing written.
        const untrackedScope = { accountId: "acct_default", connectedStorageId: "cs_kc_gone" };
        const gone = queuedRun({ id: "kc_gone", status: "succeeded", tmdbId: 5103, type: "tv" });
        await repo.saveWorkflowRunSnapshot(gone);
        const [goneRead] = await repo.listTrackedSeasonStates(untrackedScope);
        expect(await repo.untrackTitle(5103, untrackedScope, "tv")).toEqual({ status: "untracked", removedSeasons: 1 });
        expect(await repo.reserveWorkflowRun(replaceReservationFrom(goneRead!, "kc_gone_replace", { keepCurrentEpisodes: true }))).toEqual({
          status: "not_tracked",
        });
        expect(await repo.listTrackedSeasonStates(untrackedScope)).toEqual([]);
        expect(await repo.getWorkflowRunSnapshot("kc_gone_replace", untrackedScope)).toBeNull();
      });

      it("a failed or requeued staging_recovery does not roll back an episode marked while it was queued", async () => {
        const markThenFail = async (id: string, error: Error) => {
          const repo = await fresh();
          const scope = { accountId: "acct_default", connectedStorageId: `cs_${id}` };
          const seed = queuedRun({ id, status: "succeeded", connectedStorageId: `cs_${id}` });
          await repo.saveWorkflowRunSnapshot(seed);
          const [read] = await repo.listTrackedSeasonStates(scope);
          expect(read!.episodes.find((episode) => episode.episodeCode === "S01E02")?.obtained).toBe(false);
          const reserved = await repo.reserveWorkflowRun({
            ...seed,
            episodes: read!.episodes,
            keepCurrentEpisodes: true,
            requireTrackedSeason: true,
            workflowRun: {
              ...seed.workflowRun,
              id: `${id}_recovery`,
              kind: "staging_recovery",
              status: "queued",
              startedAt: "2026-09-27T00:00:00.000Z",
              finishedAt: null,
              auditEvents: [
                {
                  type: "staging_recovery_queued",
                  message: "queued",
                  data: { stagingDirectoryId: "stg", showDirectoryId: "show", seasonNumbers: [1] },
                },
              ],
            },
          });
          expect(reserved.status).toBe("reserved");
          await repo.saveWorkflowRunSnapshot({
            ...seed,
            episodes: read!.episodes.map((episode) => ({
              ...episode,
              obtained: true,
              verifiedFileIds: [`file_${episode.episodeCode}`],
            })),
            workflowRun: {
              ...seed.workflowRun,
              id: `${id}_user`,
              kind: "type3_monitor",
              status: "succeeded",
              startedAt: "2026-09-27T01:00:00.000Z",
              finishedAt: "2026-09-27T01:10:00.000Z",
            },
          });
          const claimed = await repo.claimNextQueuedWorkflowRun({
            kind: "staging_recovery",
            now: "2026-09-27T02:00:00.000Z",
          });
          expect(claimed?.workflowRun.id).toBe(`${id}_recovery`);
          const handled = await handleWorkflowRunFailure({
            claimed: claimed!,
            error,
            repository: repo,
            now: () => "2026-09-27T02:01:00.000Z",
          });
          const after = await repo.getTrackedSeasonState(`season_${id}`, scope);
          return {
            handled,
            obtained: after?.episodes.find((episode) => episode.episodeCode === "S01E02")?.obtained,
          };
        };

        const permanent = await markThenFail("stale_fail", new Error("agent model unavailable"));
        expect(permanent.handled.status).toBe("failed");
        expect(permanent.obtained).toBe(true);

        const transient = await markThenFail("stale_retry", new Error("socket disconnected"));
        expect(transient.handled.status).toBe("auto_requeued");
        expect(transient.obtained).toBe(true);
      });

      it("retryFailedWorkflowRun requeues a failed run so it becomes claimable", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(
          queuedRun({ id: "failed_r", status: "failed", connectedStorageId: "cs_r" }),
        );
        const scope = { accountId: "acct_default", connectedStorageId: "cs_r" };
        expect((await repo.retryFailedWorkflowRun("failed_r", scope)).status).toBe("retried");
        const after = await repo.getWorkflowRunSnapshot("failed_r", scope);
        expect(after?.workflowRun.status).toBe("queued");
        // Immediately claimable (counters cleared, no future nextAttemptAt).
        const claimed = await repo.claimNextQueuedWorkflowRun({
          kind: "type2_init",
          now: "2030-01-01T00:00:00.000Z",
        });
        expect(claimed?.workflowRun.id).toBe("failed_r");
      });

      it("retryFailedWorkflowRun refuses a failed run whose kind no worker claims", async () => {
        const repo = await fresh();
        const snap = queuedRun({ id: "failed_r3", status: "failed", connectedStorageId: "cs_r3" });
        await repo.saveWorkflowRunSnapshot({
          ...snap,
          workflowRun: {
            ...snap.workflowRun,
            kind: "type3_monitor",
            status: "failed",
            finishedAt: "2026-06-11T02:00:00.000Z",
          },
        });
        const scope = { accountId: "acct_default", connectedStorageId: "cs_r3" };
        // No claimNextQueuedWorkflowRun call site asks for type3_monitor, so a run
        // pushed back to `queued` can never leave it — and since `queued` counts as
        // active, reserveWorkflowRun returns already_active for that season FOREVER
        // (the user-visible "巡检永久卡在排队中"). Task 1 terminates such orphans as
        // `failed`; letting the activity page's retry button flip them back to
        // `queued` would re-strand the run and re-block the season — exactly the bug
        // isQueueClaimableKind exists to prevent.
        expect(await repo.retryFailedWorkflowRun("failed_r3", scope)).toEqual({
          status: "not_retriable",
        });
        const after = await repo.getWorkflowRunSnapshot("failed_r3", scope);
        expect(after?.workflowRun.status).toBe("failed");
        // retriedWorkflowRun clears finishedAt — it must not have run at all.
        expect(after?.workflowRun.finishedAt).toBe("2026-06-11T02:00:00.000Z");
      });

      it("retryFailedWorkflowRun refuses a failed staging_recovery", async () => {
        const repo = await fresh();
        const snap = queuedRun({ id: "failed_recovery", status: "failed", connectedStorageId: "cs_hidden_retry" });
        await repo.saveWorkflowRunSnapshot({
          ...snap,
          workflowRun: {
            ...snap.workflowRun,
            kind: "staging_recovery",
            status: "failed",
            finishedAt: "2026-06-11T02:00:00.000Z",
          },
        });
        const scope = { accountId: "acct_default", connectedStorageId: "cs_hidden_retry" };
        expect(await repo.retryFailedWorkflowRun("failed_recovery", scope)).toEqual({ status: "not_retriable" });
        const after = await repo.getWorkflowRunSnapshot("failed_recovery", scope);
        expect(after?.workflowRun.status).toBe("failed");
        expect(after?.workflowRun.finishedAt).toBe("2026-06-11T02:00:00.000Z");
      });

      it("retryFailedWorkflowRun refuses a non-failed (queued) run", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot(queuedRun({ id: "queued_r", connectedStorageId: "cs_rq" }));
        expect(
          (
            await repo.retryFailedWorkflowRun("queued_r", {
              accountId: "acct_default",
              connectedStorageId: "cs_rq",
            })
          ).status,
        ).toBe("not_retriable");
      });
    });

    describe("unscoped storage surfaces as null", () => {
      it("returns connectedStorageId=null for a run persisted with no drive (sentinel is an internal detail)", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot({
          ...workflowPersistenceFixture(),
          accountId: "acct_default",
          // connectedStorageId omitted → collapses to the UNSCOPED_STORAGE sentinel internally.
          transferAttempts: [],
          notifications: [],
        });
        const snap = await repo.getWorkflowRunSnapshot("run_1");
        // The domain contract says the sentinel must surface as null, never leak "__unscoped__".
        expect(snap?.connectedStorageId).toBeNull();
      });

      it("tracked-season readers list an unbound season with connectedStorageId=null", async () => {
        const repo = await fresh();
        await repo.saveWorkflowRunSnapshot({
          ...workflowPersistenceFixture(),
          accountId: "acct_default",
          transferAttempts: [],
          notifications: [],
        });
        const seasonId = workflowPersistenceFixture().season.id;
        const scoped = await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: null });
        expect(scoped.map((state) => [state.season.id, state.connectedStorageId])).toEqual([[seasonId, null]]);
        expect(scoped[0]?.episodes.length).toBeGreaterThan(0);
        const all = await repo.listAllTrackedSeasonStates();
        expect(all.map((state) => [state.season.id, state.connectedStorageId])).toEqual([[seasonId, null]]);
        expect(all[0]?.episodes.length).toBeGreaterThan(0);
        const one = await repo.getTrackedSeasonState(seasonId, { accountId: "acct_default", connectedStorageId: null });
        expect(one?.connectedStorageId).toBeNull();
        expect(one?.episodes.length).toBeGreaterThan(0);
      });

      it("an unbound work's replace request is found by its message drive ('') and queued", async () => {
        const repo = await fresh();
        const fixture = workflowPersistenceFixture();
        await repo.saveWorkflowRunSnapshot({ ...fixture, accountId: "acct_default", transferAttempts: [], notifications: [] });
        const work = { accountId: "acct_default", drive: "", titleKey: fixture.title.id };
        const result = await queueReplaceRequest({ repository: repo, work, createWorkflowRunId: () => "run_rr_unbound" });
        expect(result).toEqual({ status: "queued", workflowRunId: "run_rr_unbound" });
      });
    });

    describe("cross-drive season payload isolation", () => {
      it("hydrates each run's snapshot with ITS drive's season payload when the same season id is tracked on two drives", async () => {
        const repo = await fresh();
        const base = workflowPersistenceFixture();
        // Same season id ("season_1") on two drives, but DIFFERENT per-drive season
        // payload (storageDirectoryId). tracked_seasons PK is (id, connected_storage_id),
        // so loading the season by id alone could hydrate the WRONG drive's payload.
        const onDrive = (storageId: string, runId: string, dir: string) => ({
          ...base,
          connectedStorageId: storageId,
          workflowRun: { ...base.workflowRun, id: runId },
          season: { ...base.season, storageDirectoryId: dir },
          // child rows are validated to belong to workflowRun.id; drop them since we re-id the run.
          transferAttempts: [],
          notifications: [],
        });
        await repo.saveWorkflowRunSnapshot(onDrive("cs_A", "run_dirA", "dir_A"));
        await repo.saveWorkflowRunSnapshot(onDrive("cs_B", "run_dirB", "dir_B"));

        const a = await repo.getWorkflowRunSnapshot("run_dirA");
        const b = await repo.getWorkflowRunSnapshot("run_dirB");
        expect(a?.season.storageDirectoryId).toBe("dir_A");
        expect(b?.season.storageDirectoryId).toBe("dir_B");
      });

      it("lists one tracked-season state per (season, drive), not collapsed by season id", async () => {
        const repo = await fresh();
        const base = workflowPersistenceFixture();
        // season.id is drive-independent (`${title.id}_s${n}`), so the SAME season id
        // exists on both drives. Listing must return a state PER DRIVE — collapsing by
        // season id would drop a drive (and make the desktop sweep skip it).
        const onDrive = (storageId: string, runId: string) => ({
          ...base,
          connectedStorageId: storageId,
          workflowRun: { ...base.workflowRun, id: runId },
          transferAttempts: [],
          notifications: [],
        });
        await repo.saveWorkflowRunSnapshot(onDrive("cs_A", "run_mdA"));
        await repo.saveWorkflowRunSnapshot(onDrive("cs_B", "run_mdB"));

        // The cross-account sweep list (what runScheduledType3 patrols) must see both drives.
        const all = await repo.listAllTrackedSeasonStates();
        const allStorages = all
          .filter((s) => s.season.id === base.season.id)
          .map((s) => s.connectedStorageId)
          .sort();
        expect(allStorages).toEqual(["cs_A", "cs_B"]);

        // The account-scoped list (all drives) must too.
        const scoped = await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: null });
        const scopedStorages = scoped
          .filter((s) => s.season.id === base.season.id)
          .map((s) => s.connectedStorageId)
          .sort();
        expect(scopedStorages).toEqual(["cs_A", "cs_B"]);
      });

      it("findActiveWorkflowRun returns the SCOPED drive's active run, not null, when a newer active run exists on another drive", async () => {
        const repo = await fresh();
        const base = workflowPersistenceFixture();
        const activeOn = (storageId: string, runId: string, startedAt: string) => ({
          ...base,
          connectedStorageId: storageId,
          workflowRun: { ...base.workflowRun, id: runId, status: "queued" as const, finishedAt: null, startedAt },
          transferAttempts: [],
          notifications: [],
        });
        // drive A has an OLDER active run; drive B has a NEWER active run (same season+kind).
        await repo.saveWorkflowRunSnapshot(activeOn("cs_A", "run_fa_A", "2026-07-01T00:00:00.000Z"));
        await repo.saveWorkflowRunSnapshot(activeOn("cs_B", "run_fa_B", "2026-07-02T00:00:00.000Z"));

        const found = await repo.findActiveWorkflowRun({
          trackedSeasonId: base.season.id,
          kind: base.workflowRun.kind,
          accountId: "acct_default",
          connectedStorageId: "cs_A",
        });
        // Must scope-filter FIRST: return cs_A's run, not the newer cs_B run (and not null).
        expect(found?.workflowRun.id).toBe("run_fa_A");
      });
    });

    // NOTE: backfillConnectedStorageId is deliberately NOT in the shared contract.
    // It is a genuine, pre-existing engine divergence: at runtime a null-storage
    // persist collapses to the UNSCOPED_STORAGE sentinel, so SQLite's backfill (which
    // targets the sentinel) actively pins the row (count 1), while Postgres's backfill
    // targets literal NULL and is effectively dead code post-persist (count 0). The
    // shared contract only asserts behavior ALL engines agree on; SQLite's backfill is
    // locked in repository-contract-sqlite.test.ts, InMemory's in migrate-backfill-storage-id.test.ts.
  });
}
