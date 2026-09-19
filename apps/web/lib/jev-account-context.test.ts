import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * §7 form B seam: the worker drains a cross-account queue and resolves the
 * CLAIMED run's owner context. The Jev prefilter is a per-account setting, so
 * it has to arrive through that resolver — not through the process-global base
 * deps — or a multi-user instance would run account A's搜索 with account B's
 * (or nobody's) prefilter. Exercises the REAL resolver against an in-memory
 * SQLite repo with the fake model/storage adapters; no network: the judge is
 * only CONSTRUCTED here, never called.
 */

const prevSqlite = process.env.MEDIA_TRACK_SQLITE_PATH;
const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
const prevAgentAdapter = process.env.MEDIA_TRACK_AGENT_ADAPTER;
const prevStorageAdapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER;
const prevJevKey = process.env.JEV_API_KEY;

const ACCOUNT_ID = "acct_default";

/** Boot workflow-runtime against a fresh :memory: SQLite repo, single-user, with
 *  the fake agent-model + storage adapters (no credentials, no HTTP). */
const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER; // single-user → getCurrentAccountId() = acct_default
  delete process.env.MEDIA_TRACK_AGENT_ADAPTER; // → fake model
  delete process.env.MEDIA_TRACK_STORAGE_ADAPTER; // → fake storage executor
  delete process.env.JEV_API_KEY; // the DB rows below are the only source of truth
  vi.resetModules();
  return import("./workflow-runtime");
};

afterEach(() => {
  if (prevSqlite !== undefined) process.env.MEDIA_TRACK_SQLITE_PATH = prevSqlite;
  else delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
  if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  if (prevAgentAdapter !== undefined) process.env.MEDIA_TRACK_AGENT_ADAPTER = prevAgentAdapter;
  if (prevStorageAdapter !== undefined) process.env.MEDIA_TRACK_STORAGE_ADAPTER = prevStorageAdapter;
  if (prevJevKey !== undefined) process.env.JEV_API_KEY = prevJevKey;
  vi.resetModules();
});

describe("per-account worker context carries jevJudge when Settings enable it", () => {
  it("resolver returns jevJudge only when key+enabled+health ok", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    await repository.setAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY, "k");
    await repository.setAccountSetting(ACCOUNT_ID, rt.JEV_PREFILTER_ENABLED_SETTING_KEY, "1");
    await repository.setAccountSetting(ACCOUNT_ID, rt.JEV_HEALTH_SETTING_KEY, "ok");

    const resolve = rt.buildAccountContextResolver();
    const enabled = await resolve(ACCOUNT_ID, null);
    expect(enabled.jevJudge).toBeDefined();
    expect(typeof enabled.jevJudge!.judgeCandidates).toBe("function");

    // Toggling the setting off is enough to take the prefilter out of the run —
    // no restart, no separate teardown of the key.
    await repository.setAccountSetting(ACCOUNT_ID, rt.JEV_PREFILTER_ENABLED_SETTING_KEY, "0");
    expect((await resolve(ACCOUNT_ID, null)).jevJudge).toBeUndefined();
  });

  it("an unconfigured account gets no judge (the untouched default path)", async () => {
    const rt = await boot();
    const ctx = await rt.buildAccountContextResolver()(ACCOUNT_ID, null);
    expect(ctx.jevJudge).toBeUndefined();
    // the rest of the per-account context is still resolved as before
    expect(ctx.storage).toBeDefined();
    expect(ctx.resourceProvider).toBeDefined();
  });
});
