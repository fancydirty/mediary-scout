import type { CfApi } from "./cf-api.js";
import type { ConnectDb } from "./db.js";
import { HttpError, handleError, htmlPage, json } from "./http.js";
import { requireAdmin } from "./auth.js";
import { provisionEndpoint } from "./provision.js";
import { revokeEndpoint } from "./revoke.js";
import { revealByCode } from "./reveal.js";
import { assertSlug } from "./slug.js";
import { homePage } from "./html/home-page.js";
import { adminPage } from "./html/admin-page.js";
import { invitePage, type InvitePageState } from "./html/invite-page.js";
import { EMAIL_MAX_LENGTH, EMAIL_RE } from "./validation.js";
import { newId } from "./ids.js";
import { sha256Hex } from "./crypto-token.js";

// Same aperture mark as apps/web/app/icon.svg — the product brand.
const LOGO_SVG =
  '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="16" fill="#1ED760"/><g transform="translate(4,4)" fill="none" stroke="#0B3B1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></g></svg>';

export interface RouteDeps {
  db: ConnectDb;
  cf: CfApi;
  adminToken: string;
  rootDomain: string;
  tokenWrapKeyHex: string;
  now: () => string;
  newInviteId: () => string;
  newEndpointId: () => string;
  newAuditId: () => string;
  newInviteCode: () => string;
}

export async function handleRequest(request: Request, deps: RouteDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (e) {
    return handleError(e);
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid body");
  }
  return parsed as Record<string, unknown>;
}

function optString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "bad encoding");
  }
}

async function route(request: Request, deps: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // www.* → apex, preserving path (and query).
  if (url.hostname.toLowerCase().startsWith("www.")) {
    const target = new URL(url.toString());
    target.hostname = url.hostname.slice("www.".length);
    return Response.redirect(target.toString(), 301);
  }

  if (method === "GET" && path === "/") {
    return htmlPage(homePage());
  }
  if (method === "GET" && path === "/healthz") {
    return new Response("ok", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  // Brand logo for Access Custom Pages + invite page — self-hosted so we don't
  // depend on any external asset host.
  if (method === "GET" && path === "/logo.svg") {
    return new Response(LOGO_SVG, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }
  if (method === "GET" && path === "/admin") {
    return htmlPage(adminPage());
  }

  // ---- admin api (bearer required) ----
  if (path === "/api/admin/invites") {
    requireAdmin(request, deps.adminToken);
    if (method === "GET") {
      return json({ invites: await deps.db.listInvites() });
    }
    if (method === "POST") {
      return await createInvite(request, url, deps);
    }
    throw new HttpError(404, "not found");
  }

  if (path === "/api/admin/endpoints" && method === "GET") {
    requireAdmin(request, deps.adminToken);
    // PUBLIC shape only — token_ciphertext / token_sha256 (and CF-internal
    // resource ids besides the tunnel id) must never leave the server.
    const endpoints = (await deps.db.listEndpoints()).map((ep) => ({
      id: ep.id,
      invite_id: ep.invite_id,
      slug: ep.slug,
      hostname: ep.hostname,
      status: ep.status,
      token_shown_at: ep.token_shown_at,
      created_at: ep.created_at,
      revoked_at: ep.revoked_at,
      cf_tunnel_id: ep.cf_tunnel_id,
    }));
    return json({ endpoints });
  }

  const provisionMatch = path.match(/^\/api\/admin\/invites\/([^/]+)\/provision$/);
  if (provisionMatch !== null && method === "POST") {
    requireAdmin(request, deps.adminToken);
    return await provisionInvite(request, url, deps, decodeParam(provisionMatch[1] ?? ""));
  }

  const revokeMatch = path.match(/^\/api\/admin\/endpoints\/([^/]+)\/revoke$/);
  if (revokeMatch !== null && method === "POST") {
    requireAdmin(request, deps.adminToken);
    const endpointId = decodeParam(revokeMatch[1] ?? "");
    // 404 (not 500) for a missing endpoint — the admin client distinguishes
    // "already gone" from "revoke failed".
    if ((await deps.db.getEndpointById(endpointId)) === null) {
      throw new HttpError(404, "endpoint not found");
    }
    const result = await revokeEndpoint({
      endpointId,
      deps: { cf: deps.cf, db: deps.db, now: deps.now, newAuditId: deps.newAuditId },
    });
    return json({ hostname: result.hostname, revoked: true });
  }

  // ---- invitee ----
  const inviteMatch = path.match(/^\/i\/([^/]+)$/);
  if (inviteMatch !== null && method === "GET") {
    const state = await inviteState(deps, decodeParam(inviteMatch[1] ?? ""));
    return htmlPage(invitePage(state));
  }

  const revealMatch = path.match(/^\/api\/i\/([^/]+)\/reveal$/);
  if (revealMatch !== null && method === "POST") {
    return await revealInvite(deps, decodeParam(revealMatch[1] ?? ""));
  }

  // ---- public waitlist ----
  if (path === "/waitlist" && method === "POST") {
    return await addToWaitlist(request, deps);
  }

  // ---- instance status reporting (bearer token auth) ----
  if (path === "/api/instance/status" && method === "POST") {
    return await reportInstanceStatus(request, deps);
  }

  throw new HttpError(404, "not found");
}

async function createInvite(request: Request, url: URL, deps: RouteDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const emailRaw = body.email;
  if (typeof emailRaw !== "string") {
    throw new HttpError(400, "email required");
  }
  const email = emailRaw.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new HttpError(400, "invalid email");
  }
  // Validate/normalize the slug at creation time so a bad slug fails fast
  // (400 here) instead of later at provision.
  const slugRaw = optString(body.slug);
  let slug: string | null = null;
  if (slugRaw !== null) {
    try {
      slug = assertSlug(slugRaw);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "invalid slug");
    }
  }
  const invite = await deps.db.insertInvite({
    id: deps.newInviteId(),
    code: deps.newInviteCode(),
    invitee_label: optString(body.invitee_label),
    email,
    slug,
    status: "pending",
    created_at: deps.now(),
    provisioned_at: null,
    revoked_at: null,
  });
  await deps.db.insertAudit({
    id: deps.newAuditId(),
    at: deps.now(),
    actor: "admin",
    action: "invite.create",
    invite_id: invite.id,
    endpoint_id: null,
    detail_json: JSON.stringify({ email }),
  });
  return json(
    { id: invite.id, code: invite.code, inviteUrl: `${url.origin}/i/${invite.code}` },
    201,
  );
}

async function provisionInvite(
  request: Request,
  url: URL,
  deps: RouteDeps,
  inviteId: string,
): Promise<Response> {
  const invite = await deps.db.getInviteById(inviteId);
  if (invite === null) {
    throw new HttpError(404, "invite not found");
  }
  const body = await readJsonBody(request);
  const slugRaw = optString(body.slug) ?? invite.slug;
  if (slugRaw === null) {
    throw new HttpError(400, "slug required");
  }
  let slug: string;
  try {
    slug = assertSlug(slugRaw);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "invalid slug");
  }
  if (invite.status !== "pending") {
    throw new HttpError(409, "invite not pending");
  }
  let result;
  try {
    result = await provisionEndpoint({
      inviteId: invite.id,
      slug,
      deps: {
        cf: deps.cf,
        db: deps.db,
        rootDomain: deps.rootDomain,
        tokenWrapKeyHex: deps.tokenWrapKeyHex,
        now: deps.now,
        newEndpointId: deps.newEndpointId,
        newAuditId: deps.newAuditId,
      },
    });
  } catch (e) {
    // Domain conflicts (TOCTOU races past the pre-checks above) are client
    // errors, not 500s. Everything else (CF/D1 failures) stays a 500.
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("invite not pending") || msg.includes("already in use")) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return json(
    {
      hostname: result.hostname,
      token: result.token,
      agentPrompt: result.agentPrompt,
      inviteUrl: `${url.origin}/i/${result.inviteCode}`,
    },
    200,
    { noStore: true },
  );
}

// Read-only mirror of revealByCode's state machine: a GET page render must
// never burn the one-time ciphertext, so revealByCode is deliberately NOT
// reused here — the state is queried directly from the db.
async function inviteState(deps: RouteDeps, code: string): Promise<InvitePageState> {
  const invite = await deps.db.getInviteByCode(code);
  if (invite === null || invite.status === "revoked") {
    return { kind: "not_found" };
  }
  if (invite.status === "pending") {
    return { kind: "waiting" };
  }
  const endpoint = await deps.db.getEndpointByInviteId(invite.id);
  if (endpoint === null) {
    // provisioning half-done (invite flipped, endpoint row missing)
    return { kind: "waiting" };
  }
  // Match revealByCode: a non-active endpoint is an invalid link — never show
  // a hostname or ready/revealed state for a revoked/revoke_failed endpoint.
  if (endpoint.status !== "active") {
    return { kind: "not_found" };
  }
  if (endpoint.token_shown_at !== null || endpoint.token_ciphertext === null) {
    return { kind: "revealed", hostname: endpoint.hostname };
  }
  return { kind: "ready", code };
}

async function revealInvite(deps: RouteDeps, code: string): Promise<Response> {
  const outcome = await revealByCode({
    code,
    deps: {
      db: deps.db,
      tokenWrapKeyHex: deps.tokenWrapKeyHex,
      now: deps.now,
      newAuditId: deps.newAuditId,
    },
  });
  switch (outcome.kind) {
    case "not_found":
      throw new HttpError(404, "not found");
    case "not_ready":
      return json({ error: "not ready" }, 409);
    case "already_shown":
      return json({ hostname: outcome.hostname, alreadyShown: true });
    case "revealed":
      return json(
        {
          hostname: outcome.hostname,
          token: outcome.token,
          agentPrompt: outcome.agentPrompt,
        },
        200,
        { noStore: true },
      );
  }
}

const WAITLIST_BATCH = 1; // Fixed batch for 阶段 1.

/** The status literal for a queued signup. Must match schema.sql's DEFAULT. */
const WAITLIST_PENDING = "pending";

/**
 * True when an insert failed because the (email, batch) UNIQUE index rejected
 * it, as opposed to any other D1 failure. Deliberately narrow: a broad
 * catch-all here would convert real outages into cheerful 200s.
 */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

async function addToWaitlist(request: Request, deps: RouteDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const emailRaw = body.email;
  if (typeof emailRaw !== "string") {
    throw new HttpError(400, "email required");
  }
  // Bound the input BEFORE the regex. This route is unauthenticated, so length
  // is the only thing standing between a stranger and an arbitrarily large
  // stored row (a 200KB address was previously accepted).
  if (emailRaw.length > EMAIL_MAX_LENGTH) {
    throw new HttpError(400, "invalid email");
  }
  const email = emailRaw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }

  const batch = WAITLIST_BATCH;

  // Fast path for the common repeat submit. This is only an optimisation — the
  // INSERT below is authoritative, because a SELECT-then-INSERT pair is not
  // atomic and a double-clicked Submit used to 500.
  const existing = await deps.db.getWaitlistByEmail(email, batch);
  if (existing !== null) {
    return json(
      { already_exists: true, id: existing.id, position: await waitlistPosition(deps, existing) },
      200,
    );
  }

  const row = {
    id: newId("wl"),
    email,
    batch,
    status: WAITLIST_PENDING,
    created_at: deps.now(),
  };
  try {
    await deps.db.insertWaitlist(row);
  } catch (e) {
    if (!isUniqueViolation(e)) {
      throw e;
    }
    // Lost the race: someone inserted this exact (email, batch) between our
    // pre-check and here. That is a successful signup, not an error — return
    // the same shape as the already-exists branch above.
    const winner = await deps.db.getWaitlistByEmail(email, batch);
    if (winner === null) {
      throw e; // UNIQUE fired but the row is not readable — genuinely broken.
    }
    return json(
      { already_exists: true, id: winner.id, position: await waitlistPosition(deps, winner) },
      200,
    );
  }

  return json({ id: row.id, position: await waitlistPosition(deps, row) }, 201);
}

/**
 * Position of `row` in its batch, via indexed counts rather than by pulling
 * every row and scanning in JS. The old implementation made TWO full table
 * scans per request — O(n) per call and O(n^2) cumulatively on an
 * unauthenticated endpoint that shares its D1 instance with `endpoints`, so
 * filling the waitlist degraded provisioning and revocation.
 *
 * Rows sharing a created_at all count each other, so ties resolve to the same
 * position; the previous findIndex-over-sorted-list was equally arbitrary among
 * ties.
 */
async function waitlistPosition(
  deps: RouteDeps,
  row: { batch: number; created_at: string },
): Promise<number> {
  return deps.db.countWaitlistUpTo(row.batch, row.created_at);
}

async function reportInstanceStatus(request: Request, deps: RouteDeps): Promise<Response> {
  // Extract Bearer token from Authorization header
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "unauthorized");
  }
  const token = authHeader.slice("bearer ".length).trim();
  if (token === "") {
    throw new HttpError(401, "unauthorized");
  }

  // Hash the token and look up the endpoint
  const tokenHash = await sha256Hex(token);
  const endpoint = await deps.db.getEndpointByTokenSha256(tokenHash);

  // Endpoint must exist and be active
  if (endpoint === null || endpoint.status !== "active") {
    throw new HttpError(401, "unauthorized");
  }

  // Update last_seen_at
  await deps.db.updateEndpointLastSeen(endpoint.id, deps.now());

  // Return 204 No Content
  return new Response(null, { status: 204 });
}
