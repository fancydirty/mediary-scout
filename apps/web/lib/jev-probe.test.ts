import { describe, expect, it } from "vitest";
import { JEV_MODEL } from "@media-track/workflow";
import { probeJev, validateJevBaseUrlFormat } from "./jev-probe";

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
    expect(seen[0]!.body.model).toBe(JEV_MODEL);
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
      // The key may come from OpenRouter OR TypeSafe's own console: the message names
      // the thing the user configured ("Jev API Key"), never one vendor's key.
      expect(r.message).toContain("Jev API Key");
      expect(r.message).not.toContain("OpenRouter Key");
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

  it("200 with a body that is not JSON at all (an nginx page) → not_jev", async () => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      { fetchImpl: failWith(async () => new Response("<html>502 Bad Gateway</html>", { status: 200 })) },
    );
    expect(r).toMatchObject({ ok: false, reason: "not_jev" });
  });

  // The headers arrived, then the body read failed. What undici really rejects
  // response.json() with (checked against a local server): a dropped connection →
  // TypeError "terminated"; the 8s signal firing mid-body → DOMException TimeoutError.
  // Neither says anything about what the endpoint IS, so neither may become not_jev.
  const bodyFailsWith = (error: unknown) =>
    failWith(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"answers":{"probe":'));
              controller.error(error);
            },
          }),
          { status: 200 },
        ),
    );

  it("connection dropped while reading the body → unreachable (network), not not_jev", async () => {
    const r = await probeJev({ apiKey: "k", baseUrl: "https://x" }, { fetchImpl: bodyFailsWith(new TypeError("terminated")) });
    expect(r).toMatchObject({ ok: false, reason: "unreachable" });
    if (!r.ok) expect(r.message).toMatch(/网络错误/);
  });

  it("the 8s budget running out while reading the body → unreachable (timeout), not not_jev", async () => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      { fetchImpl: bodyFailsWith(new DOMException("The operation was aborted due to timeout", "TimeoutError")) },
    );
    expect(r).toMatchObject({ ok: false, reason: "unreachable" });
    if (!r.ok) expect(r.message).toMatch(/8 秒/);
  });

  // The client rejects any answer that is not a finite 0..1 number; a probe that
  // accepted one would mark as healthy an endpoint every real search then fails on
  // (silently, since the prefilter fails open).
  it.each([2, -0.1, "0.5", null])("an answer the real client would reject (noul=%j) → not_jev", async (noul) => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      { fetchImpl: failWith(async () => new Response(JSON.stringify({ model: "m", answers: { probe: { noul } } }), { status: 200 })) },
    );
    expect(r).toMatchObject({ ok: false, reason: "not_jev" });
  });

  // The client sends JEV_MODEL; a probe that asked for a different model would
  // validate an endpoint the real搜索 never exercises.
  it("asks for the same model constant the client sends", async () => {
    let body: Record<string, unknown> = {};
    await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      {
        fetchImpl: (async (_url: string, init: RequestInit) => {
          body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ model: "m", answers: { probe: { noul: 0.1 } } }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
      },
    );
    expect(body.model).toBe(JEV_MODEL);
  });

  it("timeout → a message that names the 8s budget (not the generic network text)", async () => {
    const r = await probeJev(
      { apiKey: "k", baseUrl: "https://x" },
      {
        fetchImpl: failWith(async () => {
          throw Object.assign(new Error("x"), { name: "TimeoutError" });
        }),
      },
    );
    expect(r).toMatchObject({ ok: false, reason: "unreachable" });
    if (!r.ok) expect(r.message).toMatch(/8 秒/);
  });

  // undici quotes the offending header VALUE — i.e. the API key — in its own
  // error text. That text must never be interpolated into a user-facing message.
  it("never leaks the key from an error message into the failure text", async () => {
    const r = await probeJev(
      { apiKey: "sk-SECRET", baseUrl: "https://x" },
      {
        fetchImpl: failWith(async () => {
          throw new Error('Headers.append: "Bearer sk-SECRET" is an invalid header value.');
        }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain("SECRET");
  });
});

describe("validateJevBaseUrlFormat", () => {
  it("rejects a scheme-less address before any 8s probe is spent on it", () => {
    expect(validateJevBaseUrlFormat("openrouter.ai/x")).toMatchObject({ ok: false });
    expect(validateJevBaseUrlFormat("ftp://x")).toMatchObject({ ok: false });
  });

  // The key rides in the Authorization header: over a remote http:// it would cross
  // the network in clear. A NAME proves nothing about where it resolves (search
  // domains, NXDOMAIN-hijacking resolvers, mDNS spoofing), so http:// is only for
  // localhost and literal loopback / private / link-local IPs.
  it("http:// only for localhost or a literal loopback / private IP — never for a name", () => {
    for (const url of [
      "http://evil.example.com/v1/systemone",
      "http://8.8.8.8/x",
      "http://172.32.0.1/x",
      "http://attacker/v1/systemone",
      "http://jev-relay:8080/x",
      "http://nas.local/x",
      "http://relay.lan/x",
      "http://127.0.0.1.evil.example/x",
      // out-of-range octets: the URL parser already refuses these, and the IP check
      // refuses them on its own terms too
      "http://127.999.999.999/x",
      "http://10.999.999.999/x",
      "http://192.168.1.300/x",
    ]) {
      expect(validateJevBaseUrlFormat(url), url).toMatchObject({ ok: false });
    }
    for (const url of [
      "http://localhost:8080/x",
      "http://127.0.0.1/x",
      "http://[::1]:8080/x",
      "http://10.0.0.5/x",
      "http://172.20.0.3/x",
      "http://192.168.1.10:8080/v1/systemone",
      "http://169.254.1.2/x",
    ]) {
      expect(validateJevBaseUrlFormat(url), url).toEqual({ ok: true });
    }
    expect(validateJevBaseUrlFormat("https://any.example.com/v1/systemone")).toEqual({ ok: true });
  });

  it("accepts http/https (whitespace tolerated, same as the probe)", () => {
    expect(validateJevBaseUrlFormat("https://openrouter.ai/api/alpha/decisions")).toEqual({ ok: true });
    expect(validateJevBaseUrlFormat("  http://localhost:8080/v1/systemone  ")).toEqual({ ok: true });
  });
});
