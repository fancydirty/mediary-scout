export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
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
