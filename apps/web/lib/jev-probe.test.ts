import { describe, expect, it } from "vitest";
import { probeJev } from "./jev-probe";

/** A valid decisions answer: what a live Jev endpoint returns for the probe question. */
const ok = (async () =>
  new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: { probe: { type: "noul", noul: 0.97 } } }), {
    status: 200,
  })) as unknown as typeof fetch;

const failWith = (impl: () => Promise<Response>) => impl as unknown as typeof fetch;

describe("probeJev", () => {
  it("returns ok with the resolved model on a valid answer", async () => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://openrouter.ai/api/alpha/decisions" },
      { fetchImpl: ok },
    );
    expect(r).toEqual({ ok: true, model: "typesafe/jev-1.13" });
  });

  it("sends a single fixed noul question with bearer auth to the base URL", async () => {
    const seen: { url: string; auth: unknown; body: Record<string, unknown> }[] = [];
    await probeJev(
      { apiKey: "sk-abc", baseUrl: "https://x/decisions" },
      {
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen.push({
            url,
            auth: (init.headers as Record<string, string>).Authorization,
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          return (ok as unknown as (u: string, i: RequestInit) => Promise<Response>)(url, init);
        }) as unknown as typeof fetch,
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://x/decisions");
    expect(seen[0]!.auth).toBe("Bearer sk-abc");
    expect(seen[0]!.body.model).toBe("jev-latest");
    expect(Object.keys(seen[0]!.body.questions as Record<string, unknown>)).toEqual(["probe"]);
  });

  it("401 → auth_failed with a user-facing message (no key echoed)", async () => {
    const r = await probeJev(
      { apiKey: "sk-SECRET", baseUrl: "https://x" },
      { fetchImpl: failWith(async () => new Response("", { status: 401 })) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("auth_failed");
      expect(r.message).not.toContain("SECRET");
    }
  });

  it("500 → http_error (distinct from a bad key, so the message can say so)", async () => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      { fetchImpl: failWith(async () => new Response("", { status: 500 })) },
    );
    expect(r).toMatchObject({ ok: false, reason: "http_error" });
  });

  it("connection error → unreachable", async () => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      {
        fetchImpl: failWith(async () => {
          throw new Error("fetch failed");
        }),
      },
    );
    expect(r).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("200 with a non-decisions body → not_jev", async () => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      { fetchImpl: failWith(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) },
    );
    expect(r).toMatchObject({ ok: false, reason: "not_jev" });
  });
});
