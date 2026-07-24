const API_BASE = "https://api.cloudflare.com/client/v4";
const WEB_SERVICE = "http://web:3000";
const CATCH_ALL_SERVICE = "http_status:404";

export interface CfApi {
  createTunnel(name: string): Promise<{ tunnelId: string; token: string }>;
  /** service fixed http://web:3000 + catch-all 404 */
  putTunnelIngress(tunnelId: string, hostname: string): Promise<void>;
  createDnsCname(slug: string, tunnelId: string): Promise<{ recordId: string }>;
  createAccessApp(input: {
    name: string;
    domain: string;
    email: string;
  }): Promise<{ appId: string; policyId?: string }>;
  deleteTunnel(tunnelId: string): Promise<void>;
  deleteDnsRecord(recordId: string): Promise<void>;
  deleteAccessApp(appId: string): Promise<void>;
}

export interface CfApiOptions {
  accountId: string;
  zoneId: string;
  apiToken: string;
  fetchImpl?: typeof fetch; // injected for tests
}

interface ResolvedOptions {
  accountId: string;
  zoneId: string;
  apiToken: string;
  fetchImpl: typeof fetch;
}

interface CfEnvelope {
  success: boolean;
  errors: ReadonlyArray<{ code?: unknown; message?: unknown }> | null;
  result: unknown;
}

function toEnvelope(raw: unknown): CfEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  return {
    success: obj.success === true,
    errors: Array.isArray(obj.errors)
      ? (obj.errors as ReadonlyArray<{ code?: unknown; message?: unknown }>)
      : null,
    result: obj.result,
  };
}

function firstErrorMessage(envelope: CfEnvelope | null): string | undefined {
  const first = envelope?.errors?.[0];
  if (first !== undefined && typeof first.message === "string" && first.message !== "") {
    return first.message;
  }
  return undefined;
}

function isNotFoundEnvelope(envelope: CfEnvelope | null): boolean {
  return (
    envelope?.errors?.some((e) => {
      if (typeof e.message !== "string") return false;
      const msg = e.message.toLowerCase();
      return msg.includes("not found") || msg.includes("does not exist");
    }) ?? false
  );
}

// SECURITY: error messages must never carry the apiToken, the Authorization
// header, or request/response bodies (a tunnel-create response contains the
// tunnel token). Only the api's own errors[].message or the HTTP status.
function cfError(envelope: CfEnvelope | null, status: number): Error {
  return new Error(firstErrorMessage(envelope) ?? `HTTP ${status}`);
}

function isActiveConnectionsError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.message.includes("active connections") || e.message.includes("1022"))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`cloudflare response missing ${field}`);
  }
  return value;
}

function requestInit(resolved: ResolvedOptions, method: string, body: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${resolved.apiToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function cfJson(
  resolved: ResolvedOptions,
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const res = await resolved.fetchImpl(url, requestInit(resolved, method, body));
  let envelope: CfEnvelope | null = null;
  try {
    envelope = toEnvelope(await res.json());
  } catch {
    envelope = null;
  }
  if (!res.ok || envelope === null || !envelope.success) {
    throw cfError(envelope, res.status);
  }
  return envelope.result;
}

// ALL deletes are idempotent by design (revoke can be retried safely):
//  - HTTP 404 → already gone, success.
//  - 2xx with success:false whose errors say "not found"/"does not exist" →
//    also success (CF products phrase not-found differently per resource).
// Anything else is a real error.
async function cfDelete(resolved: ResolvedOptions, url: string): Promise<void> {
  const res = await resolved.fetchImpl(url, requestInit(resolved, "DELETE", undefined));
  // 404 → already gone. Checked BEFORE parsing the body.
  if (res.status === 404) return;
  let envelope: CfEnvelope | null = null;
  try {
    envelope = toEnvelope(await res.json());
  } catch {
    envelope = null;
  }
  if (!res.ok || (envelope !== null && !envelope.success)) {
    if (isNotFoundEnvelope(envelope)) return;
    throw cfError(envelope, res.status);
  }
}

function extractPolicyId(policies: unknown): string | undefined {
  if (!Array.isArray(policies)) return undefined;
  for (const policy of policies) {
    if (typeof policy === "object" && policy !== null) {
      const id = (policy as Record<string, unknown>).id;
      if (typeof id === "string" && id !== "") return id;
    }
  }
  return undefined;
}

export function createCfApi(opts: CfApiOptions): CfApi {
  const resolved: ResolvedOptions = {
    accountId: opts.accountId,
    zoneId: opts.zoneId,
    apiToken: opts.apiToken,
    // workerd throws "Illegal invocation" when fetch is called detached from
    // globalThis — always wrap the default so it's invoked as a plain call.
    fetchImpl: opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init)),
  };
  const accountPath = `${API_BASE}/accounts/${encodeURIComponent(resolved.accountId)}`;
  const zonePath = `${API_BASE}/zones/${encodeURIComponent(resolved.zoneId)}`;

  return {
    async createTunnel(name) {
      const result = (await cfJson(resolved, "POST", `${accountPath}/cfd_tunnel`, {
        name,
        config_src: "cloudflare",
      })) as { id?: unknown; token?: unknown } | null;
      return {
        tunnelId: requireString(result?.id, "tunnel id"),
        token: requireString(result?.token, "tunnel token"),
      };
    },

    async putTunnelIngress(tunnelId, hostname) {
      await cfJson(
        resolved,
        "PUT",
        `${accountPath}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
        {
          config: {
            ingress: [
              { hostname, service: WEB_SERVICE },
              { service: CATCH_ALL_SERVICE },
            ],
          },
        },
      );
    },

    async createDnsCname(slug, tunnelId) {
      const result = (await cfJson(resolved, "POST", `${zonePath}/dns_records`, {
        type: "CNAME",
        name: slug,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      })) as { id?: unknown } | null;
      return { recordId: requireString(result?.id, "dns record id") };
    },

    async createAccessApp(input) {
      const result = (await cfJson(resolved, "POST", `${accountPath}/access/apps`, {
        name: input.name,
        domain: input.domain,
        type: "self_hosted",
        session_duration: "24h",
        policies: [
          {
            decision: "allow",
            name: "allow-invitee",
            precedence: 1,
            include: [{ email: { email: input.email } }],
          },
        ],
      })) as { id?: unknown; policies?: unknown } | null;
      const appId = requireString(result?.id, "access app id");
      const policyId = extractPolicyId(result?.policies);
      return { appId, ...(policyId === undefined ? {} : { policyId }) };
    },

    async deleteTunnel(tunnelId) {
      // CF rejects tunnel deletion with error 1022 while cloudflared still
      // holds connections open (e.g. revoke right after a live e2e). Close
      // them first — DELETE .../connections disconnects all replicas — then
      // retry the delete a few times while connections drain.
      await cfDelete(
        resolved,
        `${accountPath}/cfd_tunnel/${encodeURIComponent(tunnelId)}/connections`,
      );
      const deleteUrl = `${accountPath}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;
      let lastError: unknown;
      for (let attemptIdx = 0; attemptIdx < 4; attemptIdx++) {
        try {
          await cfDelete(resolved, deleteUrl);
          return;
        } catch (e) {
          lastError = e;
          if (!isActiveConnectionsError(e)) throw e;
          if (attemptIdx < 3) {
            await sleep(1500 * (attemptIdx + 1));
          }
        }
      }
      throw lastError;
    },

    async deleteDnsRecord(recordId) {
      await cfDelete(resolved, `${zonePath}/dns_records/${encodeURIComponent(recordId)}`);
    },

    async deleteAccessApp(appId) {
      await cfDelete(resolved, `${accountPath}/access/apps/${encodeURIComponent(appId)}`);
    },
  };
}
