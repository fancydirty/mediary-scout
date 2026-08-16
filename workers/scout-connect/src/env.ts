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
  // 标为可选:登录魔法链接**必需**,但到期提醒邮件可以没有它 ——
  // 没配时 login 路径本就失败(那是核心功能),而 expiry sweep 只是不发提醒邮件,
  // 回收照走。让类型反映"某些路径可无"这个事实,而不是假设处处必填。
  RESEND_API_KEY?: string;
  // 支付宝网页支付。四项都作为 Worker secrets 配置,源码和 wrangler vars
  // 均不保存凭证。缺少任一项时购买入口明确显示不可用,所有支付接口 fail closed。
  ALIPAY_APP_ID?: string;
  ALIPAY_PRIVATE_KEY?: string;
  ALIPAY_ALIPAY_PUBLIC_KEY?: string;
  ALIPAY_SELLER_ID?: string;
  // 到期巡检是否真删。"true" 才开;任何其它值/未设 = dry-run 只记审计。
  // 四个 PR 里唯一会真删生产资源的路径,先在实例验证时间边界再放开。
  EXPIRY_SWEEP_LIVE?: string;
}
