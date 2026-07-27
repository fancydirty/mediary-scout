import type { D1Database } from "./db.js";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  TOKEN_WRAP_KEY: string;
  CONNECT_ROOT_DOMAIN: string;
  // Cloudflare Turnstile (bot protection on the public beta waitlist). Both
  // optional: the gate is active ONLY when both are configured — the sitekey
  // is a public var (wrangler.jsonc), the secret comes from `wrangler secret
  // put TURNSTILE_SECRET`. Either missing → no widget, no verification.
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
}
