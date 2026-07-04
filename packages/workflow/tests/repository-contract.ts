import { describe, it, expect } from "vitest";
import { DuplicateUsernameError, type WorkflowRepository } from "../src/repository.js";
import type { Account } from "../src/account-credentials.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";

/** A factory that yields a FRESH, empty repository and a teardown. Postgres/SQLite
 *  return async; InMemory is sync — accept both. */
export interface RepoHarness {
  make: () => Promise<WorkflowRepository> | WorkflowRepository;
  teardown?: (repo: WorkflowRepository) => Promise<void> | void;
}

export function runRepositoryContract(name: string, harness: RepoHarness): void {
  describe(`WorkflowRepository contract: ${name}`, () => {
    async function fresh(): Promise<WorkflowRepository> {
      return await harness.make();
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

      it("scopes account settings per account", async () => {
        const repo = await fresh();
        await repo.setAccountSetting("acct_a", "llm_key", "A");
        await repo.setAccountSetting("acct_b", "llm_key", "B");
        expect(await repo.getAccountSetting("acct_a", "llm_key")).toBe("A");
        expect(await repo.getAccountSetting("acct_b", "llm_key")).toBe("B");
        expect(await repo.getAccountSetting("acct_a", "missing")).toBeNull();
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
          connectedStorageId?: string;
          nextAttemptAt?: string;
        } = {},
      ) => {
        const base = workflowPersistenceFixture();
        const seasonId = `season_${id}`;
        return {
          ...base,
          connectedStorageId: over.connectedStorageId ?? `cs_${id}`,
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

        const count = await repo.requeueRunningWorkflowRuns();
        expect(count).toBe(1);
        const requeued = await repo.getWorkflowRunSnapshot("q1");
        expect(requeued?.workflowRun.status).toBe("queued");
        expect(requeued?.workflowRun.finishedAt).toBeNull();
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
  });
}
