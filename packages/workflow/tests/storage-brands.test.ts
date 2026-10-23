import { describe, expect, it } from "vitest";
import {
  allowedResourceTypesForKinds,
  getStorageBrand,
  parseQuarkUid,
  parsePan115Uid,
  STORAGE_BRANDS,
  isPan115AuthError,
  isBrandStorageAuthError,
  isQuarkAuthError,
  isLlmRateLimitError,
  isLlmServerError,
  Pan115AuthError,
  QuarkAuthError,
} from "../src/index.js";
import { GuangYaAuthError, parseGuangYaUid } from "../src/guangya-client.js";

/** Build a fake 光鸭 JWT whose payload (2nd segment, base64url) carries `payload`. */
function makeGuangYaJwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

describe("storage brand registry", () => {
  it("registers exactly pan115 + quark + uc + guangya + tianyi + pan123", () => {
    expect(STORAGE_BRANDS.map((b) => b.provider).sort()).toEqual([
      "guangya",
      "pan115",
      "pan123",
      "quark",
      "tianyi",
      "uc",
    ]);
  });

  it("getStorageBrand resolves uc as a 夸克-family cookie brand (share-only, no prowlarr)", () => {
    const u = getStorageBrand("uc");
    expect(u.provider).toBe("uc");
    expect(u.label).toBe("UC网盘");
    expect(u.resourceProviderKinds).toEqual(["pansou-uc"]);
    // No usable magnet/offline API on UC → magnet sources stay hidden, exactly
    // like 夸克. This is what keeps the agent from ever seeing a magnet candidate.
    expect(u.resourceProviderKinds).not.toContain("prowlarr");
    expect(u.resourceProviderKinds).not.toContain("pansou-magnet");
    // Same family cookie key names as 夸克 — one parser serves both.
    expect(u.parseUid("__pus=p; __uid=uc-42")).toBe("uc-42");
    expect(u.parseUid("__pus=p; __kps=only-kps")).toBe("only-kps");
    expect(u.parseUid("no keys here")).toBeNull();
    // Same error class as 夸克: one family, one freeze signal.
    expect(u.isAuthError(new QuarkAuthError("x"))).toBe(true);
    expect(u.isAuthError(new Pan115AuthError("y"))).toBe(false);
    expect(u.authKind).toBe("cookie");
    expect(u.provisionRootId).toBe("0");
    // pdir_fid walk (getFileInfo) — the family protocol has a real breadcrumb.
    expect(u.writeScope).toBe("parents");
  });

  it("maps the uc resource kind to the uc link type only", () => {
    expect(allowedResourceTypesForKinds(["pansou-uc"])).toEqual(["uc"]);
  });

  it("a UC auth failure is classified as a netdisk auth error, but 'no such model' is NOT", () => {
    // Regression guard: adding bare "uc" to the brand-marker list made every LLM
    // 404 ("no such model" → "no s-uc-h") look like a dead drive credential.
    expect(isBrandStorageAuthError(new QuarkAuthError("UC_AUTH_FAILED: require login"))).toBe(true);
    expect(isBrandStorageAuthError(new Error("no such model on gateway"))).toBe(false);
    expect(isBrandStorageAuthError(new Error("The model does not exist"))).toBe(false);
    // Every UC_* code must short-circuit the LLM classifiers (so a UC 429/5xx is
    // never reported as an AI-模型 problem) — not just the auth one. Asserted on
    // the PUBLIC LLM predicates, which is the path isBrandError actually guards.
    for (const code of ["UC_LIST_ITEMS_FAILED", "UC_CREATE_FOLDER_FAILED", "UC_SHARE_TOKEN_FAILED", "UC_MOVE_FAILED"]) {
      expect(isLlmRateLimitError(new Error(`${code}: code=429 too many requests`)), code).toBe(false);
      expect(isLlmServerError(new Error(`${code}: code=503 upstream`)), code).toBe(false);
    }
  });

  it("getStorageBrand resolves guangya with its label, magnet/prowlarr kinds + uid parsing", () => {
    const g = getStorageBrand("guangya");
    expect(g.provider).toBe("guangya");
    expect(g.label).toBe("光鸭云盘");
    expect(g.resourceProviderKinds).toContain("pansou-magnet");
    expect(g.resourceProviderKinds).toContain("prowlarr"); // 光鸭支持磁力
    expect(g.parseUid).toBe(parseGuangYaUid);
    expect(g.parseUid(makeGuangYaJwt({ sub: "U1" }))).toBe("U1");
    expect(g.isAuthError(new GuangYaAuthError("x"))).toBe(true);
    expect(g.isAuthError(new QuarkAuthError("y"))).toBe(false);
  });

  it("getStorageBrand resolves quark with its label + resource kinds (no prowlarr)", () => {
    const q = getStorageBrand("quark");
    expect(q.provider).toBe("quark");
    expect(q.label).toBe("夸克网盘");
    expect(q.resourceProviderKinds).toContain("pansou-quark");
    expect(q.resourceProviderKinds).not.toContain("prowlarr"); // 磁力对夸克隐藏
    expect(q.parseUid).toBe(parseQuarkUid);
    expect(q.isAuthError(new QuarkAuthError("x"))).toBe(true);
    expect(q.isAuthError(new Pan115AuthError("y"))).toBe(false);
  });

  it("getStorageBrand resolves pan115 keeping magnet sources", () => {
    const p = getStorageBrand("pan115");
    expect(p.provider).toBe("pan115");
    expect(p.label).toBe("115 网盘");
    expect(p.resourceProviderKinds).toContain("pansou-115");
    expect(p.resourceProviderKinds).toContain("prowlarr");
    expect(p.parseUid).toBe(parsePan115Uid);
    expect(p.isAuthError).toBe(isPan115AuthError);
  });

  it("each brand's isAuthError only matches its own auth error", () => {
    // sanity: the registry wires the right classifier per brand
    expect(isQuarkAuthError(new QuarkAuthError("x"))).toBe(true);
    expect(getStorageBrand("quark").isAuthError(new Error("plain"))).toBe(false);
  });

  it("unknown provider throws", () => {
    expect(() => getStorageBrand("baidu")).toThrowError(/unknown storage brand/i);
  });

  it("brandSupportsProwlarr: 115 yes, quark no, unknown safely false", async () => {
    const { brandSupportsProwlarr } = await import("../src/index.js");
    expect(brandSupportsProwlarr("pan115")).toBe(true);
    expect(brandSupportsProwlarr("quark")).toBe(false);
    expect(brandSupportsProwlarr("guangya")).toBe(true);
    expect(brandSupportsProwlarr("baidu")).toBe(false);
  });

  it("brandsSupportingProwlarr: the labels of every brand whose kinds include prowlarr, in registry order", async () => {
    const { brandsSupportingProwlarr, brandSupportsProwlarr } = await import("../src/index.js");
    const labels = brandsSupportingProwlarr();
    // 115 / 光鸭 / 123 carry "prowlarr"; 夸克 / 天翼 don't (share-link only).
    expect(labels).toEqual(["115 网盘", "光鸭云盘", "123网盘"]);
    // Consistent with the per-provider predicate — same source of truth.
    for (const brand of STORAGE_BRANDS) {
      expect(labels.includes(brand.label)).toBe(brandSupportsProwlarr(brand.provider));
    }
  });

  it("brand registry carries assumeChineseSubsFromChineseTitle flag (Task 4)", () => {
    // 115 and quark are Chinese-world drives → assume Chinese subs from Chinese titles
    expect(getStorageBrand("pan115").assumeChineseSubsFromChineseTitle).toBe(true);
    expect(getStorageBrand("quark").assumeChineseSubsFromChineseTitle).toBe(true);
    // guangya stays conservative (its magnets are often scene releases, not 中文圈 packs)
    expect(getStorageBrand("guangya").assumeChineseSubsFromChineseTitle).toBe(false);
  });
});
