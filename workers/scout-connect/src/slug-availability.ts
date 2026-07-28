import { RESERVED_SLUGS, SLUG_RE, normalizeSlug } from "./slug.js";

/** 一个 slug 是否已被占用(D1 查询,由调用方注入)。 */
export type IsTaken = (slug: string) => Promise<boolean>;

export type CheckResult =
  | { available: true }
  | { available: false; reason: "invalid" | "reserved" | "taken"; suggestions: string[] };

const SLUG_MAX_LENGTH = 32;

function slugShape(slug: string): "ok" | "invalid" | "reserved" {
  if (slug.length < 1 || slug.length > SLUG_MAX_LENGTH || !SLUG_RE.test(slug)) return "invalid";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return "ok";
}

/** 生成候选:base 后接数字,以及连字符变体;只保留合法且未占用的,最多 n 个。 */
export async function suggestSlugs(baseRaw: string, isTaken: IsTaken, n: number): Promise<string[]> {
  const base = normalizeSlug(baseRaw);
  const out: string[] = [];
  const candidates: string[] = [];
  // 先数字后缀 1..99,再几个语义变体
  for (let i = 1; i <= 99; i++) candidates.push(`${base}${i}`);
  candidates.push(`${base}-nas`, `${base}-home`, `${base}-mc`);
  for (const c of candidates) {
    if (out.length >= n) break;
    // 截断到长度上限;形状不合法(如太长)跳过
    if (slugShape(c) !== "ok") continue;
    if (await isTaken(c)) continue;
    out.push(c);
  }
  return out;
}

export async function checkSlug(slugRaw: string, isTaken: IsTaken): Promise<CheckResult> {
  const slug = normalizeSlug(slugRaw);
  const shape = slugShape(slug);
  if (shape === "invalid") return { available: false, reason: "invalid", suggestions: [] };
  if (shape === "reserved") {
    return { available: false, reason: "reserved", suggestions: await suggestSlugs(slug, isTaken, 3) };
  }
  if (await isTaken(slug)) {
    return { available: false, reason: "taken", suggestions: await suggestSlugs(slug, isTaken, 3) };
  }
  return { available: true };
}
