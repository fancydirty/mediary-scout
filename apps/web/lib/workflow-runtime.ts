import { randomBytes } from "node:crypto";
import { cache } from "react";
import {
  PanSouResourceProvider,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createBootstrapPan115CookieStorageExecutor,
  CompositeResourceProvider,
  ProwlarrResourceProvider,
  createTmdbMetadataProvider,
  TMDB_DIRECT_BASE_URL,
  type TmdbAccess,
  episodeCode,
  FakeResourceProvider,
  FakeStorageExecutor,
  createNotifyChannelsFromEnv,
  createAgentModel,
  createAgentModelFromEnv,
  createStubAcquisitionModel,
  llmConfigError,
  dispatchNotifications,
  formatDailyDigestPushText,
  getTrackedSeasonStatusView,
  importForeignWorkAsMovie,
  assertWorkflowAgentAdapterPolicy,
  prepareMovieTarget,
  prepareSeriesTarget,
  prepareTrackingTarget,
  queueMovieAcquisition,
  queueSeriesInitialization,
  queueTrackingInitialization,
  reserveMovie,
  runQueuedMovieAcquisition,
  runQueuedSeriesInitialization,
  runQueuedType2Workflow,
  resolveDriveSourceLabels,
  runScheduledType3Monitoring,
  sendPushNotifications,
  createPostgresWorkflowRepositorySync,
  migrateLegacyCookieToDefaultAccount,
  resolveStorageBinding,
  provisionCategoryDirs,
  parsePan115Uid,
  createExecutorForBrand,
  getStorageBrand,
  isRegisteredStorageProvider,
  brandSupportsProwlarr,
  allowedResourceTypesForKinds,
  parseQuarkUid,
  parseGuangYaUid,
  generateGuangYaDeviceId,
  GuangYaClient,
  type ResolveAccountWorkerContext,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  isSessionExpired,
  generateSessionId,
  DuplicateUsernameError,
  DEFAULT_ACCOUNT_ID,
  pickWorkspaceStorageId,
  resolveWorkspaceFromParam,
  type Account,
  type WorkflowScope,
  type MediaSearchCandidate,
  type MediaTitle,
  type NotificationEvent,
  type ResourceProvider,
  type ResourceType,
  type SeasonMetadataSync,
  type StorageExecutor,
  type TrackedSeason,
  type TrackedSeasonStatusView,
  type VerifiedFile,
  type WorkflowRepository,
} from "@media-track/workflow";
import { findDemoCandidateById, findDemoCandidateByTmdbId } from "./demo-candidates";
import { seedDemoWorkflowRepository } from "./demo-workflow";
import { resolveRegistration, deriveBootstrapState, canManageAccounts } from "./account-bootstrap";
import { isDemoMode } from "./demo-mode";

export type CandidateTrackingRequestResult =
  | {
      status: "queued" | "already_running" | "already_tracked";
      workflowRunId: string | null;
      trackedSeasonId: string;
    }
  | {
      status: "unsupported";
      message: string;
    };

let repository: WorkflowRepository | null = null;
let demoSeedPromise: Promise<void> | null = null;
let fakeResourceProvider: ResourceProvider | null = null;
let fakeStorageExecutor: StorageExecutor | null = null;
// Per-signature model cache (keyed by adapter|baseURL|modelId|apiKey) so multiple
// accounts with different LLM configs each keep their own built model — a single
// slot would thrash between accounts in multi-user mode.
const agentModelCache = new Map<string, ReturnType<typeof createAgentModelFromEnv>>();

/** The Postgres connection string for durable dev/prod state. SQLite has been
 *  retired — dev runs on OrbStack Postgres. */
export function postgresConnectionString(): string {
  const url = process.env.MEDIA_TRACK_POSTGRES_URL?.trim();
  if (!url) {
    throw new Error("MEDIA_TRACK_POSTGRES_URL is required (the SQLite dev DB has been retired)");
  }
  return url;
}

export function getWorkflowRepository(): WorkflowRepository {
  if (!repository) {
    repository = createPostgresWorkflowRepositorySync({ connectionString: postgresConnectionString() });
  }
  return repository;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type AuthOutcome =
  | { ok: true; accountId: string; signedCookie: string }
  | { ok: false; error: string };

/** Create a session row + signed httpOnly cookie value for an account. */
async function createLoginSession(accountId: string): Promise<string> {
  const repository = getWorkflowRepository();
  const sessionId = generateSessionId();
  const nowMs = Date.now();
  await repository.createSession({
    id: sessionId,
    accountId,
    expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
  });
  return signSession(sessionId, await getSessionSecret());
}

/**
 * Register a local account (multi-user). v1: open registration (self-host — the
 * operator controls who can reach the instance; login exists to separate data,
 * not to defend a public endpoint). The first account created is the owner, for
 * future group/admin features. Returns a signed session cookie (auto-login).
 */
export async function registerAccount(username: string, password: string): Promise<AuthOutcome> {
  const trimmed = username.trim();
  if (trimmed.length < 2 || password.length < 6) {
    return { ok: false, error: "用户名至少 2 位、密码至少 6 位。" };
  }
  const repository = getWorkflowRepository();
  const passwordHash = await hashPassword(password);
  const decision = resolveRegistration(await repository.listAccounts());
  try {
    if (decision.kind === "adopt-default") {
      // First user on an unclaimed instance: claim acct_default in place so the
      // existing library + drives stay theirs (is_owner already true on seed).
      await repository.adoptDefaultAccount({ username: trimmed, passwordHash });
      return {
        ok: true,
        accountId: DEFAULT_ACCOUNT_ID,
        signedCookie: await createLoginSession(DEFAULT_ACCOUNT_ID),
      };
    }
    const account: Account = {
      id: `acct_${randomBytes(12).toString("hex")}`,
      username: trimmed,
      passwordHash,
      groupId: null,
      isOwner: false,
      createdAt: new Date().toISOString(),
    };
    await repository.createAccount(account);
    return { ok: true, accountId: account.id, signedCookie: await createLoginSession(account.id) };
  } catch (error) {
    if (error instanceof DuplicateUsernameError) {
      return { ok: false, error: "用户名已存在。" };
    }
    throw error;
  }
}

/** Authenticate username+password and start a session. */
export async function loginAccount(username: string, password: string): Promise<AuthOutcome> {
  const account = await getWorkflowRepository().getAccountByUsername(username.trim());
  // Verify even when the account is missing-ish to avoid trivial username probing
  // (the empty-hash default account has no password and can't be logged into).
  const hash = account?.passwordHash ?? "";
  const valid = hash.length > 0 && (await verifyPassword(password, hash));
  if (!account || !valid) {
    return { ok: false, error: "用户名或密码不正确。" };
  }
  return { ok: true, accountId: account.id, signedCookie: await createLoginSession(account.id) };
}

/** Destroy the session behind a signed cookie (logout). Best-effort. */
export async function logoutSession(signedCookie: string | undefined): Promise<void> {
  if (!signedCookie) {
    return;
  }
  const sessionId = verifySession(signedCookie, await getSessionSecret());
  if (sessionId) {
    await getWorkflowRepository().deleteSession(sessionId);
  }
}

/** Self-service password change. Verifies the current password, sets the new hash,
 *  and revokes ALL of the account's sessions (incl. the caller's → must re-login). */
export async function changeOwnPassword(
  accountId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (newPassword.length < 6) {
    return { ok: false, error: "新密码至少 6 位。" };
  }
  const repo = getWorkflowRepository();
  const acct = await repo.getAccountById(accountId);
  const valid = Boolean(acct && acct.passwordHash.length > 0 && (await verifyPassword(currentPassword, acct.passwordHash)));
  if (!acct || !valid) {
    return { ok: false, error: "当前密码不正确。" };
  }
  await repo.setAccountPassword(accountId, await hashPassword(newPassword));
  await repo.deleteSessionsForAccount(accountId);
  return { ok: true };
}

/** Owner-only reset of another account's password (no current-password needed).
 *  Server-enforced owner check — NOT just hidden UI. Revokes the target's sessions. */
export async function resetUserPassword(
  ownerAccountId: string,
  targetAccountId: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const repo = getWorkflowRepository();
  const owner = await repo.getAccountById(ownerAccountId);
  if (!canManageAccounts(owner)) {
    return { ok: false, error: "无权限。" };
  }
  if (newPassword.length < 6) {
    return { ok: false, error: "新密码至少 6 位。" };
  }
  const target = await repo.getAccountById(targetAccountId);
  if (!target) {
    return { ok: false, error: "账号不存在。" };
  }
  await repo.setAccountPassword(targetAccountId, await hashPassword(newPassword));
  await repo.deleteSessionsForAccount(targetAccountId);
  return { ok: true };
}

/** Bootstrap state for the /login claim screen: is the instance unclaimed, and does
 *  the default account already own a library (→ "接管" vs "创建" copy). */
export async function getBootstrapState(): Promise<{ needsClaim: boolean; hasExistingLibrary: boolean }> {
  const repo = getWorkflowRepository();
  const accounts = await repo.listAccounts();
  const library = await repo.listTrackedSeasonStates(DEFAULT_ACCOUNT_ID);
  return deriveBootstrapState(accounts, library.length);
}

/** Current account's display summary for the sidebar identity block — NEVER the
 *  password hash. Null when there's no real account (unauthenticated sentinel).
 *
 *  Per-request memoized via `cache()`: the identity loader renders twice on
 *  multi-user pages (desktop footer + mobile top-bar copy) and both call this —
 *  `cache()` dedupes the `getAccountById` DB read within a single request so we
 *  only hit the DB once even with two mounted loaders. (Next.js / React.cache
 *  per-request memoization pattern.) */
export const getCurrentAccountSummary = cache(
  async (): Promise<{ username: string; isOwner: boolean } | null> => {
    const acct = await getWorkflowRepository().getAccountById(await getCurrentAccountId());
    return acct ? { username: acct.username, isOwner: acct.isOwner } : null;
  },
);

export interface ManagedAccount {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
  driveCount: number;
}

/** Owner-only: sanitized account list for the 账号管理 panel (no password hashes).
 *  Returns null for non-owners — server-side gate, not just hidden UI. */
export async function listManagedAccounts(ownerAccountId: string): Promise<ManagedAccount[] | null> {
  const repo = getWorkflowRepository();
  const owner = await repo.getAccountById(ownerAccountId);
  if (!canManageAccounts(owner)) {
    return null;
  }
  const accounts = await repo.listAccounts();
  const summaries: ManagedAccount[] = [];
  for (const account of accounts) {
    const drives = await repo.listConnectedStorages(account.id);
    summaries.push({
      id: account.id,
      username: account.username,
      isOwner: account.isOwner,
      createdAt: account.createdAt,
      driveCount: drives.length,
    });
  }
  return summaries;
}

/** §7 P1: multi-user mode gates the login/register UI + session enforcement.
 *  Default OFF → single-user, no login, everything is the implicit default
 *  account (P0 behavior, zero-change). */
export function isMultiUserEnabled(): boolean {
  return process.env.MEDIA_TRACK_MULTI_USER === "1";
}

export const SESSION_COOKIE_NAME = "mt_session";

/** Whether the mt_session cookie should carry the Secure flag.
 *  MEDIA_TRACK_COOKIE_SECURE=0 → false (force off, HTTP-only operators).
 *  MEDIA_TRACK_COOKIE_SECURE=1 → true (force on, enforce HTTPS-only).
 *  Unset → AUTO from the client-facing request scheme: Secure over HTTPS, NOT over
 *  plain HTTP. This is the #60 fix — keying off NODE_ENV (which the Docker image
 *  hard-sets to "production") marked the cookie Secure even on a plain-HTTP LAN/FRP
 *  origin, so the browser never sent it back and login bounced. A reverse proxy /
 *  Cloudflare Tunnel terminates TLS and forwards `x-forwarded-proto`; trust its
 *  first (client-facing) hop, else fall back to the request's own protocol. */
export function isCookieSecure(request: {
  headers: { get(name: string): string | null };
  nextUrl?: { protocol?: string };
}): boolean {
  const explicit = process.env.MEDIA_TRACK_COOKIE_SECURE?.trim();
  if (explicit === "0") return false;
  if (explicit === "1") return true;
  // Scheme spelling varies by proxy/framework: x-forwarded-proto is usually "https"
  // but some send "https:"; nextUrl.protocol is usually "https:" but could be "https".
  // Normalize (lowercase, trim, strip trailing colon) so neither form drops Secure.
  const normalizeScheme = (raw: string) => raw.trim().toLowerCase().replace(/:$/, "");
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return normalizeScheme(forwarded.split(",")[0]!) === "https";
  }
  return normalizeScheme(request.nextUrl?.protocol ?? "") === "https";
}

/** Brand-agnostic custom media-library directory NAMES, read from env and applied
 *  to every drive's connect-time provisioning (115 / 夸克 / 光鸭 all funnel through
 *  provisionCategoryDirs). Names only — never CIDs, and a blank value is omitted so
 *  it falls back to the brand default downstream. The root therefore can never
 *  collapse to the account root, so a drive's write scope stays bounded to its own
 *  container. Read at connect time: changing a name only affects newly-connected drives. */
export function customDirNamesFromEnv(env: NodeJS.ProcessEnv): {
  rootName?: string;
  moviesName?: string;
  tvName?: string;
  animeName?: string;
} {
  const opts: { rootName?: string; moviesName?: string; tvName?: string; animeName?: string } = {};
  const pick = (raw: string | undefined): string | undefined => {
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  };
  const root = pick(env.MEDIA_TRACK_LIBRARY_ROOT_DIR);
  if (root) opts.rootName = root;
  const movies = pick(env.MEDIA_TRACK_LIBRARY_MOVIES_DIR);
  if (movies) opts.moviesName = movies;
  const tv = pick(env.MEDIA_TRACK_LIBRARY_TV_DIR);
  if (tv) opts.tvName = tv;
  const anime = pick(env.MEDIA_TRACK_LIBRARY_ANIME_DIR);
  if (anime) opts.animeName = anime;
  return opts;
}

const SESSION_SECRET_SETTING_KEY = "session_secret";
/** Sentinel account that owns no data — returned in multi-user mode when there
 *  is no valid session, so reads fail CLOSED (empty) instead of leaking the
 *  default account's data to an unauthenticated caller. Middleware normally
 *  redirects first; this is defense-in-depth. */
export const UNAUTHENTICATED_ACCOUNT_ID = "acct_unauthenticated";

let sessionSecretCache: string | null = null;

/** The HMAC secret for session cookies: env override, else a generated value
 *  persisted in global app_settings (self-host: stable across restarts, the
 *  operator needn't manage it). */
export async function getSessionSecret(): Promise<string> {
  if (sessionSecretCache) {
    return sessionSecretCache;
  }
  const envSecret = process.env.MEDIA_TRACK_SESSION_SECRET?.trim();
  if (envSecret) {
    sessionSecretCache = envSecret;
    return envSecret;
  }
  const repository = getWorkflowRepository();
  const stored = (await repository.getSetting(SESSION_SECRET_SETTING_KEY))?.trim();
  if (stored) {
    sessionSecretCache = stored;
    return stored;
  }
  const generated = randomBytes(32).toString("hex");
  await repository.setSetting(SESSION_SECRET_SETTING_KEY, generated);
  sessionSecretCache = generated;
  return generated;
}

/** Resolve a signed session cookie value to its account id, or null if the
 *  signature is bad, the session is unknown, or it has expired. */
export async function resolveSessionAccountId(signedCookie: string): Promise<string | null> {
  const secret = await getSessionSecret();
  const sessionId = verifySession(signedCookie, secret);
  if (!sessionId) {
    return null;
  }
  const session = await getWorkflowRepository().getSession(sessionId);
  if (!session || isSessionExpired(session.expiresAt, new Date().toISOString())) {
    return null;
  }
  return session.accountId;
}

/**
 * The account whose data the current context operates on. Single-user (multi-user
 * disabled) → the implicit default account, with no cookie access (so the worker
 * and non-request contexts are safe). Multi-user → resolve the signed session
 * cookie in a request context; absent/invalid session falls back to the
 * no-data sentinel (fail-closed; middleware redirects to /login first).
 */
/**
 * §7 per-account settings facade. Every settings reader (getLlmConfig,
 * getQualityPreference, getTmdbAccesses, …) takes a `{ getSetting }` source and
 * already falls back to env. Wrapping the repo so `getSetting(key)` resolves
 * `account_settings[account] → global app_settings → (reader's env fallback)`
 * makes ALL of them per-account with ZERO change to the readers themselves:
 * an account's own saved value wins; otherwise the instance-global value (the
 * operator's shared default) applies; otherwise env. acct_default (single-user)
 * has no per-key account_settings, so it reads exactly the global values it
 * always did — single-user behavior is unchanged.
 */
export function getAccountScopedSettings(accountId: string): { getSetting(key: string): Promise<string | null> } {
  const repository = getWorkflowRepository();
  return {
    async getSetting(key: string): Promise<string | null> {
      const own = await repository.getAccountSetting(accountId, key);
      if (own !== null && own !== "") {
        return own;
      }
      return repository.getSetting(key);
    },
  };
}

/**
 * Tree model: resolve the active workspace scope {accountId, connectedStorageId}
 * for a page/data read. `storageId` is the /w/<storageId> route param (undefined
 * on root routes → the account's primary drive). Throws WorkspaceNotFoundError
 * when the param names a drive the account does not own — the route layer maps
 * that to a 404. With no drives bound yet, connectedStorageId is null (single-user
 * fresh; reads then fall back to account-only, unchanged behavior).
 */
export async function getActiveWorkspaceScope(storageId?: string): Promise<WorkflowScope> {
  const accountId = await getCurrentAccountId();
  const storages = await getWorkflowRepository().listConnectedStorages(accountId);
  const connectedStorageId = pickWorkspaceStorageId(
    // Tree model: a workspace is any registered brand's drive (115 or quark), not
    // just 115 — so a quark drive shows up as its own switchable workspace.
    storages.filter((storage) => isRegisteredStorageProvider(storage.provider)),
    storageId,
  );
  return { accountId, connectedStorageId };
}

/** 通知页/角标只展示最近 N 天 —— 旧通知不再无限堆积。 */
export const NOTIFICATION_WINDOW_DAYS = 7;

/** ISO cutoff for the notification window (now − NOTIFICATION_WINDOW_DAYS). */
export function notificationWindowSince(): string {
  return new Date(Date.now() - NOTIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** 取消追踪:解析当前工作区 scope 后委派仓库删除该剧/季的追踪记录(不碰网盘文件)。
 *  mediaKind 区分 movie/tv 命名空间(同一数字 id 可同时是电影和剧集)。 */
export async function untrackTrackedTitle(
  tmdbId: number,
  storageId: string | undefined,
  mediaKind: "movie" | "tv",
  seasonNumber?: number,
): Promise<{ status: "untracked" | "not_found" | "in_flight"; removedSeasons: number }> {
  const scope = await getActiveWorkspaceScope(storageId);
  return getWorkflowRepository().untrackTitle(tmdbId, scope, mediaKind, seasonNumber);
}

/** Resolve a global page's (通知/活动/设置) active workspace from its `?w` param.
 *  Returns the scope to filter content by, the basePath for the sidebar's
 *  library/search links, and the activeStorageId for the sidebar's global links
 *  (undefined = primary → those links stay `?w`-free). A stale `w` falls back to
 *  primary (never 404). */
export async function resolveGlobalWorkspace(w: string | undefined): Promise<{
  accountId: string;
  connectedStorageId: string | null;
  basePath: string;
  activeStorageId: string | undefined;
}> {
  const accountId = await getCurrentAccountId();
  const storages = (await getWorkflowRepository().listConnectedStorages(accountId)).filter((storage) =>
    isRegisteredStorageProvider(storage.provider),
  );
  return { accountId, ...resolveWorkspaceFromParam(storages, w) };
}

/** Count the account's registered drives (115/quark). Used to gate multi-drive
 *  UI like the search isolation note (only meaningful at ≥2 drives). */
export async function getRegisteredDriveCount(): Promise<number> {
  const accountId = await getCurrentAccountId();
  const storages = await getWorkflowRepository().listConnectedStorages(accountId);
  return storages.filter((storage) => isRegisteredStorageProvider(storage.provider)).length;
}

export async function getCurrentAccountId(): Promise<string> {
  if (!isMultiUserEnabled()) {
    return DEFAULT_ACCOUNT_ID;
  }
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    const raw = store.get(SESSION_COOKIE_NAME)?.value;
    if (!raw) {
      return UNAUTHENTICATED_ACCOUNT_ID;
    }
    return (await resolveSessionAccountId(raw)) ?? UNAUTHENTICATED_ACCOUNT_ID;
  } catch {
    // No request scope (the in-process worker) — it resolves credentials per
    // claimed run.accountId, not via the request cookie.
    return DEFAULT_ACCOUNT_ID;
  }
}

export async function ensureDemoSeeded(targetRepository: WorkflowRepository): Promise<void> {
  // Only the public read-only demo deploy should ever be seeded. Without this
  // gate, a fresh SELF-HOSTED instance (empty DB) would get demo fake drives
  // (demo115/demoquark) + fake tracked titles auto-inserted into acct_default on
  // first page load — confusing garbage that looks like the owner bound real
  // drives. Gate on isDemoMode() so only the Vercel demo (MEDIA_TRACK_DEMO_MODE=1)
  // reaches the emptiness check below; non-demo instances never seed.
  if (!isDemoMode()) {
    return;
  }
  if (process.env.MEDIA_TRACK_DEMO_SEED === "0") {
    return;
  }
  demoSeedPromise ??= seedDemoIfEmpty(targetRepository);
  await demoSeedPromise;
}

export async function getWorkflowStatusView(
  targetRepository: WorkflowRepository,
  accountId?: string,
): Promise<TrackedSeasonStatusView | null> {
  const resolvedAccountId = accountId ?? (await getCurrentAccountId());
  const trackedStates = await targetRepository.listTrackedSeasonStates(resolvedAccountId);
  // The spotlight is the season that still needs attention: prefer an
  // actively-airing season over completed ones.
  const firstTracked =
    trackedStates.find((state) => state.season.status === "active") ?? trackedStates[0];
  if (!firstTracked) {
    return null;
  }
  return getTrackedSeasonStatusView({
    repository: targetRepository,
    trackedSeasonId: firstTracked.season.id,
    accountId: resolvedAccountId,
  });
}

export async function queueCandidateTracking(
  candidateId: string,
  connectedStorageId?: string | null,
): Promise<CandidateTrackingRequestResult> {
  const accountId = await getCurrentAccountId();
  const workspace = await resolveQueueStorage(accountId, connectedStorageId);
  if (workspace.frozen) {
    return { status: "unsupported", message: "该网盘已掉线，请重新扫码绑定同一个 115 后再获取。" };
  }
  const movieTmdbId = parseMovieCandidateId(candidateId);
  if (movieTmdbId !== null) {
    const movie = await movieTargetFromTmdbId(movieTmdbId);
    if (!movie) {
      return { status: "unsupported", message: "无法获取该电影的信息。" };
    }
    const request = await queueMovieAcquisition({
      title: movie.title,
      keyword: movie.keyword,
      repository: getWorkflowRepository(),
      accountId,
      connectedStorageId: workspace.id,
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${movie.title.id}_movie`,
    };
  }

  const target = await trackingTargetFromCandidateId(candidateId);
  if (!target) {
    return {
      status: "unsupported",
      message: "暂时只支持剧集第 1 季的后台获取。",
    };
  }

  const request = await queueTrackingInitialization({
    title: target.title,
    season: target.season,
    keyword: target.keyword,
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: workspace.id,
  });
  const status = request.status === "completed" ? "queued" : request.status;

  return {
    status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: request.trackedSeasonId,
  };
}

/**
 * Crash recovery for the single-instance in-process worker: any run still
 * "running" when the server (re)starts is orphaned by a dead worker (only this
 * process executes runs), so requeue it to be claimed again. Returns the count.
 */
export async function recoverOrphanedRuns(): Promise<number> {
  return getWorkflowRepository().requeueRunningWorkflowRuns();
}

/**
 * §7 P0 startup migration (idempotent): move a pre-multi-account deployment's
 * single global 115 cookie into a `connected_storages` row owned by the implicit
 * default account, with CIDs from the env the worker used to read. Single-user
 * deployments see no behavior change — the worker resolves the same cookie, just
 * from the per-account connection record. Best-effort; logged, never throws.
 */
export async function runStartupMigrations(): Promise<void> {
  try {
    const result = await migrateLegacyCookieToDefaultAccount({
      repository: getWorkflowRepository(),
      env: process.env,
      now: new Date().toISOString(),
    });
    if (result.migrated) {
      console.log(
        `[media-track] migrated legacy 115 cookie → ${DEFAULT_ACCOUNT_ID} connected_storage (uid ${result.providerUid})`,
      );
    }
    // Tree model: pin legacy tracked rows (null connected_storage_id) to each
    // account's primary drive. Runs after the cookie migration so acct_default
    // has its drive. Idempotent — already-pinned rows are untouched.
    const filled = await getWorkflowRepository().backfillConnectedStorageId();
    if (filled > 0) {
      console.log(`[media-track] backfilled connected_storage_id on ${filled} legacy row(s)`);
    }
  } catch (error) {
    console.error(`[media-track] startup migration failed: ${String(error)}`);
  }
}

/**
 * §7 form B: resolve the per-account worker context for a CLAIMED run. The worker
 * drains a cross-account queue; for each run it calls this with the run's owner so
 * the acquisition transfers to THAT account's 115 (cookie + landing CIDs), not a
 * shared one. model/resourceProvider/language stay global (shared author LLM/
 * PanSou) for v1 — per-account LLM/Prowlarr is a later refinement.
 */
function buildAccountContextResolver(): ResolveAccountWorkerContext {
  return async (accountId: string, connectedStorageId?: string | null) => {
    // Per-account settings (account_settings → global → env) drive the agent
    // model, resource providers, language and quality — so each user's
    // acquisition searches with THEIR config (operator's global/env is the
    // shared fallback when an account hasn't set its own). The 115 storage +
    // landing CIDs are resolved per (account, storage) so the run lands on the
    // specific drive it was queued onto.
    const scoped = getAccountScopedSettings(accountId);
    const parents = await getWorkerStorageParents(accountId, connectedStorageId);
    const { model, preferredLanguage, qualityPreference } = await getAgentModel(scoped);
    // The run's drive brand selects its resource sources (quark→PanSou quark-only;
    // 115→PanSou+Prowlarr). null when no drive resolves → default 115 fallback.
    const driveProvider =
      (await getAccountStorageCredentials(accountId, connectedStorageId))?.provider ?? "pan115";
    return {
      storage: await getWorkerStorageExecutor(accountId, connectedStorageId),
      resourceProvider: await getWorkerResourceProvider(scoped, driveProvider),
      storageProvider: driveProvider,
      model,
      ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
      ...(qualityPreference === undefined ? {} : { qualityPreference }),
      storageParentDirectoryId: parents.tv,
      animeStorageParentDirectoryId: parents.anime,
      moviesParentDirectoryId: parents.movies,
    };
  };
}

export async function runNextQueuedWorkflow() {
  const repository = getWorkflowRepository();
  // §7 form B: the worker resolves each CLAIMED run's account credentials via
  // resolveAccountContext (claim-first), so bob's acquisition lands in bob's 115.
  // The base deps below are the default account's, used as the fallback the
  // resolver overrides per run.
  const accountId = DEFAULT_ACCOUNT_ID;
  await hydratePan115CookieFromDb();
  // The user's language preference is standing context baked into the agent
  // instance (one global preference), so every workflow — movie, series, type2,
  // anime — searches with it. No per-workflow plumbing.
  const { model, preferredLanguage, qualityPreference } = await getAgentModel(getAccountScopedSettings(accountId));
  const language = preferredLanguage === undefined ? {} : { preferredLanguage };
  const quality = qualityPreference === undefined ? {} : { qualityPreference };
  const storage = await getWorkerStorageExecutor(accountId);
  const parents = await getWorkerStorageParents(accountId);
  const resolveAccountContext = buildAccountContextResolver();
  const startedAt = new Date().toISOString();
  const type2 = await runQueuedType2Workflow({
    repository,
    resourceProvider: await getWorkerResourceProvider(),
    storage,
    model,
    ...language,
    ...quality,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
    resolveAccountContext,
  });
  if (type2.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
    return type2;
  }
  const series = await runQueuedSeriesInitialization({
    repository,
    resourceProvider: await getWorkerResourceProvider(),
    storage,
    model,
    ...language,
    ...quality,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
    resolveAccountContext,
  });
  if (series.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
    return series;
  }
  const movie = await runQueuedMovieAcquisition({
    repository,
    resourceProvider: await getWorkerResourceProvider(),
    storage,
    model,
    ...language,
    ...quality,
    moviesParentDirectoryId: parents.movies,
    resolveAccountContext,
  });
  if (movie.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
  }
  return movie;
}

/** The user's preferred subtitle language for acquisition search, or undefined
 *  when unset / "any" (agent searches broadly). */
export async function getPreferredLanguage(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string | undefined> {
  const value = (await repository.getSetting(PREFERRED_LANGUAGE_SETTING_KEY))?.trim();
  // Explicit "不限" → no preference. Unset → the product default the Settings UI
  // shows as selected ("中文（默认）"), so a fresh install actually prefers Chinese
  // subtitles instead of silently searching broadly.
  if (value === "any") {
    return undefined;
  }
  return value || "中文";
}

export const PREFERRED_LANGUAGE_SETTING_KEY = "preferred_language";

export const QUALITY_PREFERENCE_SETTING_KEY = "quality_preference";

/** The user's acquisition quality preference, or undefined when 不限/unset
 *  (the default). undefined → inject NO quality guidance (coverage-only, current
 *  behavior). Only "high"/"medium" are honored; anything else (incl. the legacy
 *  "4K" value) is treated as 不限. */
export async function getQualityPreference(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<"high" | "medium" | undefined> {
  const value = (await repository.getSetting(QUALITY_PREFERENCE_SETTING_KEY))?.trim();
  return value === "high" || value === "medium" ? value : undefined;
}

// AI 模型 (LLM) 三件套 — OpenAI-compatible. Stored in the user's OWN app_settings
// (self-host, BYO-key: the operator never sees these). DB overrides .env.
export const LLM_BASE_URL_SETTING_KEY = "llm_base_url";
export const LLM_API_KEY_SETTING_KEY = "llm_api_key";
export const LLM_MODEL_ID_SETTING_KEY = "llm_model_id";

/** The user's configured OpenAI-compatible LLM (Settings → AI 模型). Each field is
 *  undefined when unset/blank, so `getAgentModel` cleanly falls back to .env. */
export async function getLlmConfig(repository: {
  getSetting(key: string): Promise<string | null>;
}): Promise<{ baseURL: string | undefined; apiKey: string | undefined; modelId: string | undefined }> {
  const read = async (key: string): Promise<string | undefined> => {
    const value = (await repository.getSetting(key))?.trim();
    return value ? value : undefined;
  };
  return {
    baseURL: await read(LLM_BASE_URL_SETTING_KEY),
    apiKey: await read(LLM_API_KEY_SETTING_KEY),
    modelId: await read(LLM_MODEL_ID_SETTING_KEY),
  };
}

export const TMDB_API_KEY_SETTING_KEY = "tmdb_api_key";

/** Author-deployed CF Worker that proxies TMDB with the author's key (KV-cached).
 *  env TMDB_PROXY_BASE_URL overrides it (e.g. a user who self-hosts the worker). */
export const DEFAULT_TMDB_PROXY_BASE_URL = "https://media-track-tmdb-proxy.fancydirty.workers.dev";

/** Ordered TMDB access channels: user's own key (direct) → env token (direct) →
 *  the proxy Worker (always last, no token — the Worker injects the author's).
 *  Each HTTP call tries them in order; a dead user key falls through to the proxy. */
export async function getTmdbAccesses(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TmdbAccess[]> {
  const accesses: TmdbAccess[] = [];
  const userKey = (await repository.getSetting(TMDB_API_KEY_SETTING_KEY))?.trim();
  if (userKey) {
    accesses.push({ baseURL: TMDB_DIRECT_BASE_URL, readToken: userKey });
  }
  const envToken = env.TMDB_READ_TOKEN?.trim();
  if (envToken) {
    accesses.push({ baseURL: TMDB_DIRECT_BASE_URL, readToken: envToken });
  }
  const proxyBase = env.TMDB_PROXY_BASE_URL?.trim() || DEFAULT_TMDB_PROXY_BASE_URL;
  accesses.push({ baseURL: proxyBase });
  return accesses;
}

export const PANSOU_BASE_URL_SETTING_KEY = "pansou_base_url";

/** Default public PanSou instance (author-hosted), used when neither the DB
 *  setting nor env overrides it. The compose stack injects PANSOU_BASE_URL to
 *  point at the bundled `pansou` service instead. */
export const DEFAULT_PANSOU_BASE_URL = "https://so.252035.xyz";

/** The PanSou search aggregator base URL: DB setting > env PANSOU_BASE_URL >
 *  public default. No runtime container auto-detection — compose wires the
 *  service name and this lets a self-hoster override it by hand. */
export async function getPanSouBaseUrl(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dbValue = (await repository.getSetting(PANSOU_BASE_URL_SETTING_KEY))?.trim();
  if (dbValue) return dbValue;
  const envValue = env.PANSOU_BASE_URL?.trim();
  if (envValue) return envValue;
  return DEFAULT_PANSOU_BASE_URL;
}

export const PROWLARR_BASE_URL_SETTING_KEY = "prowlarr_base_url";
export const PROWLARR_API_KEY_SETTING_KEY = "prowlarr_api_key";

/** The user's configured Prowlarr indexer aggregator (Settings → 资源提供商).
 *  Each field undefined when unset/blank → getWorkerResourceProvider skips it. */
export async function getProwlarrConfig(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ baseURL: string | undefined; apiKey: string | undefined }> {
  const read = async (key: string, envKey: string): Promise<string | undefined> => {
    const dbValue = (await repository.getSetting(key))?.trim();
    if (dbValue) return dbValue;
    const envValue = env[envKey]?.trim();
    return envValue ? envValue : undefined;
  };
  return {
    baseURL: await read(PROWLARR_BASE_URL_SETTING_KEY, "PROWLARR_BASE_URL"),
    apiKey: await read(PROWLARR_API_KEY_SETTING_KEY, "PROWLARR_API_KEY"),
  };
}

export const DAILY_SWEEP_TIME_SETTING_KEY = "daily_sweep_time";
/** Default daily 巡检 time (Beijing) when the user hasn't configured one. */
export const DEFAULT_DAILY_SWEEP_TIME = "06:00";

/** The configured daily-sweep time as "HH:MM" (Beijing), or the 06:00 default
 *  when unset/malformed. The self-hosted scheduler fires run-type3 at this time. */
export async function getDailySweepTime(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string> {
  const value = (await repository.getSetting(DAILY_SWEEP_TIME_SETTING_KEY))?.trim();
  return value && /^\d{2}:\d{2}$/.test(value) ? value : DEFAULT_DAILY_SWEEP_TIME;
}

function parseMovieCandidateId(candidateId: string): number | null {
  const match = /^tmdb_movie_(\d+)$/.exec(candidateId);
  return match ? Number(match[1]) : null;
}

export async function movieTargetFromTmdbId(
  tmdbId: number,
): Promise<{ title: MediaTitle; keyword: string } | null> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    return prepareMovieTarget({
      tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
    });
  }
  const candidate = findDemoCandidateByTmdbId(tmdbId);
  if (!candidate || candidate.mediaType !== "movie") {
    return null;
  }
  const title: MediaTitle = {
    id: `tmdb_movie_${candidate.tmdbId}`,
    tmdbId: candidate.tmdbId,
    type: "movie",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    releaseDate: candidate.releaseDate ?? null,
    aliases:
      candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    overview: candidate.overview,
  };
  return { title, keyword: candidate.title };
}

export type CandidateReserveRequestResult =
  | { status: "reserved" | "already_running" | "already_tracked"; trackedSeasonId: string }
  | { status: "unsupported"; message: string };

/**
 * 预定 an unreleased film: track it (carrying its release date) WITHOUT running
 * the agent. The daily patrol's air-time gate acquires it once it releases.
 * Movies only (TV/anime have no reserve concept).
 */
export async function reserveCandidate(
  candidateId: string,
  connectedStorageId?: string | null,
): Promise<CandidateReserveRequestResult> {
  const movieTmdbId = parseMovieCandidateId(candidateId);
  if (movieTmdbId === null) {
    return { status: "unsupported", message: "只有电影可以预定。" };
  }
  const movie = await movieTargetFromTmdbId(movieTmdbId);
  if (!movie) {
    return { status: "unsupported", message: "无法获取该电影的信息。" };
  }
  const accountId = await getCurrentAccountId();
  const workspace = await resolveQueueStorage(accountId, connectedStorageId);
  if (workspace.frozen) {
    return { status: "unsupported", message: "该网盘已掉线，请重新扫码绑定同一个 115 后再预定。" };
  }
  const request = await reserveMovie({
    title: movie.title,
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: workspace.id,
  });
  return { status: request.status, trackedSeasonId: `${movie.title.id}_movie` };
}

/**
 * Outbound push rides on the feed: whatever notifications a run persisted
 * are delivered to every user-configured channel (DB config > env). Delivery
 * failures are logged, never thrown — the run already succeeded.
 */
async function pushNotificationsSince(
  targetRepository: WorkflowRepository,
  sinceIso: string,
): Promise<void> {
  try {
    // Cross-account: the drain/sweep may have completed runs for several accounts.
    // Each notification is tagged with its owning account so it goes to THAT
    // user's channels (push config resolved per-account: account → global → env).
    const recent = (await targetRepository.listRecentNotificationsWithAccount({ limit: 100 })).filter(
      (entry) => entry.notification.createdAt >= sinceIso,
    );
    if (recent.length === 0) {
      return;
    }

    type RecentEntry = { connectedStorageId: string | null; notification: NotificationEvent };
    const byAccount = new Map<string, RecentEntry[]>();
    for (const { accountId, connectedStorageId, notification } of recent) {
      const list = byAccount.get(accountId) ?? [];
      list.push({ connectedStorageId, notification });
      byAccount.set(accountId, list);
    }

    for (const [accountId, entries] of byAccount) {
      const settings = getAccountScopedSettings(accountId);
      // Source-drive tags: only when this account has ≥2 drives mounted (else the
      // map is empty and no message carries a source). Resolution is null/unknown
      // safe (legacy run or unbound drive → that entry is simply not tagged).
      const drives = await targetRepository.listConnectedStorages(accountId);
      const sourceLabels = resolveDriveSourceLabels(entries, drives);

      const notifications = entries.map((entry) => entry.notification);
      // A scheduled sweep touches many shows; collapse this account's into ONE
      // digest. User-triggered events stay per-resource — each its own message.
      const scheduled = notifications.filter((notification) => notification.trigger === "scheduled");
      const individual = notifications.filter((notification) => notification.trigger !== "scheduled");

      for (const notification of individual) {
        const sourceLabel = sourceLabels.get(notification.id);
        try {
          await sendPushNotifications({ repository: settings, notification, ...(sourceLabel ? { sourceLabel } : {}) });
        } catch (error) {
          console.error(
            `[media-track] push for ${notification.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (scheduled.length > 0) {
        const digest: NotificationEvent = {
          id: `digest_${accountId}_${sinceIso}`,
          workflowRunId: scheduled[0]!.workflowRunId,
          kind: "daily_digest",
          title: "每日巡检",
          body: formatDailyDigestPushText(scheduled, { sourceLabelById: sourceLabels }),
          createdAt: new Date().toISOString(),
          trigger: "scheduled",
        };
        try {
          await sendPushNotifications({ repository: settings, notification: digest });
        } catch (error) {
          console.error(
            `[media-track] digest push failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(`[media-track] notification push batch failed: ${String(error)}`);
  }
}

export async function queueCandidateSeries(
  candidateId: string,
  connectedStorageId?: string | null,
): Promise<CandidateTrackingRequestResult> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  const accountId = await getCurrentAccountId();
  const workspace = await resolveQueueStorage(accountId, connectedStorageId);
  if (workspace.frozen) {
    return { status: "unsupported", message: "该网盘已掉线，请重新扫码绑定同一个 115 后再获取。" };
  }
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    const target = await prepareSeriesTarget({
      tmdbId: parsed.tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(accountId))),
    });
    const request = await queueSeriesInitialization({
      title: target.title,
      seasons: target.seasons,
      keyword: target.keyword,
      repository: getWorkflowRepository(),
      accountId,
      connectedStorageId: workspace.id,
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${target.title.id}_s${target.seasons[0]?.seasonNumber ?? 1}`,
    };
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  const request = await queueSeriesInitialization({
    title: {
      id: `tmdb_tv_${candidate.tmdbId}`,
      tmdbId: candidate.tmdbId,
      type: "tv",
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      aliases:
        candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    },
    seasons: candidate.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.episodeCount,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: workspace.id,
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: `tmdb_tv_${candidate.tmdbId}_s1`,
  };
}

export const LAST_SWEEP_DATE_SETTING_KEY = "last_sweep_date";

/** Beijing wall-clock "date" (YYYY-MM-DD) and "HH:MM" right now. */
function beijingDateTime(): { date: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${get("hour")}:${get("minute")}` };
}

/**
 * The daily 巡检. The configured sweep time is the single source of truth: any
 * trigger (Vercel cron, self-hosted scheduler, manual) just pings this, and the
 * gate runs the sweep at most once per Beijing day, only once the clock has
 * reached the user-configured time — so the Settings time is authoritative
 * regardless of how often the trigger fires. `force` bypasses the gate for
 * on-demand "sweep now".
 */
export async function runScheduledType3(options?: { force?: boolean }): Promise<{
  outcomes: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  skipped?: "already_swept_today" | "before_scheduled_time";
  scheduledFor?: string;
}> {
  const repository = getWorkflowRepository();
  let claimedDay = false;
  if (!options?.force) {
    const target = await getDailySweepTime(repository);
    const { date, hhmm } = beijingDateTime();
    const lastDate = (await repository.getSetting(LAST_SWEEP_DATE_SETTING_KEY))?.trim();
    if (date === lastDate) {
      return { skipped: "already_swept_today", outcomes: [] };
    }
    if (hhmm < target) {
      return { skipped: "before_scheduled_time", scheduledFor: target, outcomes: [] };
    }
    // Claim the day BEFORE running, so a second near-simultaneous trigger no-ops
    // instead of launching a duplicate sweep. If the sweep then fails wholesale
    // (cookie hydration, agent-node init, infra), we RELEASE the claim below so
    // the next ping retries today rather than skipping until tomorrow.
    await repository.setSetting(LAST_SWEEP_DATE_SETTING_KEY, date);
    claimedDay = true;
  }
  const startedAt = new Date().toISOString();
  let result: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  try {
    await hydratePan115CookieFromDb();
    const sync = tmdbSeasonMetadataSync();
    const accountId = await getCurrentAccountId();
    const { model, preferredLanguage, qualityPreference } = await getAgentModel(getAccountScopedSettings(accountId));
    const parents = await getWorkerStorageParents(accountId);
    result = await runScheduledType3Monitoring({
      repository,
      resourceProvider: await getWorkerResourceProvider(),
      storage: await getWorkerStorageExecutor(accountId),
      model,
      ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
      ...(qualityPreference === undefined ? {} : { qualityPreference }),
      storageParentDirectoryId: parents.tv,
      animeStorageParentDirectoryId: parents.anime,
      moviesParentDirectoryId: parents.movies,
      staleActiveRunTimeoutMs: 30 * 60 * 1000,
      resolveAccountContext: buildAccountContextResolver(),
      ...(sync ? { syncSeasonMetadata: sync } : {}),
    });
    await pushNotificationsSince(repository, startedAt);
    return { outcomes: result };
  } catch (error) {
    // The sweep failed before completing — release today's claim so the next
    // ping retries instead of skipping until tomorrow. Per-season failures are
    // swallowed inside the monitor, so this only fires on infra-level errors.
    if (claimedDay) {
      try {
        await repository.setSetting(LAST_SWEEP_DATE_SETTING_KEY, "");
      } catch {
        // best-effort release; nothing else to do
      }
    }
    throw error;
  }
}

/**
 * The Type 3 sweep's TMDB re-sync (the GUI's `sync_all`): refresh each tracked
 * season's aired/total from TMDB so the sweep discovers episodes that aired
 * after tracking began. Returns undefined when TMDB isn't configured, leaving
 * the sweep on stored counts.
 */
function tmdbSeasonMetadataSync(): SeasonMetadataSync | undefined {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER !== "tmdb") {
    return undefined;
  }
  return async ({ tmdbId, seasonNumber }) => {
    const target = await prepareTrackingTarget({
      tmdbId,
      mediaType: "tv",
      seasonNumber,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
    });
    return {
      latestAiredEpisode: target.season.latestAiredEpisode,
      totalEpisodes: target.season.totalEpisodes,
    };
  };
}

async function seedDemoIfEmpty(targetRepository: WorkflowRepository): Promise<void> {
  const tracked = await targetRepository.listTrackedSeasonStates();
  if (tracked.length > 0) {
    return;
  }
  await seedDemoWorkflowRepository(targetRepository);
}

async function trackingTargetFromCandidateId(candidateId: string): Promise<{
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return null;
  }

  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    return prepareTrackingTarget({
      tmdbId: parsed.tmdbId,
      mediaType: "tv",
      seasonNumber: parsed.seasonNumber,
      qualityPreference: defaultQuality(),
      storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
    });
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  return targetFromSearchCandidate(candidate, parsed.seasonNumber, candidateId);
}

function targetFromSearchCandidate(
  candidate: MediaSearchCandidate,
  seasonNumber: number,
  candidateId: string,
): {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null {
  const season = candidate.seasons.find((item) => item.seasonNumber === seasonNumber);
  if (!season) {
    return null;
  }
  const titleId = `tmdb_tv_${candidate.tmdbId}`;
  const title: MediaTitle = {
    id: titleId,
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases: candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
  };
  const trackedSeason: TrackedSeason = {
    id: candidateId,
    mediaTitleId: title.id,
    seasonNumber,
    status: season.latestAiredEpisode >= season.episodeCount ? "completed" : "active",
    qualityPreference: defaultQuality(),
    storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
    totalEpisodes: season.episodeCount,
    latestAiredEpisode: season.latestAiredEpisode,
    latestAiredSource: "metadata",
  };
  return {
    title,
    season: trackedSeason,
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
  };
}

function parseTvCandidateId(candidateId: string): { tmdbId: number; seasonNumber: number } | null {
  const match = /^tmdb_tv_(\d+)_s(\d+)$/.exec(candidateId);
  if (!match) {
    return null;
  }
  return {
    tmdbId: Number(match[1]),
    seasonNumber: Number(match[2]),
  };
}

async function getWorkerResourceProvider(
  settings: { getSetting(key: string): Promise<string | null> } = getWorkflowRepository(),
  provider: string = "pan115",
): Promise<ResourceProvider> {
  if (process.env.MEDIA_TRACK_WORKFLOW_ADAPTER === "pansou") {
    // Per-brand assembly: a quark drive gets PanSou restricted to quark links and
    // NO Prowlarr (磁力 115-only); a 115 drive gets PanSou(115/magnet) + Prowlarr.
    const kinds: readonly string[] = isRegisteredStorageProvider(provider)
      ? getStorageBrand(provider).resourceProviderKinds
      : ["pansou-115", "prowlarr"];
    // 夸克 → quark-only links; 光鸭(磁力) → magnet-only; 115 → 115 + magnet.
    const allowedTypes: ResourceType[] = allowedResourceTypesForKinds(kinds);
    const providers: Array<{ name: string; provider: ResourceProvider }> = [
      {
        name: "pansou",
        provider: new PanSouResourceProvider({ baseURL: await getPanSouBaseUrl(settings), allowedTypes }),
      },
    ];
    if (kinds.includes("prowlarr")) {
      const prowlarr = await getProwlarrConfig(settings);
      if (prowlarr.baseURL && prowlarr.apiKey) {
        providers.push({
          name: "prowlarr",
          provider: new ProwlarrResourceProvider({ baseURL: prowlarr.baseURL, apiKey: prowlarr.apiKey }),
        });
      }
    }
    return providers.length > 1
      ? new CompositeResourceProvider({ providers })
      : providers[0]!.provider;
  }
  fakeResourceProvider ??= new FakeResourceProvider({
    keywordResults: {
      "翘楚 4K": [
        {
          title: "翘楚 S01E01-S01E12 4K",
        },
      ],
      "绝命毒师 4K": [
        {
          title: "绝命毒师 S01E01-S01E07 4K",
        },
      ],
    },
  });
  return fakeResourceProvider;
}

/** §7: the account's 115 credentials (cookie + category CIDs) from its
 *  connected_storages record. null when the account hasn't connected a 115 yet
 *  (then the worker falls back to the legacy env cookie / env CIDs). */
interface GuangYaCredential {
  accessToken: string;
  refreshToken: string;
  deviceId?: string;
}

interface AccountStorageCredentials {
  id: string;
  /** The drive's brand — drives executor/probe/resource dispatch (tree model). */
  provider: string;
  status: "active" | "frozen";
  /** Cookie credential for cookie-auth brands (115/夸克). Empty for token-auth
   *  brands (光鸭), which carry their token blob in `credential` instead. */
  cookie: string;
  /** Token blob for token-auth brands (光鸭: {accessToken,refreshToken,deviceId}).
   *  null for cookie-auth brands. */
  credential: GuangYaCredential | null;
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
}

/** Pull a drive's brand-appropriate credential out of its connected_storage
 *  payload. 115/夸克 store a cookie string; 光鸭 stores a token blob. Returns a
 *  presence flag the resolver uses the SAME way it used a non-empty cookie. */
function extractStorageCredential(
  provider: string,
  payload: unknown,
): { cookie: string; credential: GuangYaCredential | null } {
  if (provider === "guangya") {
    const blob = (payload ?? {}) as { accessToken?: string; refreshToken?: string; deviceId?: string };
    const accessToken = blob.accessToken?.trim() ?? "";
    const refreshToken = blob.refreshToken?.trim() ?? "";
    if (!accessToken || !refreshToken) {
      return { cookie: "", credential: null };
    }
    const credential: GuangYaCredential = { accessToken, refreshToken };
    if (blob.deviceId !== undefined) {
      credential.deviceId = blob.deviceId;
    }
    return { cookie: "", credential };
  }
  const cookie = (payload as { cookie?: string } | null)?.cookie?.trim() ?? "";
  return { cookie, credential: null };
}

/**
 * Provision a drive's media tree (Mediary Scout/{Movies,TV,Anime}) under the
 * account root and return the CIDs. Uses an UNRESTRICTED bootstrap executor — a
 * fresh drive has no write scope yet, and the scope is meant to come FROM these
 * dirs (the catch-22 that left 115 drives stuck "目录待建"). Bounded, idempotent
 * (find-or-create, no deletes). 115 root and 夸克 root are both "0"; 光鸭 root is "".
 */
async function provisionDriveCategoryDirs(
  provider: string,
  cookie: string,
  credential: GuangYaCredential | null,
): Promise<{ rootCid: string; moviesCid: string; tvCid: string; animeCid: string }> {
  if (provider === "guangya") {
    const executor = createExecutorForBrand({ provider: "guangya", credential: credential ?? {}, scopeCids: [] });
    return provisionCategoryDirs({
      baseParentId: "", // 光鸭 account root
      ...customDirNamesFromEnv(process.env),
      storage: {
        listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
        createDirectory: (dir) => executor.createDirectory(dir),
      },
    });
  }
  const executor =
    provider === "quark"
      ? createExecutorForBrand({ provider: "quark", cookie, scopeCids: [] })
      : createBootstrapPan115CookieStorageExecutor({ cookie });
  return provisionCategoryDirs({
    baseParentId: "0",
    ...customDirNamesFromEnv(process.env),
    storage: {
      listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
      createDirectory: (dir) => executor.createDirectory(dir),
    },
  });
}

/**
 * Build the persist hook handed to a 光鸭 executor: when the client rotates its
 * token pair (refresh on 401), write the new {accessToken,refreshToken,deviceId}
 * back into this drive's connected_storage payload so the next run starts from the
 * fresh tokens. Re-reads the row at call time to preserve its CIDs/label/meta
 * (mirrors the cookie-refresh upsert in connectGuangYa). Best-effort: a persist
 * failure is logged, not thrown — the in-memory client keeps the new tokens for
 * the rest of the run regardless.
 */
function makeGuangYaTokenPersister(
  accountId: string,
  storageId: string,
): (creds: unknown) => Promise<void> {
  return async (creds) => {
    try {
      const tokens = (creds ?? {}) as { accessToken?: string; refreshToken?: string; deviceId?: string };
      if (!tokens.accessToken || !tokens.refreshToken) {
        return;
      }
      const repository = getWorkflowRepository();
      const drive = (await repository.listConnectedStorages(accountId)).find((s) => s.id === storageId);
      if (!drive) {
        console.warn(`[media-track] 光鸭 token refresh: drive ${storageId} vanished, skip persist`);
        return;
      }
      const prevMeta = (drive.payload as { meta?: unknown } | null)?.meta;
      const payload = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        ...(tokens.deviceId === undefined ? {} : { deviceId: tokens.deviceId }),
        ...(prevMeta === undefined ? {} : { meta: prevMeta }),
      };
      await repository.upsertConnectedStorage({
        id: drive.id,
        accountId,
        provider: drive.provider,
        providerUid: drive.providerUid,
        label: drive.label,
        payload,
        rootCid: drive.rootCid,
        moviesCid: drive.moviesCid,
        tvCid: drive.tvCid,
        animeCid: drive.animeCid,
        createdAt: drive.createdAt,
      });
    } catch (error) {
      console.error(`[media-track] 光鸭 token refresh persist failed for ${storageId}: ${String(error)}`);
    }
  };
}

async function getAccountStorageCredentials(
  accountId: string,
  connectedStorageId?: string | null,
): Promise<AccountStorageCredentials | null> {
  try {
    const storages = await getWorkflowRepository().listConnectedStorages(accountId);
    // Tree model: when a specific drive is pinned (the run's connected_storage_id),
    // resolve THAT drive; otherwise the account's first registered-brand drive
    // (single-drive / primary). Brand-agnostic — 115 or quark. Never silently fall
    // through to another drive.
    const drive = connectedStorageId
      ? storages.find(
          (storage) => storage.id === connectedStorageId && isRegisteredStorageProvider(storage.provider),
        )
      : storages.find((storage) => isRegisteredStorageProvider(storage.provider));
    if (!drive) {
      return null;
    }
    const { cookie, credential } = extractStorageCredential(drive.provider, drive.payload);
    // No usable credential (no cookie for 115/夸克, no token blob for 光鸭) → treat
    // as not-connected, exactly like the old empty-cookie guard.
    if (!cookie && !credential) {
      return null;
    }
    let { rootCid, moviesCid, tvCid, animeCid } = drive;
    // Self-heal: a live-mode drive with missing category CIDs (e.g. connect-time
    // provisioning was skipped/failed → "目录待建") gets provisioned on first use,
    // so the queued acquisition just proceeds — no manual rebind. Idempotent;
    // persisted so subsequent runs skip. Best-effort: a failure leaves the CIDs
    // null and the scoped executor still fails loud (surfaced, not silent).
    const liveMode = process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115";
    if (liveMode && drive.status === "active" && !(rootCid && moviesCid && tvCid && animeCid)) {
      try {
        const p = await provisionDriveCategoryDirs(drive.provider, cookie, credential);
        ({ rootCid, moviesCid, tvCid, animeCid } = p);
        await getWorkflowRepository().upsertConnectedStorage({
          id: drive.id,
          accountId,
          provider: drive.provider,
          providerUid: drive.providerUid,
          label: drive.label,
          payload: drive.payload,
          rootCid,
          moviesCid,
          tvCid,
          animeCid,
          createdAt: drive.createdAt,
        });
        console.log(`[media-track] auto-provisioned ${drive.provider} dirs for ${drive.id} (root=${rootCid})`);
      } catch (error) {
        console.error(`[media-track] auto-provision failed for ${drive.id}: ${String(error)}`);
      }
    }
    return {
      id: drive.id,
      provider: drive.provider,
      status: drive.status,
      cookie,
      credential,
      rootCid,
      moviesCid,
      tvCid,
      animeCid,
    };
  } catch (error) {
    console.error(`[media-track] failed to load storage credentials for ${accountId}: ${String(error)}`);
    return null;
  }
}

/**
 * §7 P0: the worker resolves the 115 executor from the run's account credentials
 * (connected_storages.payload.cookie) instead of the global env cookie. Single-
 * user is unchanged: the migrated default-account cookie is byte-identical to the
 * env one. Falls back to the env cookie when the account has no 115 connection
 * (fresh deploy before QR connect, or the legacy env-only path).
 */
/**
 * Resolve the drive a queued acquisition lands on (the active workspace): the
 * explicit storage when given (the page's /w/<id> workspace), else the account's
 * earliest (primary) drive. Also reports whether that drive is frozen so the
 * queue entrypoints can refuse — a frozen drive (cookie died) must not accept
 * acquisition until re-bound. id is null when the account has no 115 drive yet.
 */
async function resolveQueueStorage(
  accountId: string,
  explicitConnectedStorageId?: string | null,
): Promise<{ id: string | null; frozen: boolean }> {
  try {
    const storages = (await getWorkflowRepository().listConnectedStorages(accountId))
      .filter((storage) => isRegisteredStorageProvider(storage.provider))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const chosen = explicitConnectedStorageId
      ? storages.find((storage) => storage.id === explicitConnectedStorageId)
      : storages[0];
    if (!chosen) {
      return { id: explicitConnectedStorageId ?? null, frozen: false };
    }
    return { id: chosen.id, frozen: chosen.status === "frozen" };
  } catch {
    return { id: explicitConnectedStorageId ?? null, frozen: false };
  }
}

/** Marks a drive frozen — its cookie died. Called when a worker/probe hits a
 *  Pan115AuthError. Resolves the run/drive's owning connected_storage id. */
async function freezeConnectedStorage(storageId: string, reason: string): Promise<void> {
  try {
    await getWorkflowRepository().setConnectedStorageStatus(
      storageId,
      "frozen",
      reason,
      new Date().toISOString(),
    );
    console.warn(`[media-track] froze connected_storage ${storageId}: ${reason}`);
  } catch (error) {
    console.error(`[media-track] failed to freeze ${storageId}: ${String(error)}`);
  }
}

/**
 * Probe a connected drive's cookie with a cheap root listing. A dead cookie
 * (Pan115AuthError) freezes the drive; a healthy one (re-)activates it. This is
 * the explicit "测试连接" trigger and the deterministic freeze/unfreeze hook the
 * e2e drives — independent of waiting for the next acquisition/patrol.
 */
export async function testConnection(
  accountId: string,
  connectedStorageId: string,
): Promise<{ ok: boolean; status: "active" | "frozen"; message: string }> {
  const creds = await getAccountStorageCredentials(accountId, connectedStorageId);
  if (!creds) {
    return { ok: false, status: "frozen", message: "找不到该网盘的凭证。" };
  }
  const brand = getStorageBrand(creds.provider);
  try {
    await probeStorageConnection(
      creds.provider,
      creds.cookie,
      creds.rootCid,
      creds.credential,
      makeGuangYaTokenPersister(accountId, creds.id),
    );
    await getWorkflowRepository().setConnectedStorageStatus(creds.id, "active", null, null);
    return { ok: true, status: "active", message: "连接正常。" };
  } catch (error) {
    // The brand's own dead-cookie signal → freeze; anything else (network/
    // transient) is NOT a reason to freeze.
    if (brand.isAuthError(error)) {
      await freezeConnectedStorage(creds.id, error instanceof Error ? error.message : String(error));
      return { ok: false, status: "frozen", message: `网盘登录已失效，请重新绑定同一个${brand.label}。` };
    }
    return { ok: false, status: creds.status, message: `连接检测失败：${String(error)}` };
  }
}

/** A cheap brand-specific read used to probe whether a drive's cookie is alive.
 *  Throws the brand's auth error on a dead cookie (caller freezes). */
async function probeStorageConnection(
  provider: string,
  cookie: string,
  rootCid: string | null,
  credential: GuangYaCredential | null,
  // Persist rotated tokens if validateToken() refreshes during the probe. Wired by
  // testConnection (an existing drive). Omitted at first-connect (no row yet).
  onTokensRefreshed?: ((creds: unknown) => Promise<void>) | undefined,
): Promise<void> {
  const { Pan115CookieClient, QuarkCookieClient } = await import("@media-track/workflow");
  if (provider === "guangya") {
    // Token-auth: validateToken() does account/v1/user/me + refresh-retry on 401;
    // a dead token pair throws GuangYaAuthError (caller freezes). rootCid unused.
    await new GuangYaClient({
      accessToken: credential?.accessToken ?? "",
      refreshToken: credential?.refreshToken ?? "",
      // Pin the SAME persisted device id as connect/worker so "Test connection"
      // doesn't mint a fresh one (harmless today — validate is account-host — but
      // consistent with the rest of the brand's device-pinning).
      ...(credential?.deviceId === undefined ? {} : { deviceId: credential.deviceId }),
      // A 401 during the probe refreshes the token pair; persist it so the DB
      // doesn't keep a stale token that later wrongly freezes the drive.
      ...(onTokensRefreshed ? { onTokensRefreshed } : {}),
    }).validateToken();
    return;
  }
  if (provider === "quark") {
    await new QuarkCookieClient({ cookie }).listItems({ directoryId: rootCid ?? "0" });
    return;
  }
  if (provider === "pan115") {
    await new Pan115CookieClient({ cookie, listPageDelayMs: 0 }).getDirectoryInfo({
      directoryId: rootCid ?? "0",
    });
    return;
  }
  throw new Error(`unknown storage brand: ${provider}`);
}

/**
 * Whether the background worker has a drive it could use — i.e. whether
 * getWorkerStorageExecutor(acct_default) would succeed rather than throw
 * "PAN115_COOKIE is required". Returns false ONLY in the genuine fresh-deploy case
 * (adapter "115", no acct_default 网盘 bound, no env cookie), so the worker can skip
 * QUIETLY instead of spamming the logs every poll. Cheap + non-throwing.
 */
export async function workerHasConfiguredDrive(): Promise<boolean> {
  if ((process.env.MEDIA_TRACK_STORAGE_ADAPTER ?? "fake") !== "115") {
    return true; // fake/dev executor never needs a cookie
  }
  if ((process.env.PAN115_COOKIE ?? "").trim().length > 0) {
    return true; // legacy env-cookie bootstrap path
  }
  return (await getAccountStorageCredentials(DEFAULT_ACCOUNT_ID)) !== null;
}

async function getWorkerStorageExecutor(
  accountId: string = DEFAULT_ACCOUNT_ID,
  connectedStorageId?: string | null,
): Promise<StorageExecutor> {
  const adapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER ?? "fake";
  // "115" is the legacy name for "real storage mode"; the actual brand now comes
  // from the resolved drive's provider, so a quark drive works under the same gate.
  if (adapter === "115") {
    const creds = await getAccountStorageCredentials(accountId, connectedStorageId);
    if (creds) {
      // Scope writes to THIS drive's own provisioned dirs — not the global env CIDs
      // (which belong to the default account's drive). Dispatch by the drive's
      // brand: 115 → Storage115Executor, quark → QuarkStorageExecutor.
      const scopeCids = [creds.rootCid, creds.moviesCid, creds.tvCid, creds.animeCid].filter(
        (cid): cid is string => Boolean(cid),
      );
      // 光鸭 authenticates with a rotating token blob (not a cookie): pass the
      // credential + a persist hook so a mid-run refresh writes the new tokens back
      // into this drive's payload. 115/夸克 keep the cookie path untouched.
      if (creds.provider === "guangya") {
        return createExecutorForBrand({
          provider: "guangya",
          credential: creds.credential ?? {},
          scopeCids,
          env: process.env,
          onCredentialRefresh: makeGuangYaTokenPersister(accountId, creds.id),
        });
      }
      return createExecutorForBrand({
        provider: creds.provider,
        cookie: creds.cookie,
        scopeCids,
        env: process.env,
      });
    }
    // No drive bound yet → legacy env-cookie 115 path (fresh deploy bootstrap).
    return createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
  }
  if (adapter !== "fake") {
    throw new Error(`MEDIA_TRACK_STORAGE_ADAPTER_UNSUPPORTED: ${adapter}`);
  }
  fakeStorageExecutor ??= new FakeStorageExecutor({
    transferOutcomes: fakeTransferOutcomes(),
  });
  return fakeStorageExecutor;
}

/**
 * The 115 landing parent CIDs for a run's account. Sourced from the account's
 * connected_storage (set at connect-time directory provision); falls back to the
 * env CIDs when the account has no 115 connection or the adapter is fake.
 */
async function getWorkerStorageParents(
  accountId: string = DEFAULT_ACCOUNT_ID,
  connectedStorageId?: string | null,
): Promise<{
  tv: string;
  anime: string;
  movies: string;
}> {
  const creds =
    process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115"
      ? await getAccountStorageCredentials(accountId, connectedStorageId)
      : null;
  return {
    tv: creds?.tvCid || storageParentDirectoryId(),
    anime: creds?.animeCid || creds?.tvCid || animeParentDirectoryId(),
    movies: creds?.moviesCid || moviesParentDirectoryId(),
  };
}

/**
 * The V2 acquisition agent is a bare LanguageModel driving the sandbox tool-loop
 * (not the old AgentNodes). The adapter policy forces vercel-ai whenever the live
 * PanSou provider or 115 storage is in use; the fake adapter gets a no-op stub so
 * dev/demo runs complete without a real model. The preferred subtitle language is
 * passed to each workflow as standing context, not baked into the model instance.
 */
/** Resolve the live agent model config the SAME way the worker builds it: DB
 *  (pass an account-scoped repo) → .env (AGENT_MODEL_* with XIAOMI_MIMO_* as a
 *  back-compat fallback) → undefined. There is NO built-in default endpoint —
 *  baseURL/modelId must be configured (truly BYO, issue #49). Shared by
 *  getAgentModel and testLlmConnectionAction so the Settings「测试连接」exercises
 *  exactly what acquisitions use. */
export async function resolveAgentModelConfig(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ apiKey?: string; baseURL?: string; modelId?: string }> {
  const llm = await getLlmConfig(repository);
  const apiKey = llm.apiKey ?? env.AGENT_MODEL_API_KEY ?? env.XIAOMI_MIMO_API_KEY;
  const baseURL = llm.baseURL ?? env.AGENT_MODEL_BASE_URL ?? env.XIAOMI_MIMO_BASE_URL;
  const modelId = llm.modelId ?? env.AGENT_MODEL_ID ?? env.XIAOMI_MIMO_MODEL_ID;
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(modelId === undefined ? {} : { modelId }),
  };
}

/** Acquire-time LLM pre-check (issue #52): the friendly "configure your model"
 *  message if a LIVE (vercel-ai) acquisition can't run for lack of LLM config,
 *  else null. Resolves config EXACTLY as the worker's getAgentModel does
 *  (account-scoped DB → .env) and reuses the SAME llmConfigError predicate, so a
 *  click that would only die later in the worker is caught NOW — no doomed run is
 *  enqueued, no failed card piles up in 活动. The fake/demo adapter never needs an
 *  LLM → always null (never blocks demo/fake). Common case (configured) → null →
 *  callers behave byte-identically to before (purely additive). Settings/env are
 *  injectable for unit tests; production calls pass the current account id. */
export async function acquireLlmPreflightError(
  arg:
    | string
    | {
        settings: { getSetting(key: string): Promise<string | null> };
        env?: NodeJS.ProcessEnv;
      },
): Promise<string | null> {
  const settings = typeof arg === "string" ? getAccountScopedSettings(arg) : arg.settings;
  const env = typeof arg === "string" ? process.env : arg.env ?? process.env;
  if (env.MEDIA_TRACK_AGENT_ADAPTER !== "vercel-ai") {
    return null;
  }
  const resolved = await resolveAgentModelConfig(settings, env);
  return llmConfigError(resolved);
}

async function getAgentModel(repository: {
  getSetting(key: string): Promise<string | null>;
}): Promise<{
  model: ReturnType<typeof createAgentModelFromEnv>;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
}> {
  assertWorkflowAgentAdapterPolicy(process.env);
  const env = process.env;
  const adapter = env.MEDIA_TRACK_AGENT_ADAPTER === "vercel-ai" ? "vercel-ai" : "fake";
  const preferredLanguage = await getPreferredLanguage(repository);
  const qualityPreference = await getQualityPreference(repository);

  // Resolve the live model config the SAME way the test action does (shared
  // resolver) — DB-first, then .env. No built-in default endpoint.
  const resolved = await resolveAgentModelConfig(repository, env);
  const { apiKey, baseURL, modelId } = resolved;
  // Fail-fast pre-check (issue #49): on the live (vercel-ai) path, if baseURL or
  // modelId is missing the run would die on its first model call (or hit the
  // author endpoint keyless → 401). Throw the actionable, agnostic guidance NOW
  // — before building/using the model — so the user gets guidance at 获取 time
  // instead of a raw failure after a long agent run. apiKey may be empty (keyless
  // local LLM is valid); the fake/stub adapter never needs a model config.
  if (adapter === "vercel-ai") {
    const configError = llmConfigError(resolved);
    if (configError) {
      throw new Error(configError);
    }
  }
  // Cache per resolved config signature (so a Settings edit takes effect without
  // a restart AND different accounts' models coexist).
  const signature = `${adapter}|${baseURL ?? ""}|${modelId ?? ""}|${apiKey ?? ""}`;
  let model = agentModelCache.get(signature);
  if (!model) {
    model = adapter === "vercel-ai" ? createAgentModel(resolved) : createStubAcquisitionModel();
    agentModelCache.set(signature, model);
  }
  return { model, preferredLanguage, qualityPreference };
}

function fakeTransferOutcomes() {
  const outcomes: Record<string, { status: "succeeded"; providerMessage: string; files: VerifiedFile[] }> = {};
  for (let snapshotNumber = 1; snapshotNumber <= 20; snapshotNumber += 1) {
    const candidateId = `snapshot_${snapshotNumber}_candidate_1`;
    outcomes[candidateId] = {
      status: "succeeded",
      providerMessage: "fake transfer completed",
      files: episodeCodes(1, 24).map((code) => fakeVerifiedFile(candidateId, code)),
    };
  }
  return outcomes;
}

function fakeVerifiedFile(candidateId: string, code: string): VerifiedFile {
  return {
    id: `${candidateId}_${code}`,
    storageDirectoryId: "assigned_by_fake_storage",
    name: `Demo.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${candidateId}_${code}`,
  };
}

function episodeCodes(seasonNumber: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => episodeCode(seasonNumber, index + 1));
}

function storageDirectoryIdForCandidate(_candidateId: string): string {
  // Empty means "let the Type 2 workflow create the canonical
  // `Title (Year)/Season N` directory under the configured parent".
  return process.env.MEDIA_TRACK_DEFAULT_TV_STORAGE_DIRECTORY_ID ?? "";
}

function storageParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_TV_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_library_root"
  );
}

/**
 * Separate 115 landing parent for anime. Falls back to the TV parent when
 * MEDIA_TRACK_ANIME_PARENT_CID is unset, so anime simply co-locates with TV
 * until a dedicated Anime directory is configured.
 */
function animeParentDirectoryId(): string {
  return process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? storageParentDirectoryId();
}

function defaultQuality(): string {
  return process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K";
}

export interface ForeignWorkFinding {
  stagingDirectoryId: string;
  files: Array<{ providerFileId: string; sourcePath: string }>;
}

export interface ForeignWorkReview {
  workflowRunId: string;
  titleName: string;
  findings: ForeignWorkFinding[];
}

/** Foreign-work findings recorded by a run, for the user-confirmation page. */
export async function getForeignWorkReview(workflowRunId: string): Promise<ForeignWorkReview | null> {
  const repository = getWorkflowRepository();
  const snapshot = await repository.getWorkflowRunSnapshot(workflowRunId, await getCurrentAccountId());
  if (!snapshot) {
    return null;
  }
  const findings = snapshot.workflowRun.auditEvents
    .filter((event) => event.type === "foreign_work_detected")
    .map((event) => event.data as unknown as ForeignWorkFinding)
    .filter((finding) => Array.isArray(finding?.files) && finding.files.length > 0);
  return { workflowRunId, titleName: snapshot.title.title, findings };
}

export async function importForeignWorkFiles(input: {
  providerFileIds: string[];
  movieTitle: string;
  year: number;
}): Promise<{ movieDirectoryId: string; movedFileIds: string[] }> {
  const accountId = await getCurrentAccountId();
  const parents = await getWorkerStorageParents(accountId);
  return importForeignWorkAsMovie({
    storage: await getWorkerStorageExecutor(accountId),
    providerFileIds: input.providerFileIds,
    movieTitle: input.movieTitle,
    year: input.year,
    moviesParentDirectoryId: parents.movies,
  });
}

function moviesParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_MOVIES_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_movies_root"
  );
}

// ---------------------------------------------------------------------------
// 115 connection (QR login) — cookie lives in the DB once connected; the
// repo-root .env PAN115_COOKIE remains the bootstrap fallback.

const PAN115_COOKIE_KEY = "pan115.cookie";
const PAN115_META_KEY = "pan115.cookieMeta";

let pan115CookieHydrated = false;

/** DB cookie (newer truth from QR connect) wins over the .env bootstrap. */
export async function hydratePan115CookieFromDb(): Promise<void> {
  if (pan115CookieHydrated) {
    return;
  }
  pan115CookieHydrated = true;
  try {
    const cookie = await getWorkflowRepository().getSetting(PAN115_COOKIE_KEY);
    if (cookie) {
      process.env.PAN115_COOKIE = cookie;
    }
  } catch (error) {
    console.error(`[media-track] failed to hydrate 115 cookie from DB: ${String(error)}`);
  }
}

export interface Pan115ConnectionStatus {
  connected: boolean;
  source: "qr" | "env" | "none";
  userName: string | null;
  app: string | null;
  connectedAt: string | null;
}

export async function getPan115ConnectionStatus(): Promise<Pan115ConnectionStatus> {
  const repository = getWorkflowRepository();
  const cookie = await repository.getSetting(PAN115_COOKIE_KEY);
  if (cookie) {
    const metaRaw = await repository.getSetting(PAN115_META_KEY);
    let meta: { userName?: string; app?: string; connectedAt?: string } = {};
    try {
      meta = metaRaw ? (JSON.parse(metaRaw) as typeof meta) : {};
    } catch {
      meta = {};
    }
    return {
      connected: true,
      source: "qr",
      userName: meta.userName ?? null,
      app: meta.app ?? null,
      connectedAt: meta.connectedAt ?? null,
    };
  }
  if (process.env.PAN115_COOKIE) {
    return { connected: true, source: "env", userName: null, app: null, connectedAt: null };
  }
  return { connected: false, source: "none", userName: null, app: null, connectedAt: null };
}

export interface ConnectedStorageView {
  id: string;
  provider: string;
  providerUid: string;
  label: string | null;
  connectedAt: string | null;
  /** Bind time — orders drives (earliest = primary workspace). */
  createdAt: string;
  /** active = usable; frozen = cookie died (re-bind to recover). */
  status: "active" | "frozen";
  /** True once category directories are provisioned (CIDs stored). */
  provisioned: boolean;
}

/**
 * §7 P2: the CURRENT account's connected network drives, sanitized for the
 * settings UI — the cookie/payload is NEVER exposed, only display metadata.
 */
export async function getAccountConnectedStorages(): Promise<ConnectedStorageView[]> {
  const accountId = await getCurrentAccountId();
  const rows = await getWorkflowRepository().listConnectedStorages(accountId);
  return rows.map((row) => {
    const meta = (row.payload as { meta?: { connectedAt?: string } } | null)?.meta;
    return {
      id: row.id,
      provider: row.provider,
      providerUid: row.providerUid,
      label: row.label,
      connectedAt: meta?.connectedAt ?? null,
      createdAt: row.createdAt,
      status: row.status,
      provisioned: Boolean(row.tvCid && row.moviesCid && row.animeCid),
    };
  });
}

/** Thrown when a QR connect targets a 115 already bound to a DIFFERENT account
 *  (instance-wide UNIQUE(provider, provider_uid)). The route surfaces the message. */
export class StorageOwnedByOtherAccountError extends Error {
  constructor() {
    super("该网盘账号已被本实例的其他用户连接，无法重复绑定。");
    this.name = "StorageOwnedByOtherAccountError";
  }
}

/**
 * §7 P2: bind a freshly-exchanged 115 cookie to the CURRENT account's
 * connected_storage, enforcing instance-wide ownership and provisioning the
 * category directories on a genuinely new connection.
 * - reject: the 115 (by provider_uid) already belongs to another account.
 * - refresh: same account re-scanned → update the cookie payload, keep CIDs.
 * - insert: new connection → provision Movies/TV/Anime (or honor env CIDs) + store.
 */
async function bindPan115ConnectedStorage(input: {
  accountId: string;
  cookie: string;
  userName: string;
  app: string;
}): Promise<void> {
  const repository = getWorkflowRepository();
  const providerUid = parsePan115Uid(input.cookie) ?? "pan115_default";
  const existing = await repository.findConnectedStorageByUid("pan115", providerUid);
  const decision = resolveStorageBinding({
    provider: "pan115",
    providerUid,
    accountId: input.accountId,
    existing,
  });
  if (decision.action === "reject") {
    throw new StorageOwnedByOtherAccountError();
  }
  const payload = {
    cookie: input.cookie,
    meta: { userName: input.userName, app: input.app, connectedAt: new Date().toISOString() },
  };
  if (decision.action === "refresh" && existing) {
    // Keep the already-resolved directory CIDs; only refresh the cookie.
    await repository.upsertConnectedStorage({
      id: existing.id,
      accountId: input.accountId,
      provider: "pan115",
      providerUid,
      label: input.userName,
      payload,
      rootCid: existing.rootCid,
      moviesCid: existing.moviesCid,
      tvCid: existing.tvCid,
      animeCid: existing.animeCid,
      createdAt: existing.createdAt,
    });
    return;
  }
  // insert: honor env CIDs if a deploy pre-configured them, else provision a fresh
  // media-track/ tree under the 115 root. Provisioning is best-effort — a failure
  // still stores the connection (worker falls back to env CIDs).
  let cids = {
    rootCid: process.env.MEDIA_TRACK_115_TEST_ROOT_CID ?? null,
    moviesCid: process.env.MEDIA_TRACK_MOVIES_PARENT_CID ?? null,
    tvCid: process.env.MEDIA_TRACK_TV_PARENT_CID ?? null,
    animeCid: process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? null,
  };
  const hasEnvCids = Boolean(cids.tvCid && cids.moviesCid && cids.animeCid);
  if (!hasEnvCids && process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115") {
    try {
      // Bootstrap (unrestricted) executor — a fresh drive has no write scope yet,
      // and the protected/env executor throws without one (the catch-22 that left
      // 115 drives stuck "目录待建"). Steady-state acquisition uses a scoped executor.
      const executor = createBootstrapPan115CookieStorageExecutor({ cookie: input.cookie });
      const provisioned = await provisionCategoryDirs({
        baseParentId: "0", // 115 account root
        ...customDirNamesFromEnv(process.env),
        storage: {
          // listChildDirectories = single-level, root-safe (find-or-create reads
          // the account root's children; recursive listSubdirectories is guarded).
          listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
          createDirectory: (dir) => executor.createDirectory(dir),
        },
      });
      cids = {
        rootCid: provisioned.rootCid,
        moviesCid: provisioned.moviesCid,
        tvCid: provisioned.tvCid,
        animeCid: provisioned.animeCid,
      };
    } catch (error) {
      console.error(`[media-track] 115 directory provision failed (will use env fallback): ${String(error)}`);
    }
  }
  await repository.upsertConnectedStorage({
    id: `cs_${providerUid}`,
    accountId: input.accountId,
    provider: "pan115",
    providerUid,
    label: input.userName,
    payload,
    rootCid: cids.rootCid,
    moviesCid: cids.moviesCid,
    tvCid: cids.tvCid,
    animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });
}

export async function completePan115QrLogin(input: {
  session: { uid: string; time: number; sign: string; qrcodeContent: string };
  app?: string;
}): Promise<{ userName: string; app: string }> {
  const { Pan115QrLoginClient, PAN115_QR_LOGIN_APPS } = await import("@media-track/workflow");
  const app = (PAN115_QR_LOGIN_APPS as readonly string[]).includes(input.app ?? "")
    ? (input.app as (typeof PAN115_QR_LOGIN_APPS)[number])
    : "alipaymini";
  const client = new Pan115QrLoginClient();
  const result = await client.exchangeCookie(input.session, app);
  const accountId = await getCurrentAccountId();
  // Bind to the current account's connected_storage first — this throws on an
  // ownership conflict BEFORE we touch any global state.
  await bindPan115ConnectedStorage({
    accountId,
    cookie: result.cookie,
    userName: result.userName,
    app: result.app,
  });
  const repository = getWorkflowRepository();
  // Back-compat: single-user (default account) still mirrors the cookie into the
  // global setting + env so the legacy env path keeps working. Multi-user accounts
  // do NOT pollute the shared global cookie.
  if (accountId === DEFAULT_ACCOUNT_ID) {
    await repository.setSetting(PAN115_COOKIE_KEY, result.cookie);
    await repository.setSetting(
      PAN115_META_KEY,
      JSON.stringify({
        userName: result.userName,
        app: result.app,
        connectedAt: new Date().toISOString(),
      }),
    );
    process.env.PAN115_COOKIE = result.cookie;
    pan115CookieHydrated = true;
  }
  return { userName: result.userName, app: result.app };
}

/**
 * Tree model: bind a pasted 夸克 cookie to the current account as a new drive
 * (brand "quark"). 夸克 QR-login is not cleanly automatable and the browser
 * automation skill forbids auto-reading cookies, so v1 takes the cookie the user
 * copies from their Network request header (Copy as cURL). Enforces instance-wide
 * ownership (same uid can't belong to two accounts) and provisions the
 * media-track/{Movies,TV,Anime} tree on a genuinely new connection (best-effort).
 */
export async function connectQuarkCookie(rawCookie: string): Promise<{ providerUid: string }> {
  const cookie = rawCookie.trim();
  if (!cookie) {
    throw new Error("请粘贴夸克 cookie。");
  }
  const providerUid = parseQuarkUid(cookie);
  if (!providerUid) {
    throw new Error(
      "无法从该 cookie 解析夸克账号（需包含 __uid 或 __kps）；请从浏览器 Network 请求头复制完整 Cookie（Copy as cURL 最省事）。",
    );
  }
  const accountId = await getCurrentAccountId();
  const repository = getWorkflowRepository();
  const existing = await repository.findConnectedStorageByUid("quark", providerUid);
  const decision = resolveStorageBinding({ provider: "quark", providerUid, accountId, existing });
  if (decision.action === "reject") {
    throw new StorageOwnedByOtherAccountError();
  }
  const payload = { cookie, meta: { connectedAt: new Date().toISOString() } };
  if (decision.action === "refresh" && existing) {
    // Same account re-bind → refresh the cookie, keep the resolved CIDs.
    await repository.upsertConnectedStorage({
      id: existing.id,
      accountId,
      provider: "quark",
      providerUid,
      label: existing.label,
      payload,
      rootCid: existing.rootCid,
      moviesCid: existing.moviesCid,
      tvCid: existing.tvCid,
      animeCid: existing.animeCid,
      createdAt: existing.createdAt,
    });
    return { providerUid };
  }
  // insert: provision the category tree under the 夸克 root ("0"). Best-effort —
  // a failure still stores the connection (worker falls back to env CIDs / none).
  let cids: { rootCid: string | null; moviesCid: string | null; tvCid: string | null; animeCid: string | null } = {
    rootCid: null,
    moviesCid: null,
    tvCid: null,
    animeCid: null,
  };
  try {
    const executor = createExecutorForBrand({ provider: "quark", cookie, scopeCids: [] });
    cids = await provisionCategoryDirs({
      baseParentId: "0", // 夸克 account root
      ...customDirNamesFromEnv(process.env),
      storage: {
        listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
        createDirectory: (dir) => executor.createDirectory(dir),
      },
    });
  } catch (error) {
    console.error(`[media-track] 夸克 directory provision failed (will store without CIDs): ${String(error)}`);
  }
  const idSuffix = providerUid.replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
  await repository.upsertConnectedStorage({
    id: `cs_quark_${idSuffix}`,
    accountId,
    provider: "quark",
    providerUid,
    label: null,
    payload,
    rootCid: cids.rootCid,
    moviesCid: cids.moviesCid,
    tvCid: cids.tvCid,
    animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });
  return { providerUid };
}

/**
 * 夸克扫码登录:用 CAS service_ticket 兑换 drive cookie,再走与 cookie 粘贴**完全
 * 相同**的绑定/provision(connectQuarkCookie 即那条核心,接收 cookie 串)。最终凭证
 * 有效性由用户真机扫码确认;兑换失败时设置页折叠的 cookie 粘贴是回退。
 */
export async function completeQuarkQrLogin(serviceTicket: string): Promise<{ providerUid: string }> {
  const { QuarkQrLoginClient } = await import("@media-track/workflow");
  const { cookie } = await new QuarkQrLoginClient().exchangeCookie(serviceTicket);
  return connectQuarkCookie(cookie);
}

/**
 * 光鸭云盘:粘贴 access_token + refresh_token 绑定为一块新盘。与 connectQuarkCookie
 * 同构,只是凭证是 token 二元组(非 cookie)且认证走 validateToken()(account/v1/user/me)
 * 而非 listItems。validateToken() 返回 sub 作为 providerUid(键 UNIQUE(provider,uid));
 * token 失效会抛 GuangYaAuthError → 报错返回。绑定/provision/refresh 全镜像夸克路径。
 */
export async function connectGuangYa(rawAccessToken: string, rawRefreshToken: string): Promise<{ providerUid: string }> {
  const accessToken = rawAccessToken.trim();
  const refreshToken = rawRefreshToken.trim();
  if (!accessToken || !refreshToken) {
    throw new Error("请填写光鸭 access_token 与 refresh_token。");
  }
  // Pin a stable device id ONCE at connect time. Persisting it (vs. letting the
  // client auto-generate a fresh one each worker run) keeps the `Did` header
  // constant across runs, so 光鸭's risk control sees one device, not many.
  const deviceId = generateGuangYaDeviceId();
  // validateToken() confirms the pair is live AND yields the authoritative sub.
  const client = new GuangYaClient({ accessToken, refreshToken, deviceId });
  let providerUid: string;
  try {
    providerUid = await client.validateToken();
  } catch (error) {
    throw new Error(
      `无法用该 token 登录光鸭云盘（请确认 access_token / refresh_token 完整且未过期）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const accountId = await getCurrentAccountId();
  const repository = getWorkflowRepository();
  const existing = await repository.findConnectedStorageByUid("guangya", providerUid);
  const decision = resolveStorageBinding({ provider: "guangya", providerUid, accountId, existing });
  if (decision.action === "reject") {
    throw new StorageOwnedByOtherAccountError();
  }
  const payload = { accessToken, refreshToken, deviceId, meta: { connectedAt: new Date().toISOString() } };
  if (decision.action === "refresh" && existing) {
    // Same account re-bind → refresh the token blob, keep the resolved CIDs.
    // Reuse the already-pinned deviceId (风控: a re-bind must NOT look like a new
    // device); only fall back to the freshly-generated one if the drive has none.
    const pinnedDeviceId = (existing.payload as { deviceId?: string } | null)?.deviceId ?? deviceId;
    await repository.upsertConnectedStorage({
      id: existing.id,
      accountId,
      provider: "guangya",
      providerUid,
      label: existing.label,
      payload: { accessToken, refreshToken, deviceId: pinnedDeviceId, meta: { connectedAt: new Date().toISOString() } },
      rootCid: existing.rootCid,
      moviesCid: existing.moviesCid,
      tvCid: existing.tvCid,
      animeCid: existing.animeCid,
      createdAt: existing.createdAt,
    });
    return { providerUid };
  }
  // insert: provision the category tree under the 光鸭 root (""). Best-effort — a
  // failure still stores the connection (worker self-heals/falls back later).
  let cids: { rootCid: string | null; moviesCid: string | null; tvCid: string | null; animeCid: string | null } = {
    rootCid: null,
    moviesCid: null,
    tvCid: null,
    animeCid: null,
  };
  try {
    const executor = createExecutorForBrand({
      provider: "guangya",
      credential: { accessToken, refreshToken, deviceId },
      scopeCids: [],
    });
    cids = await provisionCategoryDirs({
      baseParentId: "", // 光鸭 account root
      ...customDirNamesFromEnv(process.env),
      storage: {
        listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
        createDirectory: (dir) => executor.createDirectory(dir),
      },
    });
  } catch (error) {
    console.error(`[media-track] 光鸭 directory provision failed (will store without CIDs): ${String(error)}`);
  }
  const idSuffix = providerUid.replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
  await repository.upsertConnectedStorage({
    id: `cs_guangya_${idSuffix}`,
    accountId,
    provider: "guangya",
    providerUid,
    label: null,
    payload,
    rootCid: cids.rootCid,
    moviesCid: cids.moviesCid,
    tvCid: cids.tvCid,
    animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });
  return { providerUid };
}
