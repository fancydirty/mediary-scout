import { describe, expect, it } from "vitest";
import {
  allowedResourceTypesForKinds,
  brandSupportsProwlarr,
  getStorageBrand,
} from "./storage-brands.js";

describe("allowedResourceTypesForKinds", () => {
  it("maps a quark brand's kinds to quark-only links", () => {
    expect(allowedResourceTypesForKinds(getStorageBrand("quark").resourceProviderKinds)).toEqual(["quark"]);
  });

  it("maps a 光鸭(magnet) brand's kinds to magnet-only links", () => {
    expect(allowedResourceTypesForKinds(getStorageBrand("guangya").resourceProviderKinds)).toEqual(["magnet"]);
  });

  it("maps a 115 brand's kinds to 115 + magnet", () => {
    expect(allowedResourceTypesForKinds(getStorageBrand("pan115").resourceProviderKinds)).toEqual([
      "115",
      "magnet",
    ]);
  });

  it("falls back to 115 + magnet for an unknown/legacy kind set", () => {
    expect(allowedResourceTypesForKinds(["pansou-115", "prowlarr"])).toEqual(["115", "magnet"]);
  });
});

describe("STORAGE_BRANDS registry", () => {
  it("registers tianyi as a token-auth share brand with pansou-tianyi kind", () => {
    const b = getStorageBrand("tianyi");
    expect(b.label).toBe("天翼云盘");
    expect(b.authKind).toBe("token");
    expect(b.resourceProviderKinds).toEqual(["pansou-tianyi"]);
    expect(b.assumeChineseSubsFromChineseTitle).toBe(true);
    expect(brandSupportsProwlarr("tianyi")).toBe(false);
    expect(allowedResourceTypesForKinds(["pansou-tianyi"])).toEqual(["tianyi"]);
  });

  it("existing cookie brands report authKind cookie; guangya token", () => {
    expect(getStorageBrand("pan115").authKind).toBe("cookie");
    expect(getStorageBrand("quark").authKind).toBe("cookie");
    expect(getStorageBrand("guangya").authKind).toBe("token");
  });
});
