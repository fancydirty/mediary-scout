# Mediary Connect — remote access control plane

Paid remote access for self-hosted Mediary Scout instances. The control plane
accepts one-time WeChat Pay payments through Waffo.com Limited (the merchant of record), grants prepaid access time, and provisions a Cloudflare Tunnel + public hostname
(`<slug>.mediaryconnect.app`), and hands the home side a one-time
`TUNNEL_TOKEN`. The entry gate is the app's own access password, set in the
browser on first open (remote requests require login afterwards; LAN stays
open). Content and credentials never leave the user's own machines — this
worker only brokers the tunnel/dns setup.

Deployed at `https://mediaryconnect.app` (custom domain).

## Architecture

```
admin ──► mediaryconnect.app (this worker)
            ├─ GET  /            intro
            ├─ GET  /beta        beta signup page (two-step: email → optional
            │                    survey; also served on beta.mediaryconnect.app)
            ├─ GET  /admin       admin page (bearer token in sessionStorage)
            ├─ GET  /buy         WeChat Pay tier selector (¥45 / ¥108 / ¥188)
            ├─ POST /api/checkout                            create owned order + Waffo session
            ├─ POST /api/waffo/webhook                       signed async result
            ├─ GET  /api/orders/:id/status                   query compensation
            ├─ GET  /api/admin/invites                     list invites
            ├─ POST /api/admin/invites                     create invite
            ├─ POST /api/admin/invites/:id/provision       tunnel+ingress+dns
            ├─ GET  /api/admin/endpoints                   list endpoints (public
            │                                              shape, incl. last_seen_at)
            ├─ POST /api/admin/endpoints/:id/revoke        delete dns+tunnel
            │                                              (+Access app, legacy rows)
            ├─ GET  /i/:code     invitee page (state machine, never pre-burns)
            ├─ POST /api/i/:code/reveal                    one-time token reveal
            └─ POST /api/instance/status                   heartbeat (see below)
                 │
                 ▼ Cloudflare API
            tunnel (scout-<slug>, config_src=cloudflare)
            ingress → http://web:3000 (fixed) + catch-all 404
            DNS CNAME <slug> → <tunnel-id>.cfargotunnel.com
                 │
                 ▼ invitee home
            docker compose --profile tunnel up -d   (TUNNEL_TOKEN in .env)
```

### Authenticated endpoints (session cookie or instance credential)

Account endpoints accept either the `__Host-mc_session` cookie or
`Authorization: Bearer ic_...`. A present `Authorization` header is always
checked as a bearer credential; an invalid or revoked credential does not fall
back to a cookie.

`POST /api/checkout` — body `{ tier }` (`quarter` / `year` / `two_years`).

| Status | Body |
| --- | --- |
| 200 | `{ checkoutUrl, orderId }` — open `checkoutUrl` (Waffo, HTTPS only) in the same tab |
| 400 | `{ error: "unknown tier" }` (or a body-parse error) |
| 401 | `{ error: "unauthorized" }` — no or expired session |
| 403 | `{ error: "cross-origin request" }` — sent from another origin (see below) |
| 429 | `{ error: "too_many_checkouts" }` — the account already created 20 checkouts in the last 24 hours |
| 503 | `{ error: "checkout_not_open" }` / `{ error: "checkout_unavailable" }` — Waffo not configured or not approved / upstream failure |

Every session-cookie POST (`/api/checkout`, `/api/provision`, `/api/claim-code`,
and the login confirm `POST /auth/callback`) answers
`403 { error: "cross-origin request" }` when the browser reports another origin:
a `Sec-Fetch-Site` other than `same-origin`, or an `Origin` that is not this
host. Customer instances live on `<slug>.<root>`, whose content their owners
control and which is same-site with the apex, so SameSite=Lax alone would still
attach the session cookie to their requests.

The session cookie is `__Host-mc_session` (HttpOnly, Secure, SameSite=Lax,
Path=/, no Domain). A `<slug>.<root>` page can plant cookies with
`Domain=<root>`; a planted `mc_session` with a longer path would be sent ahead of
the apex's own cookie. Browsers refuse `Domain` on `__Host-` names, and the
Worker ignores any session cookie without the prefix.

Login: the magic link opens `GET /auth/callback?t=…`, which only shows which
email is about to sign in. The page's button sends `POST /auth/callback` with
`{ t }` from this origin; that request creates the account on first login and
sets the session cookie. A GET never signs anyone in, so another site cannot
log a visitor into its own account by linking its magic link.

`GET /api/account` returns the account email, entitlement status, endpoint,
checkout availability, and the configured payment tiers (only tiers whose Waffo
product is set, so possibly fewer than three; `checkoutOpen` is false when there
are none). A live endpoint includes its Cloudflare `tunnelId`. When the account
has no live endpoint but can get its previous address back, `restorable` is
`{ slug, hostname }`; otherwise it is null. `GET /api/orders/:id/status`,
`GET /api/slug/check`, `POST /api/provision`, and `POST /api/claim-code` use the
same authentication choices. Bearer checkout requests may include an `http:` or
`https:` `returnUrl` of at most 400 characters without userinfo; cookie checkout
requests keep the default payment return page.

### Instance link

An instance starts a link with `POST /api/instance-link/start` and receives a
poll secret and a four-character verification code. Connect emails the account
owner a confirmation URL. After the owner confirms it, the instance polls
`POST /api/instance-link/poll` and receives a long-lived `ic_...` credential
once. It then sends that credential as a bearer token to the authenticated
account endpoints. `POST /api/instance-link/revoke` revokes it. Each account
has one active instance credential; linking another instance revokes the older
credential.

### Public endpoints (no auth)

`POST /waitlist` — beta signup. Body `{ email }`.

| Status | Body |
| --- | --- |
| 201 | `{ id, position }` — new signup |
| 200 | `{ already_exists: true, id, position }` — email already queued |
| 400 | `{ error }` — `email required` / `invalid email` (or `invalid json` / `invalid body` from the shared body reader) |
| 409 | `{ error: "本批内测席位已满" }` — founding batch is capped at 100 seats; **new** emails only, emails already queued keep their 200 position lookup |
| 413 | `{ error: "body too large" }` |

`position` is 1-based within the batch and is returned on **both** success
paths — the 200 body is a strict superset of `{ already_exists, id }`. A repeat
submit (double click, refresh) is exactly when the settings-page form needs to
re-display the rank, so clients never have to branch on status code to find it.

Ranking counts every row in the batch regardless of `waitlist.status`. Only
`'pending'` exists today and nothing reads the column; if that changes, see the
TRIPWIRE tests in `src/schema.test.ts` and `src/db.test.ts`.

`POST /waitlist/survey` — the optional post-signup survey offered by
`GET /beta` (also served at the beta subdomain's root; the canonical URL is bare `beta.mediaryconnect.app`) after a successful signup. Body
`{ id, willing_to_pay?, price_point?, use_cases?, donate?, feedback? }`.

| Status | Body |
| --- | --- |
| 204 | stored (or nothing to store); no body |
| 400 | `{ error: "id required" }` (or `invalid json` / `invalid body` from the shared body reader) |
| 404 | `{ error: "waitlist entry not found" }` |
| 413 | `{ error: "body too large" }` |
| 503 | `{ error: "survey temporarily unavailable" }` — migration window only (survey_json column missing); other db errors stay a generic 500 |

Only answered keys are persisted, as a JSON object in `waitlist.survey_json`
(added by `migrations/0002-waitlist-survey.sql`; NULL until answered): unknown
keys and wrong-typed values are dropped, `feedback` is capped at 500 chars
server-side (the page's textarea has `maxlength="500"`), and a submit with
zero answered fields returns 204 **without** touching `survey_json`, so an
empty re-submit never clobbers stored answers.

### Instance heartbeat (connector-token auth)

`POST /api/instance/status` — the home instance's liveness beat.
`Authorization: Bearer <connector token>` (the same `TUNNEL_TOKEN` handed out
at provision/reveal — NOT the admin token). The token's sha256 must match an
`active` endpoint; on success the worker stamps `endpoints.last_seen_at`
(surfaced on `GET /api/admin/endpoints` and the admin page's 最近心跳 column)
and returns `204 No Content`. Unknown or revoked token → `401`. The body is
never read, so it needs no size cap.

Token secrecy: the connector token is returned to the caller exactly once (at
provision to the admin, or at `/api/i/:code/reveal` to the invitee). D1 stores
AES-GCM ciphertext (`TOKEN_WRAP_KEY`) until the first reveal, then only a
sha256. After `token_shown_at` is set, the plaintext is unrecoverable.

## Secrets (`wrangler secret put`, never commit)

| Name | What |
| --- | --- |
| `ADMIN_TOKEN` | Bearer for all `/api/admin/*` + `/admin` page JS |
| `CF_API_TOKEN` | Cloudflare API token — Tunnel:Edit, Access Apps & Policies:Edit (account), DNS:Edit (mediaryconnect.app zone only). The Access scope is still required WHILE legacy rows with Access apps exist: revoke deletes them. Once no legacy rows remain (`SELECT COUNT(*) FROM endpoints WHERE cf_access_app_id IS NOT NULL` → 0), it can be dropped from the token. |
| `CF_ACCOUNT_ID` | account holding Zero Trust / tunnels |
| `CF_ZONE_ID` | mediaryconnect.app zone |
| `TOKEN_WRAP_KEY` | `openssl rand -hex 32` — AES-256-GCM key for token-at-rest |
| `SESSION_SECRET` | `openssl rand -hex 32` — HMAC key for magic-link + session cookies (P3) |
| `RESEND_API_KEY` | Resend API key for magic-link emails (P3) |
| `WAFFO_PRIVATE_KEY` | Waffo private key used by the SDK to sign API calls (PEM) |

Vars (wrangler.jsonc, non-secret): `CONNECT_ROOT_DOMAIN=mediaryconnect.app`, `WAFFO_MERCHANT_ID`, `WAFFO_STORE_ID`, `WAFFO_ENVIRONMENT`, `WAFFO_PRODUCT_QUARTER`, `WAFFO_PRODUCT_YEAR`, and `WAFFO_PRODUCT_TWO_YEARS`.

For a local test checkout, put the Waffo test key in the ignored `.dev.vars` and
set `WAFFO_ENVIRONMENT=test`:

```dotenv
WAFFO_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...test key...\n-----END PRIVATE KEY-----"
WAFFO_ENVIRONMENT=test
```

Run `npx wrangler dev --local-upstream localhost:8787` and expose the Worker
webhook with **cloudflared**. Wrangler reports the custom-domain route as
`mediaryconnect.app`; `--local-upstream localhost:8787` makes the local request
host pass the test-environment guard. Do not use localtunnel: it strips custom
headers, so `X-Waffo-Signature` never reaches the Worker. ngrok or
`cloudflared tunnel --url http://localhost:8787` preserve the header.

Register the test webhook for the tunnel URL, then remove it when testing is
finished:

```ts
await client.webhooks.add({
  storeId,
  channel: "http",
  url: "<tunnel>/api/waffo/webhook",
  events: ["order.completed", "refund.succeeded", "refund.failed"],
  testMode: true,
});
await client.webhooks.remove({ id: "<webhook-id>" });
```

## Deploy

```bash
cd workers/scout-connect
# first time only:
npx wrangler d1 create scout-connect          # put database_id into wrangler.jsonc
npx wrangler d1 execute scout-connect --remote --file=./schema.sql
# secrets above, then use the guarded deployment entrypoint:
./scripts/deploy.sh
curl https://mediaryconnect.app/healthz       # → ok
```

### Migrations (existing databases)

`schema.sql` is the **fresh-install** shape only — applying it to a live
database does nothing for columns that already exist. Every schema change also
ships a file in `./migrations`, applied explicitly with `d1 execute --file`
(there is no `migrations_dir` / `d1 migrations apply` wiring for this Worker).

**Run pending migrations BEFORE `wrangler deploy`.** The Worker code assumes the
new shape; deploying first takes the control plane down.

```bash
cd workers/scout-connect
npx wrangler d1 execute scout-connect --remote \
  --file=./migrations/0001-drop-access-notnull-add-last-seen.sql
npx wrangler d1 execute scout-connect --remote \
  --file=./migrations/0007-waffo-payment-orders.sql
./scripts/deploy.sh
```

| Migration | What / why |
| --- | --- |
| `0001-drop-access-notnull-add-last-seen.sql` | Drops the `cf_access_app_id NOT NULL` (post-Access `provision.ts` writes `NULL`; the old table rejected it, so **every provision 500'd** after creating and then rolling back the tunnel/DNS). Adds `last_seen_at` for `POST /api/instance/status`. Adds `idx_endpoints_token_sha256` + `idx_waitlist_batch_created` (both paths were full table scans). Realigns `waitlist.status` default `'waiting'` → `'pending'`. |
| `0002-waitlist-survey.sql` | Adds nullable `waitlist.survey_json TEXT` for `POST /waitlist/survey`. Single additive `ALTER` (no rebuild; pre-existing rows read back NULL). Migrate before deploying. Wrong order no longer takes the funnel down — `insertWaitlist` falls back to the legacy column list and the survey route answers 503 — but degraded means exactly that: signups land without the column and their survey submits fail until this runs. |
| `0006-alipay-payment-orders.sql` | Historical payment order shape. Existing legacy rows remain readable. |
| `0007-waffo-payment-orders.sql` | Rebuilds `payment_orders` so the `waffo` provider and Waffo session/order evidence are accepted while preserving historical rows and indexes. Required before deploying the Waffo Worker. |
| `0009-endpoint-revoke-reason.sql` | Adds nullable `endpoints.revoke_reason`. Backfills `refunded` only on revoked or revoke-failed rows whose account has a refunded payment order. Other pre-existing revoked rows stay NULL and are not self-restorable. Apply before deploying the restore Worker. |

Notes on writing migrations here:

- **No explicit SQL transactions.** D1 rejects them. `d1 execute --file` already
  applies a file atomically (a mid-file failure leaves the DB untouched).
  Wrangler's splitter also string-matches the adjacent words `BEGIN` +
  `TRANSACTION` *even inside a `--` comment* and refuses the whole file with
  "contains several transactions" — `src/schema.test.ts` pins this.
- SQLite has no `ADD COLUMN IF NOT EXISTS`, so migrations are abort-safe rather
  than idempotent: re-running 0001 fails on the first `ALTER` and, because the
  file is atomic, changes nothing.
- Removing a `NOT NULL` or changing a `DEFAULT` needs a table rebuild
  (rename → create → `INSERT … SELECT` → drop → recreate indexes). Name the
  columns explicitly on both sides; `SELECT *` binds positionally and silently
  shuffles values into the wrong columns.
- Rebuilding a table drops its indexes — recreate them, or the admin
  `revoke_failed` sweep quietly degrades to a scan.
- Changes to `schema.sql` must keep fresh and migrated installs converged;
  `src/schema.test.ts` asserts the two shapes are identical.

⚠️ If you have `CF_API_TOKEN` in your shell env (e.g. for other scripts),
wrangler picks it up as *its own* auth and fails with account-list errors —
run deploy/secret commands as `env -u CF_API_TOKEN npx wrangler ...`.

## Operations

**Payment lifecycle**: login → choose one of the fixed tiers → create a local order
→ open the Waffo WeChat Pay session. A browser return never proves payment.
Entitlements are granted only after a verified Waffo webhook or a read-only
GraphQL payment query matches the owned external order ID, CNY amount, and
succeeded status. Webhook and query races converge through the same durable
idempotency key. A full refund removes that order's months and recomputes the
expiry from the remaining unrefunded entitlements; access is revoked only when
no paid time remains. Partial refunds are logged and do not remove access.

The WeChat simulator only proves the integration. Production launch also
requires KYB approval (`prodEnabled`), all three products published to
production, the production webhook registered, a real payment by someone
other than the merchant, and a full refund of that payment.

**Refunds**: issue refunds from the Waffo dashboard (or through the merchant
API refund ticket). The resulting `refund.succeeded` webhook removes the
purchased time; when no time remains, the remote endpoint is revoked
automatically. Partial refunds do not change the entitlement.

**Restoring an address**: taking an address down records why.
`revoke_reason` is `expired` when the grace period ends, `refunded` when a
refund removed the last paid time, or `admin` for a manual revoke. After the
account pays again, `POST /api/provision` with that same slug brings the same
row back: a new tunnel and DNS record, the slug and hostname unchanged. An
admin revoke cannot be restored by the owner. Rows revoked before migration
0009 stay unrestorable unless the backfill marked them `refunded`.

**Invite someone** (admin page `https://mediaryconnect.app/admin`):
1. Paste `ADMIN_TOKEN`, create invite with their email (+ optional slug).
2. Click 开通 — copy the invite URL (`/i/<code>`) and send it privately.
   The page also shows the token + agent prompt once (admin backup copy).
3. Invitee opens the link, clicks 显示连接信息 (shown once), pastes the token
   into their home `.env` as `TUNNEL_TOKEN=...`, then
   `docker compose --profile tunnel up -d`. The page offers a
   「复制给 Agent」 prompt that does this for them.
4. Their `https://<slug>.mediaryconnect.app` is live, gated by the app's own
   access password (set-password page on first open).

**Revoke**: admin page → 吊销. Deletes DNS + tunnel — plus the Access app for
legacy rows provisioned before Access was removed (connections closed first;
CF error 1022 retried automatically). Idempotent.

**Home-side network issues**: if the tunnel won't register or keeps dropping
on a UDP-restricted network, tell the invitee to add
`TUNNEL_TRANSPORT_PROTOCOL=http2` to `.env` and restart the tunnel profile.

## Tests

`npx vitest run workers/scout-connect` from the repo root (auto-discovered).
Unit tests cover slug/auth, crypto wrap/unwrap, CF API client (incl. token
non-leakage), D1 SQL shape, provision compensation (CF + D1 failure paths),
revoke idempotency, one-time reveal state machine, and HTTP routes.

`src/schema.test.ts` is the one file that applies the real `schema.sql` (and
`migrations/*.sql`) to a real SQLite database via `better-sqlite3`. The rest of
the suite runs against `createMemoryConnectDb`, a `Map` with no constraint
engine — it cannot catch a NOT NULL / missing-column / index regression, and
once didn't: a null insert passed the mock while production rejected it. Any
schema or migration change belongs in `schema.test.ts`.
