# Scout Connect — remote access control plane

Invite-only remote access for self-hosted Mediary Scout instances. The control
plane provisions, per invitee, a Cloudflare Tunnel + public hostname
(`<slug>.mediaryconnect.app`) + Cloudflare Access email-OTP gate, and hands the
home side a one-time `TUNNEL_TOKEN`. Content and credentials never leave the
user's own machines — this worker only brokers the tunnel/dns/access setup.

Deployed at `https://mediaryconnect.app` (custom domain).

## Architecture

```
admin ──► mediaryconnect.app (this worker)
            ├─ GET  /            intro
            ├─ GET  /admin       admin page (bearer token in sessionStorage)
            ├─ POST /api/admin/invites                     create invite
            ├─ POST /api/admin/invites/:id/provision       tunnel+ingress+access+dns
            ├─ POST /api/admin/endpoints/:id/revoke        delete all three
            ├─ GET  /i/:code     invitee page (state machine, never pre-burns)
            └─ POST /api/i/:code/reveal                    one-time token reveal
                 │
                 ▼ Cloudflare API
            tunnel (scout-<slug>, config_src=cloudflare)
            ingress → http://web:3000 (fixed) + catch-all 404
            DNS CNAME <slug> → <tunnel-id>.cfargotunnel.com
            Access self_hosted app, email allow policy (OTP)
                 │
                 ▼ invitee home
            docker compose --profile tunnel up -d   (TUNNEL_TOKEN in .env)
```

Token secrecy: the connector token is returned to the caller exactly once (at
provision to the admin, or at `/api/i/:code/reveal` to the invitee). D1 stores
AES-GCM ciphertext (`TOKEN_WRAP_KEY`) until the first reveal, then only a
sha256. After `token_shown_at` is set, the plaintext is unrecoverable.

## Secrets (`wrangler secret put`, never commit)

| Name | What |
| --- | --- |
| `ADMIN_TOKEN` | Bearer for all `/api/admin/*` + `/admin` page JS |
| `CF_API_TOKEN` | Cloudflare API token — Tunnel:Edit, Access Apps & Policies:Edit (account), DNS:Edit (mediaryconnect.app zone only) |
| `CF_ACCOUNT_ID` | account holding Zero Trust / tunnels |
| `CF_ZONE_ID` | mediaryconnect.app zone |
| `TOKEN_WRAP_KEY` | `openssl rand -hex 32` — AES-256-GCM key for token-at-rest |

Vars (wrangler.jsonc, non-secret): `CONNECT_ROOT_DOMAIN=mediaryconnect.app`.

## Deploy

```bash
cd workers/scout-connect
# first time only:
npx wrangler d1 create scout-connect          # put database_id into wrangler.jsonc
npx wrangler d1 execute scout-connect --remote --file=./schema.sql
# secrets above, then:
npx wrangler deploy
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
npx wrangler deploy
```

| Migration | What / why |
| --- | --- |
| `0001-drop-access-notnull-add-last-seen.sql` | Drops the `cf_access_app_id NOT NULL` (post-Access `provision.ts` writes `NULL`; the old table rejected it, so **every provision 500'd** after creating and then rolling back the tunnel/DNS). Adds `last_seen_at` for `POST /api/instance/status`. Adds `idx_endpoints_token_sha256` + `idx_waitlist_batch_created` (both paths were full table scans). Realigns `waitlist.status` default `'waiting'` → `'pending'`. |

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

**Invite someone** (admin page `https://mediaryconnect.app/admin`):
1. Paste `ADMIN_TOKEN`, create invite with their email (+ optional slug).
2. Click 开通 — copy the invite URL (`/i/<code>`) and send it privately.
   The page also shows the token + agent prompt once (admin backup copy).
3. Invitee opens the link, clicks 显示连接信息 (shown once), pastes the token
   into their home `.env` as `TUNNEL_TOKEN=...`, then
   `docker compose --profile tunnel up -d`. The page offers a
   「复制给 Agent」 prompt that does this for them.
4. Their `https://<slug>.mediaryconnect.app` is live behind Access email OTP.

**Revoke**: admin page → 吊销. Deletes Access app + DNS + tunnel (connections
closed first; CF error 1022 retried automatically). Idempotent.

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
