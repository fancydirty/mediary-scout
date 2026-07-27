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

  it("ignores unknown forwarded protocols (never emits gopher:// etc.)", () => {
    const origin = resolveRequestOrigin(
      headers({ "x-forwarded-proto": "gopher", host: "nas.local:3300" }),
    );
    expect(origin).toBe("http://nas.local:3300");
  });
});
