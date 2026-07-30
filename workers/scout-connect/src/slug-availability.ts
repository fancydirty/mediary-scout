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
    // 形状不合法(太长/保留字/字符集不符)直接跳过——不截断,只筛选。
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
    // **保留字被拒时,候选名不得以该保留字为 base。**
    // 黑名单的目的是防商标侵权(CF Zero Trust 条款)+ 防冒充站方/钓鱼 ——
    // 拒了 `admin` 却推荐 `admin1`、拒了 `paypal` 推荐 `paypal1`,等于把风险
    // 重新递给用户。给一组与被拒词无关的通用备选,帮用户起步但不顺着那个方向。
    // (taken 分支不同:`alice` 被占推荐 alice 系变体是合理的,用户想要的就是那个。)
    return {
      available: false,
      reason: "reserved",
      suggestions: await genericSuggestions(isTaken, 3),
    };
  }
  if (await isTaken(slug)) {
    return { available: false, reason: "taken", suggestions: await suggestSlugs(slug, isTaken, 3) };
  }
  return { available: true };
}

/** 保留字被拒时的通用备选(与被拒词无关)。 */
const GENERIC_SUGGESTIONS = ["my-nas", "home-nas", "my-media", "my-scout", "home-media", "nas-box"];

async function genericSuggestions(isTaken: IsTaken, n: number): Promise<string[]> {
  const out: string[] = [];
  for (const c of GENERIC_SUGGESTIONS) {
    if (out.length >= n) break;
    if (!(await isTaken(c))) out.push(c);
  }
  return out;
}
