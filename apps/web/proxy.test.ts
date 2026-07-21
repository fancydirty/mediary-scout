import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("multi-user proxy API exclusions", () => {
  beforeEach(() => vi.stubEnv("MEDIA_TRACK_MULTI_USER", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["/api/health", "/api/workflows/run-next", "/api/agent/patrol"]) (
    "leaves %s to its handler-level guard instead of redirecting to login",
    (pathname) => {
      const response = proxy(new NextRequest(`https://mediary.example${pathname}`));

      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it("continues redirecting unauthenticated page requests", () => {
    const response = proxy(new NextRequest("https://mediary.example/settings"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://mediary.example/login");
  });
});
