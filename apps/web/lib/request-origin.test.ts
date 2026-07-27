import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_ORIGIN, resolveRequestOrigin } from "./request-origin";

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => entries[name.toLowerCase()] ?? null };
}

describe("resolveRequestOrigin", () => {
  it("trusts the first x-forwarded-proto/host hop (Cloudflare Tunnel → https public origin)", () => {
    const origin = resolveRequestOrigin(
      headers({
        "x-forwarded-proto": "https",
        "x-forwarded-host": "mediary.example.com",
        host: "localhost:3300",
      }),
    );
    expect(origin).toBe("https://mediary.example.com");
  });

  it("handles proto values with a trailing colon and multi-value forwarded headers", () => {
    const origin = resolveRequestOrigin(
      headers({
        "x-forwarded-proto": "https:",
        "x-forwarded-host": "mediary.example.com, internal.local",
      }),
    );
    expect(origin).toBe("https://mediary.example.com");
  });

  it("falls back to plain http + Host header on direct LAN access", () => {
    expect(resolveRequestOrigin(headers({ host: "192.168.1.10:3300" }))).toBe(
      "http://192.168.1.10:3300",
    );
  });

  it("keeps explicit x-forwarded-proto http (LAN reverse proxy without TLS)", () => {
    const origin = resolveRequestOrigin(
      headers({ "x-forwarded-proto": "http", "x-forwarded-host": "nas.local:3300" }),
    );
    expect(origin).toBe("http://nas.local:3300");
  });

  it("rejects junk host values and falls back to the local default", () => {
    expect(resolveRequestOrigin(headers({ host: "http://evil.com/path" }))).toBe(DEFAULT_LOCAL_ORIGIN);
    expect(resolveRequestOrigin(headers({ "x-forwarded-host": "evil com" }))).toBe(
      DEFAULT_LOCAL_ORIGIN,
    );
    expect(resolveRequestOrigin(headers({}))).toBe(DEFAULT_LOCAL_ORIGIN);
  });

  it("rejects out-of-range ports instead of emitting an unusable origin", () => {
    // \d{1,5} 本身放行 99999 / 0，可它们不是合法端口——冒出来的 origin 会被
    // 原样贴进升级提示词，让那台冷启动的 agent 去 curl 一个永远连不上的地址。
    for (const host of ["nas.local:99999", "nas.local:65536", "nas.local:0"]) {
      expect(resolveRequestOrigin(headers({ host }))).toBe(DEFAULT_LOCAL_ORIGIN);
    }
    // 边界内的仍然放行
    expect(resolveRequestOrigin(headers({ host: "nas.local:65535" }))).toBe(
      "http://nas.local:65535",
    );
    expect(resolveRequestOrigin(headers({ host: "nas.local:1" }))).toBe("http://nas.local:1");
  });

  it("ignores unknown forwarded protocols (never emits gopher:// etc.)", () => {
    const origin = resolveRequestOrigin(
      headers({ "x-forwarded-proto": "gopher", host: "nas.local:3300" }),
    );
    expect(origin).toBe("http://nas.local:3300");
  });
});
