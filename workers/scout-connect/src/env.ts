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
  // P3: 魔法链接登录 + session 签名密钥(64 hex = 32 字节),wrangler secret。
  SESSION_SECRET: string;
  // P3: Resend 发信 API key(魔法链接邮件),wrangler secret。
  RESEND_API_KEY: string;
}
