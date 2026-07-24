import { describe, it, expect } from "vitest";
import { createCfApi } from "./cf-api.js";

const ACCOUNT_ID = "acc-1";
const ZONE_ID = "zone-1";
const API_TOKEN = "secret-token-fixture"; // fixture only — must never leak into errors
const BASE = "https://api.cloudflare.com/client/v4";

interface QueuedResponse {
  status?: number;
  json?: unknown;
}

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(queue: QueuedResponse[]): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, headers, body });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`mockFetch: unexpected ${method} ${url}`);
    }
    return new Response(
      JSON.stringify(next.json ?? { success: true, errors: [], result: {} }),
      { status: next.status ?? 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeApi(queue: QueuedResponse[]) {
  const mock = mockFetch(queue);
  const api = createCfApi({
    accountId: ACCOUNT_ID,
    zoneId: ZONE_ID,
    apiToken: API_TOKEN,
    fetchImpl: mock.fetchImpl,
  });
  return { api, calls: mock.calls };
}

async function catchError(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`threw non-Error: ${String(e)}`);
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("cf-api", () => {
  it("createTunnel POSTs and parses id+token", async () => {
    const { api, calls } = makeApi([
      { json: { success: true, errors: [], result: { id: "tid", token: "tok" } } },
    ]);
    const out = await api.createTunnel("my-tunnel");
    expect(out).toEqual({ tunnelId: "tid", token: "tok" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/accounts/${ACCOUNT_ID}/cfd_tunnel`);
    expect(call.headers.Authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ name: "my-tunnel", config_src: "cloudflare" });
  });

  it("putTunnelIngress sends web service + catch-all 404", async () => {
    const { api, calls } = makeApi([{}]);
    await api.putTunnelIngress("tid", "slug.example.com");
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(`${BASE}/accounts/${ACCOUNT_ID}/cfd_tunnel/tid/configurations`);
    const body = call.body as { config: { ingress: Array<Record<string, unknown>> } };
    expect(body.config.ingress).toHaveLength(2);
    expect(body.config.ingress[0]).toEqual({
      hostname: "slug.example.com",
      service: "http://web:3000",
    });
    expect(body.config.ingress[1]).toEqual({ service: "http_status:404" });
  });

  it("createDnsCname POSTs a proxied CNAME at <tunnelId>.cfargotunnel.com", async () => {
    const { api, calls } = makeApi([
      { json: { success: true, errors: [], result: { id: "rec-1" } } },
    ]);
    const out = await api.createDnsCname("slug", "tid");
    expect(out).toEqual({ recordId: "rec-1" });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/zones/${ZONE_ID}/dns_records`);
    expect(call.body).toEqual({
      type: "CNAME",
      name: "slug",
      content: "tid.cfargotunnel.com",
      proxied: true,
      ttl: 1,
    });
  });

  it("createAccessApp POSTs a self_hosted app with an inline email allow policy", async () => {
    const { api, calls } = makeApi([
      {
        json: {
          success: true,
          errors: [],
          result: { id: "app-1", policies: [{ id: "pol-1", name: "allow-invitee" }] },
        },
      },
    ]);
    const out = await api.createAccessApp({
      name: "Scout Connect slug",
      domain: "slug.example.com",
      email: "user@example.com",
    });
    expect(out).toEqual({ appId: "app-1", policyId: "pol-1" });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/accounts/${ACCOUNT_ID}/access/apps`);
    const body = call.body as {
      name: string;
      domain: string;
      type: string;
      session_duration: string;
      policies: Array<{
        decision: string;
        name: string;
        precedence: number;
        include: Array<{ email: { email: string } }>;
      }>;
    };
    expect(body.name).toBe("Scout Connect slug");
    expect(body.domain).toBe("slug.example.com");
    expect(body.type).toBe("self_hosted");
    expect(body.session_duration).toBe("24h");
    expect(body.policies[0]).toEqual({
      decision: "allow",
      name: "allow-invitee",
      precedence: 1,
      include: [{ email: { email: "user@example.com" } }],
    });
  });

  it("createAccessApp leaves policyId undefined when the response has no policy id", async () => {
    const { api } = makeApi([
      { json: { success: true, errors: [], result: { id: "app-2", policies: [] } } },
    ]);
    const out = await api.createAccessApp({
      name: "n",
      domain: "d.example.com",
      email: "e@example.com",
    });
    expect(out.appId).toBe("app-2");
    expect(out.policyId).toBeUndefined();
    expect("policyId" in out).toBe(false);
  });

  it("success:false throws the api error message without leaking the apiToken", async () => {
    const { api } = makeApi([
      { json: { success: false, errors: [{ code: 1001, message: "bad slug" }], result: null } },
    ]);
    const err = await catchError(api.createDnsCname("bad-slug", "tid"));
    expect(err.message).toContain("bad slug");
    expect(err.message).not.toContain(API_TOKEN);
  });

  it("HTTP 500 throws without leaking the apiToken or response-body secrets", async () => {
    const { api } = makeApi([
      {
        status: 500,
        json: {
          success: false,
          errors: [],
          result: { id: "tid", token: "response-token-secret" },
        },
      },
    ]);
    const err = await catchError(api.createTunnel("x"));
    expect(err.message).toContain("HTTP 500");
    expect(err.message).not.toContain(API_TOKEN);
    expect(err.message).not.toContain("response-token-secret");
  });

  it("deleteTunnel closes connections first, then deletes the tunnel", async () => {
    const { api, calls } = makeApi([
      { json: { success: true, errors: [], result: null } }, // connections
      { json: { success: true, errors: [], result: null } }, // tunnel
    ]);
    await expect(api.deleteTunnel("tid")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${BASE}/accounts/${ACCOUNT_ID}/cfd_tunnel/tid/connections`);
    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe(`${BASE}/accounts/${ACCOUNT_ID}/cfd_tunnel/tid`);
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${API_TOKEN}`);
  });

  it("deleteTunnel resolves on HTTP 404 for either call (idempotent)", async () => {
    const { api } = makeApi([
      {
        status: 404,
        json: { success: false, errors: [{ message: "tunnel not found" }], result: null },
      },
      {
        status: 404,
        json: { success: false, errors: [{ message: "tunnel not found" }], result: null },
      },
    ]);
    await expect(api.deleteTunnel("tid")).resolves.toBeUndefined();
  });

  it("deleteTunnel retries on active-connections (1022) then succeeds", async () => {
    const { api, calls } = makeApi([
      { json: { success: true, errors: [], result: null } }, // connections closed
      {
        json: {
          success: false,
          errors: [{ code: 1022, message: "This tunnel has active connections." }],
          result: null,
        },
      },
      { json: { success: true, errors: [], result: null } }, // retry succeeds
    ]);
    await expect(api.deleteTunnel("tid")).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url).toBe(`${BASE}/accounts/${ACCOUNT_ID}/cfd_tunnel/tid`);
  });

  it("deleteTunnel resolves on a success:false not-found envelope", async () => {
    const { api } = makeApi([
      { json: { success: true, errors: [], result: null } },
      {
        json: { success: false, errors: [{ code: 11000, message: "Tunnel not found" }], result: null },
      },
    ]);
    await expect(api.deleteTunnel("tid")).resolves.toBeUndefined();
  });

  it("deleteTunnel still throws on other errors", async () => {
    const { api } = makeApi([
      { json: { success: true, errors: [], result: null } },
      { status: 500, json: { success: false, errors: [{ message: "internal" }], result: null } },
    ]);
    const err = await catchError(api.deleteTunnel("tid"));
    expect(err.message).toContain("internal");
  });

  it("deleteDnsRecord and deleteAccessApp resolve on HTTP 404", async () => {
    const { api, calls } = makeApi([
      { status: 404, json: { success: false, errors: [{ message: "record not found" }], result: null } },
      { status: 404, json: { success: false, errors: [{ message: "app not found" }], result: null } },
    ]);
    await expect(api.deleteDnsRecord("rec-1")).resolves.toBeUndefined();
    await expect(api.deleteAccessApp("app-1")).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${BASE}/zones/${ZONE_ID}/dns_records/rec-1`);
    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe(`${BASE}/accounts/${ACCOUNT_ID}/access/apps/app-1`);
  });
});
