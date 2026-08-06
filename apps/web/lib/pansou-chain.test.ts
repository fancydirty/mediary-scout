import { describe, expect, it } from "vitest";
import { FallbackResourceProvider, PanSouResourceProvider } from "@media-track/workflow";
import { buildPanSouProviderChain, DEFAULT_PANSOU_BASE_URL, resolveUserPanSouBaseUrl } from "./pansou-chain";

describe("buildPanSouProviderChain", () => {
  it("returns a bare PanSou provider when the user configured no custom source", () => {
    expect(buildPanSouProviderChain({ userBaseURL: "", allowedTypes: [] })).toBeInstanceOf(
      PanSouResourceProvider,
    );
  });

  it("returns a bare PanSou provider when the user's source IS the official one", () => {
    // Nothing to fall back TO — wrapping would just double every failed search.
    expect(
      buildPanSouProviderChain({ userBaseURL: DEFAULT_PANSOU_BASE_URL, allowedTypes: [] }),
    ).toBeInstanceOf(PanSouResourceProvider);
  });

  it("ignores surrounding whitespace when comparing against the official source", () => {
    expect(
      buildPanSouProviderChain({ userBaseURL: `  ${DEFAULT_PANSOU_BASE_URL}  `, allowedTypes: [] }),
    ).toBeInstanceOf(PanSouResourceProvider);
  });

  it("wraps user + official in a fallback chain when a custom source is configured", () => {
    expect(
      buildPanSouProviderChain({ userBaseURL: "http://192.168.1.10:8899", allowedTypes: [] }),
    ).toBeInstanceOf(FallbackResourceProvider);
  });
});

/** 这些用例守的是一个「测试抓不到、只有生产会疼」的回归：装配链若只读 DB 一层，
 *  compose 自带的 pansou 容器（只经 env PANSOU_BASE_URL 注入，DB 为空）会被
 *  静默换成官方公共源。getPanSouBaseUrl 的既有测试仍然全绿 —— 因为那个函数没被
 *  改坏，只是在真正的检索路径上被绕过了。 */
describe("resolveUserPanSouBaseUrl", () => {
  it("prefers the DB setting over env", () => {
    expect(
      resolveUserPanSouBaseUrl(" http://db.example ", { PANSOU_BASE_URL: "http://env.example" }),
    ).toBe("http://db.example");
  });

  it("keeps the env tier when the DB setting is blank (compose 自带 pansou 走这条)", () => {
    expect(resolveUserPanSouBaseUrl(null, { PANSOU_BASE_URL: " http://pansou " })).toBe(
      "http://pansou",
    );
  });

  it("returns empty when neither tier is configured", () => {
    expect(resolveUserPanSouBaseUrl(null, {})).toBe("");
  });
});
