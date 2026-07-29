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
  // Paddle 结账。client token 是**公开**值(设计上就要下发浏览器),放
  // wrangler.jsonc vars;未配置时 /buy 明确显示「结账未开放」而不是白页。
  // PADDLE_ENVIRONMENT: "sandbox" | "production"(缺省视为 production)。
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_ENVIRONMENT?: string;
  // notification destination 的 endpoint secret(pdl_ntfset_ 前缀)。
  // **wrangler secret,不是 vars** —— 它是验签密钥,泄露等于任何人都能凭空
  // 发时长。未配置时 /api/paddle/webhook 一律 503(fail closed)。
  PADDLE_WEBHOOK_SECRET?: string;
}
