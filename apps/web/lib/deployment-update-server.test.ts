import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestMainCommit } from "./deployment-update-server";

const SHA = "3333333333333333333333333333333333333333";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchLatestMainCommit", () => {
  it("returns the normalized sha from GitHub", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sha: SHA.toUpperCase() }), { status: 200 }));
    await expect(fetchLatestMainCommit(fetchImpl as typeof fetch)).resolves.toBe(SHA);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/fancydirty/mediary-scout/commits/main",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("returns null on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 403 }));
    await expect(fetchLatestMainCommit(fetchImpl as typeof fetch)).resolves.toBeNull();
  });

  it("returns null on malformed payload", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sha: "not-a-sha" }), { status: 200 }));
    await expect(fetchLatestMainCommit(fetchImpl as typeof fetch)).resolves.toBeNull();
  });
});
