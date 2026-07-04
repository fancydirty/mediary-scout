import { describe, it, expect } from "vitest";
import { DuplicateUsernameError, type WorkflowRepository } from "../src/repository.js";
import type { Account } from "../src/account-credentials.js";

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
  });
}
