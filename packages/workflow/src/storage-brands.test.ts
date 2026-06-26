import { describe, expect, it } from "vitest";
import { allowedResourceTypesForKinds, getStorageBrand } from "./storage-brands.js";

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
