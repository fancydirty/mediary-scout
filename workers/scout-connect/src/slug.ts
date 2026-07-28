export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // ── 基础设施保留字 ──
  "www",
  "api",
  "admin",
  "mail",
  "ftp",
  "connect",
  "status",
  "cdn",
  "static",
  "owner",
  "root",
  "support",
  "help",
  "null",
  "undefined",
  "i",
  "login",
  "auth",
  "beta",
  "console",
  "app",
  "dashboard",
  "billing",
  "pay",
  "payment",
  "account",
  "docs",
  "blog",
  "dev",
  "test",
  "staging",
  "demo",
  "download",
  "assets",
  "img",
  "ns1",
  "ns2",
  "smtp",
  "imap",
  "pop",
  "webmail",
  "vpn",
  "proxy",
  // ── 官方口吻/钓鱼高危(冒充站方) ──
  "official",
  "security",
  "verify",
  "secure",
  "noreply",
  "no-reply",
  "abuse",
  "postmaster",
  "hostmaster",
  "webmaster",
  "mediary",
  "mediaryscout",
  "mediaryconnect",
  "scout",
  // ── 知名商标/组织(CF Zero Trust 条款第 6 条:names of other businesses,
  //    organizations, or individuals;不加黑名单等于替用户承担这个风险)──
  "cloudflare",
  "google",
  "apple",
  "microsoft",
  "amazon",
  "netflix",
  "disney",
  "tencent",
  "alibaba",
  "baidu",
  "bytedance",
  "douyin",
  "tiktok",
  "wechat",
  "weixin",
  "alipay",
  "taobao",
  "quark",
  "xunlei",
  "paypal",
  "stripe",
  "paddle",
  "github",
  "facebook",
  "instagram",
  "twitter",
  "youtube",
  "whatsapp",
  "telegram",
  // ── 敏感词(政治/攻击性,保守起步,可随运营追加)──
  "porn",
  "sex",
  "xxx",
  "adult",
  "gov",
  "police",
  "bank",
  "casino",
  "gambling",
  "drug",
  "drugs",
]);

export const SLUG_RE = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,30}[a-z0-9])$/;

const SLUG_MAX_LENGTH = 32;

export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

export function assertSlug(input: string): string {
  const slug = normalizeSlug(input);
  if (slug.length < 1 || slug.length > SLUG_MAX_LENGTH) {
    throw new Error(
      `invalid slug length: must be 1-${SLUG_MAX_LENGTH} characters`,
    );
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      "invalid slug: must be lowercase alphanumeric with optional inner hyphens, not starting or ending with a hyphen",
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`reserved slug: ${slug}`);
  }
  return slug;
}
