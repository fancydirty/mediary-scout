#!/usr/bin/env node
// P1 verify: exercise the multi-user auth + data-isolation flow end-to-end at the
// data layer against the REAL dev Postgres (mirrors registerAccount/loginAccount/
// resolveSessionAccountId + account-scoped reads). Throwaway accounts, cleaned up.
import pg from "pg";
import {
  PostgresWorkflowRepository,
  initializeWorkflowPostgresSchema,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  isSessionExpired,
  generateSessionId,
} from "../packages/workflow/dist/index.js";

const url = "postgresql://mediatrack:mediatrack@localhost:5432/media_track";
const SECRET = "verify-secret";
const pool = new pg.Pool({ connectionString: url });
await initializeWorkflowPostgresSchema(pool);
const repo = new PostgresWorkflowRepository(pool, Promise.resolve());

let failed = 0;
const ok = (n, c) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };

// mirror of registerAccount → returns {accountId, signedCookie}
async function register(username, password) {
  const account = {
    id: `acct_vtest_${username}`,
    username,
    passwordHash: await hashPassword(password),
    groupId: null,
    isOwner: false,
    createdAt: new Date().toISOString(),
  };
  await repo.createAccount(account);
  const sessionId = generateSessionId();
  await repo.createSession({ id: sessionId, accountId: account.id, expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: new Date().toISOString() });
  return { accountId: account.id, signedCookie: signSession(sessionId, SECRET) };
}
// mirror of resolveSessionAccountId
async function resolve(signedCookie) {
  const sessionId = verifySession(signedCookie, SECRET);
  if (!sessionId) return null;
  const session = await repo.getSession(sessionId);
  if (!session || isSessionExpired(session.expiresAt, new Date().toISOString())) return null;
  return session.accountId;
}
function snap(accountId, suffix) {
  const title = { id: `ttl_vtest_${suffix}`, tmdbId: 7000, type: "tv", title: `V ${suffix}`, originalTitle: `V ${suffix}`, year: 2026, aliases: [] };
  const season = { id: `seas_vtest_${suffix}`, mediaTitleId: title.id, seasonNumber: 1, status: "active", qualityPreference: "4K", storageDirectoryId: "d", totalEpisodes: 1, latestAiredEpisode: 1, latestAiredSource: "metadata" };
  return { accountId, title, season,
    workflowRun: { id: `run_vtest_${suffix}`, kind: "type2_init", status: "queued", trackedSeasonId: season.id, startedAt: "2026-06-18T00:00:00.000Z", finishedAt: null, auditEvents: [] },
    episodes: [{ trackedSeasonId: season.id, episodeCode: "S01E01", airDate: null, title: "e", airStatus: "aired", obtained: true, metadataStatus: "confirmed", verifiedFileIds: ["f"] }],
    resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [] };
}

async function cleanup() {
  await pool.query("DELETE FROM episode_states WHERE tracked_season_id LIKE 'seas_vtest_%'");
  await pool.query("DELETE FROM workflow_runs WHERE id LIKE 'run_vtest_%'");
  await pool.query("DELETE FROM tracked_seasons WHERE id LIKE 'seas_vtest_%'");
  await pool.query("DELETE FROM media_titles WHERE id LIKE 'ttl_vtest_%'");
  await pool.query("DELETE FROM sessions WHERE account_id LIKE 'acct_vtest_%'");
  await pool.query("DELETE FROM accounts WHERE id LIKE 'acct_vtest_%'");
}

try {
  await cleanup();
  const alice = await register("vtest_alice", "alicepw");
  const bob = await register("vtest_bob", "bobpw");
  ok("register alice → cookie resolves to alice", (await resolve(alice.signedCookie)) === alice.accountId);
  ok("register bob → cookie resolves to bob", (await resolve(bob.signedCookie)) === bob.accountId);
  ok("two distinct accounts", alice.accountId !== bob.accountId);

  await repo.saveWorkflowRunSnapshot(snap(alice.accountId, "alice"));
  await repo.saveWorkflowRunSnapshot(snap(bob.accountId, "bob"));
  const aliceLib = await repo.listTrackedSeasonStates(alice.accountId);
  const bobLib = await repo.listTrackedSeasonStates(bob.accountId);
  ok("alice sees only her library", aliceLib.length === 1 && aliceLib[0].season.id === "seas_vtest_alice");
  ok("bob sees only his library", bobLib.length === 1 && bobLib[0].season.id === "seas_vtest_bob");
  ok("alice cannot read bob's run by id", (await repo.getWorkflowRunSnapshot("run_vtest_bob", alice.accountId)) === null);

  // login: correct vs wrong password
  const aliceAcct = await repo.getAccountByUsername("vtest_alice");
  ok("login correct password", await verifyPassword("alicepw", aliceAcct.passwordHash));
  ok("login wrong password rejected", !(await verifyPassword("nope", aliceAcct.passwordHash)));

  // logout: delete session → cookie no longer resolves
  const sid = verifySession(alice.signedCookie, SECRET);
  await repo.deleteSession(sid);
  ok("logout invalidates the session cookie", (await resolve(alice.signedCookie)) === null);

  // tampered cookie rejected
  ok("tampered cookie rejected", (await resolve(alice.signedCookie.replace(/.$/, "0"))) === null);
} finally {
  await cleanup();
  await pool.end();
}

console.log(failed === 0 ? "\nMULTI-USER FLOW VERIFIED" : `\n${failed} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);
