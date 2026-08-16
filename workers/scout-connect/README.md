# Mediary Connect — remote access control plane

Paid remote access for self-hosted Mediary Scout instances. The control plane
accepts one-time Alipay payments, grants prepaid access time, and provisions a Cloudflare Tunnel + public hostname
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
            ├─ GET  /buy         Alipay-only tier selector (¥45 / ¥108 / ¥188)
            ├─ POST /api/alipay/checkout                    create owned order
            ├─ GET  /alipay/checkout                        one-time signed-form hop
            ├─ POST /api/alipay/notify                      signed async result
            ├─ GET  /api/alipay/orders/:id/status           query compensation
            ├─ POST /api/alipay/orders/:id/close            close unpaid order
            ├─ POST /api/admin/alipay/refund                full refund
            ├─ GET  /api/admin/alipay/refund/:requestNo     refund query
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
| `ALIPAY_APP_ID` | Alipay application ID |
| `ALIPAY_PRIVATE_KEY` | Merchant RSA2 private key (PKCS#1 or PKCS#8 PEM/bare base64) |
| `ALIPAY_ALIPAY_PUBLIC_KEY` | Alipay platform public key used to verify responses and notifications |
| `ALIPAY_SELLER_ID` | Expected Alipay seller/PID; notifications with another seller are rejected |

Vars (wrangler.jsonc, non-secret): `CONNECT_ROOT_DOMAIN=mediaryconnect.app`.

For a browser sandbox checkout, put the sandbox credentials in the ignored local
`.dev.vars` and set `ALIPAY_ENVIRONMENT=sandbox`, then run `wrangler dev`. The
Worker honors sandbox only when the request hostname is `localhost`, `127.0.0.1`,
or `::1`; a deployed custom domain with that value fails closed. Its signed form
and CSP are both pinned to the official
`openapi-sandbox.dl.alipaydev.com` gateway. Production omits the variable (or
sets `production`) and remains pinned to `openapi.alipay.com`.

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
./scripts/deploy.sh
```

| Migration | What / why |
| --- | --- |
| `0001-drop-access-notnull-add-last-seen.sql` | Drops the `cf_access_app_id NOT NULL` (post-Access `provision.ts` writes `NULL`; the old table rejected it, so **every provision 500'd** after creating and then rolling back the tunnel/DNS). Adds `last_seen_at` for `POST /api/instance/status`. Adds `idx_endpoints_token_sha256` + `idx_waitlist_batch_created` (both paths were full table scans). Realigns `waitlist.status` default `'waiting'` → `'pending'`. |
| `0002-waitlist-survey.sql` | Adds nullable `waitlist.survey_json TEXT` for `POST /waitlist/survey`. Single additive `ALTER` (no rebuild; pre-existing rows read back NULL). Migrate before deploying. Wrong order no longer takes the funnel down — `insertWaitlist` falls back to the legacy column list and the survey route answers 503 — but degraded means exactly that: signups land without the column and their survey submits fail until this runs. |
| `0006-alipay-payment-orders.sql` | Adds durable Alipay orders, provider-neutral payment identity, refund tombstones, a durable short-TTL query-coalescing timestamp, and backfills historical payment rows without changing their existing access time. Required before the Alipay-only Worker deploy. |

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

**Payment lifecycle**: login → choose one of the fixed tiers → create a local order →
submit the server-signed form to Alipay. A browser return never proves payment.
Entitlements are granted only after a verified async notification or signed
`alipay.trade.query` result matches app ID, seller ID, owned order, amount, and
paid status. Notification and query races converge through the same durable
idempotency key. Repeated status requests share a durable 2.5-second query slot;
`WAIT_BUYER_PAY` is never terminal-cached. Refunds are full amount only and revoke access only when no
other unrefunded entitlement remains.

After deploying, the script performs no-charge production checks. Final launch
acceptance still requires one real payment by a non-merchant account, automatic
entitlement fulfillment, and a full refund returned to the original Alipay transaction.

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
