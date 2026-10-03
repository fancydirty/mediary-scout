import type { ConnectDb, InstanceCredentialRow, InstanceLinkRequestRow } from "./db.js";
import type { RouteDeps } from "./routes.js";
import { assertSameOriginRequest, readJsonBody, upsertAccount } from "./routes.js";
import { HttpError, htmlPage, json } from "./http.js";
import { checkRateLimit, SIGNUP_EMAIL_RATE_LIMIT, SIGNUP_IP_RATE_LIMIT, SIGNUP_RATE_WINDOW_MS } from "./rate-limit.js";
import { sha256Hex } from "./crypto-token.js";
import { signToken, verifyToken, type TokenPurpose } from "./signed-token.js";
import { buildSessionCookie } from "./session.js";
import { EMAIL_MAX_LENGTH, EMAIL_RE } from "./validation.js";
import { instanceLinkPage } from "./html/instance-link-page.js";
import { newId } from "./ids.js";

const INSTANCE_LINK_TTL_MS = 30 * 60_000;
const VERIFY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

interface InstanceLinkDb extends ConnectDb {
  insertInstanceLinkRequest(row: InstanceLinkRequestRow): Promise<void>;
  getInstanceLinkRequestById(id: string): Promise<InstanceLinkRequestRow | null>;
  getInstanceLinkRequestByPollSecretSha(sha: string): Promise<InstanceLinkRequestRow | null>;
  approveInstanceLinkRequest(id: string, accountId: string, nowIso: string): Promise<boolean>;
  markInstanceLinkDelivered(id: string, nowIso: string): Promise<boolean>;
  touchInstanceLinkPoll(id: string, nowIso: string): Promise<void>;
  insertInstanceCredential(row: InstanceCredentialRow): Promise<void>;
  revokeOtherInstanceCredentials(accountId: string, keepId: string, nowIso: string): Promise<void>;
  getActiveInstanceCredentialBySha(sha: string): Promise<InstanceCredentialRow | null>;
  revokeInstanceCredential(id: string, nowIso: string): Promise<void>;
  touchInstanceCredential(id: string, nowIso: string): Promise<void>;
}

type InstanceLinkDeps = RouteDeps & {
  sendInstanceLinkEmail: (
    to: string,
    details: { url: string; verifyCode: string; requestIp: string; requestedAt: string },
  ) => Promise<void>;
};

function dbOf(deps: RouteDeps): InstanceLinkDb {
  return deps.db as InstanceLinkDb;
}

function randomBytesBase64Url(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}



function verifyCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += VERIFY_ALPHABET[b % VERIFY_ALPHABET.length];
  return out;
}

function requestedIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "";
}

async function instanceLinkRateLimited(request: Request, email: string, deps: RouteDeps): Promise<boolean> {
  const ip = requestedIp(request);
  if (ip !== "") {
    const ipResult = await checkRateLimit({
      store: deps.db,
      bucket: "instance_link_ip",
      key: ip,
      limit: SIGNUP_IP_RATE_LIMIT,
      windowMs: SIGNUP_RATE_WINDOW_MS,
      now: () => Date.parse(deps.now()),
    });
    if (!ipResult.allowed) return true;
  }
  const emailResult = await checkRateLimit({
    store: deps.db,
    bucket: "instance_link_email",
    key: email,
    limit: SIGNUP_EMAIL_RATE_LIMIT,
    windowMs: SIGNUP_RATE_WINDOW_MS,
    now: () => Date.parse(deps.now()),
  });
  return !emailResult.allowed;
}

function instanceLinkTokenPurpose(): TokenPurpose {
  // TokenPurpose gains this member with the instance-link migration. Keeping the
  // cast here allows the module to be loaded against an older worker during a
  // rolling deploy; verifyToken still rejects it until the matching code lands.
  return "instance-link" as TokenPurpose;
}

async function signInstanceLinkToken(id: string, deps: RouteDeps): Promise<string> {
  return signToken(
    { purpose: instanceLinkTokenPurpose(), subject: id },
    { key: deps.sessionSecret, ttlMs: INSTANCE_LINK_TTL_MS, now: Date.parse(deps.now()) },
  );
}

async function verifyInstanceLinkToken(
  token: string,
  deps: RouteDeps,
): Promise<{ subject: string; expired: boolean } | null> {
  const result = await verifyToken(token, {
    key: deps.sessionSecret,
    expectPurpose: instanceLinkTokenPurpose(),
    now: Date.parse(deps.now()),
  });
  if (result.ok) return { subject: result.subject, expired: false };
  if (result.reason !== "expired") return null;
  // The signed token and the database request expire together. Verify the
  // signature once more at the epoch so a valid, expired token can reach the
  // row-level 410 response without accepting a forged subject.
  const expiredResult = await verifyToken(token, {
    key: deps.sessionSecret,
    expectPurpose: instanceLinkTokenPurpose(),
    now: 0,
  });
  return expiredResult.ok ? { subject: expiredResult.subject, expired: true } : null;
}

/** POST /api/instance-link/start. */
export async function startInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const body = await readJsonBody(request);
  const raw = body.email;
  if (typeof raw !== "string") throw new HttpError(400, "email required");
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }
  if (await instanceLinkRateLimited(request, email, deps)) {
    return json({ error: "too_many_requests" }, 429, { noStore: true });
  }
  const now = deps.now();
  const expiresAt = new Date(Date.parse(now) + INSTANCE_LINK_TTL_MS).toISOString();
  const pollSecret = randomBytesBase64Url(32);
  const row: InstanceLinkRequestRow = {
    id: newId("ilr"),
    poll_secret_sha256: await sha256Hex(pollSecret),
    email,
    verify_code: verifyCode(),
    status: "pending",
    account_id: null,
    request_ip: requestedIp(request) || null,
    created_at: now,
    expires_at: expiresAt,
    approved_at: null,
    delivered_at: null,
    last_polled_at: null,
  };
  await dbOf(deps).insertInstanceLinkRequest(row);
  const origin = deps.waffoEnvironment === "test"
    ? new URL(request.url).origin
    : `https://${deps.rootDomain.trim().toLowerCase()}`;
  const token = await signInstanceLinkToken(row.id, deps);
  const url = `${origin}/link?t=${encodeURIComponent(token)}`;
  try {
    await (deps as InstanceLinkDeps).sendInstanceLinkEmail(email, {
      url,
      verifyCode: row.verify_code,
      requestIp: row.request_ip ?? "",
      requestedAt: row.created_at,
    });
  } catch {
    // Sender logs the non-secret status; link start stays enumeration-safe.
  }
  return json({ pollSecret, verifyCode: row.verify_code, expiresAt, interval: 3 }, 202, { noStore: true });
}

/** GET /link confirmation page. */
export async function instanceLinkLanding(url: URL, deps: RouteDeps): Promise<Response> {
  const token = await verifyInstanceLinkToken(url.searchParams.get("t") ?? "", deps);
  if (token === null) return htmlPage(instanceLinkPage({ kind: "invalid" }), { noStore: true });
  const row = await dbOf(deps).getInstanceLinkRequestById(token.subject);
  if (row === null) {
    return htmlPage(instanceLinkPage({ kind: "invalid" }), { noStore: true });
  }
  if (row.status !== "pending") {
    return htmlPage(instanceLinkPage({ kind: "confirmed" }), { noStore: true });
  }
  if (Date.parse(deps.now()) >= Date.parse(row.expires_at)) {
    return htmlPage(instanceLinkPage({ kind: "invalid" }), { noStore: true });
  }
  return htmlPage(
    instanceLinkPage({
      kind: "pending",
      email: row.email,
      verifyCode: row.verify_code,
      requestIp: row.request_ip ?? "",
      requestedAt: row.created_at,
    }),
    { noStore: true },
  );
}

/** POST /link confirmation action. */
export async function confirmInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const body = await readJsonBody(request);
  const token = typeof body.t === "string" ? body.t.trim() : "";
  const verified = await verifyInstanceLinkToken(token, deps);
  if (verified === null) throw new HttpError(400, "invalid or expired link");
  const db = dbOf(deps);
  const row = await db.getInstanceLinkRequestById(verified.subject);
  if (row === null) throw new HttpError(400, "invalid or expired link");
  if (row.status !== "pending") throw new HttpError(409, "already_confirmed");
  if (verified.expired || Date.parse(deps.now()) >= Date.parse(row.expires_at)) {
    throw new HttpError(410, "expired");
  }
  // routes.ts owns the race-safe account upsert; this path is only reachable after
  // the mailbox proof, so it also updates the console session like magic login.
  const account = await upsertAccount(row.email, deps);
  await db.updateAccountLastLogin(account.id, deps.now());
  const approved = await db.approveInstanceLinkRequest(verified.subject, account.id, deps.now());
  if (!approved) {
    const latest = await db.getInstanceLinkRequestById(verified.subject);
    if (latest !== null && Date.parse(deps.now()) >= Date.parse(latest.expires_at)) {
      throw new HttpError(410, "expired");
    }
    throw new HttpError(409, "already_confirmed");
  }
  const cookie = await buildSessionCookie(account.id, {
    secret: deps.sessionSecret,
    ttlMs: 30 * 24 * 3600_000,
    now: Date.parse(deps.now()),
  });
  const response = json({ ok: true }, 200, { noStore: true });
  response.headers.set("set-cookie", cookie);
  return response;
}

/** POST /api/instance-link/poll. */
export async function pollInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const body = await readJsonBody(request);
  const secret = typeof body.pollSecret === "string" ? body.pollSecret : "";
  if (!secret || !B64URL_RE.test(secret)) return json({ status: "unknown" }, 404, { noStore: true });
  const db = dbOf(deps);
  const row = await db.getInstanceLinkRequestByPollSecretSha(await sha256Hex(secret));
  if (row === null) return json({ status: "unknown" }, 404, { noStore: true });
  const now = deps.now();
  // Once delivered, the one-time result is terminal; never turn a second poll
  // into slow_down and accidentally reveal whether delivery happened.
  if (row.status === "delivered") return json({ status: "delivered" }, 410, { noStore: true });
  if (row.status === "pending" && Date.parse(now) >= Date.parse(row.expires_at)) {
    return json({ status: "expired" }, 410, { noStore: true });
  }
  // Approved requests must all reach the delivery CAS: a concurrent loser is
  // required to report the terminal delivered state rather than slow_down.
  if (row.status !== "approved" && row.last_polled_at !== null) {
    const elapsed = Date.parse(now) - Date.parse(row.last_polled_at);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 2_000) {
      return json({ status: "slow_down" }, 429, { noStore: true });
    }
  }
  await db.touchInstanceLinkPoll(row.id, now);
  if (row.status === "pending") {
    return json({ status: "pending" }, 200, { noStore: true });
  }
  const delivered = await db.markInstanceLinkDelivered(row.id, now);
  if (!delivered) return json({ status: "delivered" }, 410, { noStore: true });
  if (row.account_id === null) throw new HttpError(500, "instance link missing account");
  const credential = `ic_${randomBytesBase64Url(32)}`;
  const credentialId = newId("icr");
  await db.insertInstanceCredential({
    id: credentialId,
    account_id: row.account_id,
    credential_sha256: await sha256Hex(credential),
    link_request_id: row.id,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  });
  await db.revokeOtherInstanceCredentials(row.account_id, credentialId, now);
  return json({ status: "approved", credential, email: row.email }, 200, { noStore: true });
}

/** POST /api/instance-link/revoke. */
export async function revokeInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(ic_[A-Za-z0-9_-]{43,})$/.exec(auth);
  if (match === null) throw new HttpError(401, "unauthorized");
  const db = dbOf(deps);
  const row = await db.getActiveInstanceCredentialBySha(await sha256Hex(match[1]!));
  if (row === null) throw new HttpError(401, "unauthorized");
  await db.revokeInstanceCredential(row.id, deps.now());
  return json({ ok: true }, 200, { noStore: true });
}

// Kept exported for focused tests and for dispatchers that prefer verb-neutral names.
export const handleInstanceLinkStart = startInstanceLink;
export const handleInstanceLinkLanding = instanceLinkLanding;
export const handleInstanceLinkConfirm = confirmInstanceLink;
export const handleInstanceLinkPoll = pollInstanceLink;
export const handleInstanceLinkRevoke = revokeInstanceLink;
