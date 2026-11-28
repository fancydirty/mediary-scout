/**
 * Connection-time SSRF guard for external cloud-drive download/redirect resolution
 * and server-side media proxying.
 *
 * Design invariants:
 *  1. NEVER run IPv6 prefix checks (`fc`/`fd`) against DNS hostnames — parse IPv4/IPv6
 *     literals explicitly so legitimate public hostnames like `fcdn.189.cn` or
 *     `fd.123pan.cn` are never blocked.
 *  2. Block all RFC 6890 non-publicly-routable IPv4/IPv6 ranges (loopback, RFC1918,
 *     link-local/metadata, CGNAT, benchmarking, documentation, ULA, multicast, reserved)
 *     BOTH syntactically on literal hosts AND at TCP connect time via a guarded
 *     `dns.lookup` callback with `agent: false` (no shared keep-alive socket bypass).
 *  3. Enforce a hard total deadline timer covering DNS + headers + body reading.
 *  4. Keep module-level imports free of `node:dns`/`node:http`/`node:https`/`node:net` so
 *     Turbopack client bundling of `@media-track/workflow` stays clean; Node built-ins are
 *     loaded lazily at server call time via `process.getBuiltinModule`.
 */
import type * as DnsModule from "node:dns";
import type * as HttpModule from "node:http";
import type * as HttpsModule from "node:https";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return nums as [number, number, number, number];
}

function isPrivateIpv4Octets([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 ("this" network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1 documentation)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/** Strict IPv6 literal parser returning all 8 16-bit hextets, or null for non-IPv6 strings. */
function parseIpv6Hextets(raw: string): number[] | null {
  if (!raw.includes(":")) return null;
  let ip = raw;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Octets(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const doubleSplit = ip.split("::");
  if (doubleSplit.length > 2) return null;
  const parseGroup = (part: string): number[] | null => {
    if (!part) return [];
    const segs = part.split(":");
    const out: number[] = [];
    for (const seg of segs) {
      if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
    return out;
  };
  if (doubleSplit.length === 1) {
    const groups = parseGroup(doubleSplit[0]!);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = parseGroup(doubleSplit[0]!);
  const right = parseGroup(doubleSplit[1]!);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function detectIpVersion(rawIp: string): 0 | 4 | 6 {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (parseIpv4Octets(ip)) return 4;
  if (parseIpv6Hextets(ip)) return 6;
  return 0;
}

/** True when `rawIp` is a loopback, link-local, RFC1918, ULA, CGNAT, documentation, or reserved IP literal. */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const v4 = parseIpv4Octets(ip);
  if (v4) {
    return isPrivateIpv4Octets(v4);
  }
  const v6 = parseIpv6Hextets(ip);
  if (v6) {
    const isAllZero = v6.every((h) => h === 0);
    const isLoopback = v6.slice(0, 7).every((h) => h === 0) && v6[7] === 1;
    if (isAllZero || isLoopback) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const isV4Mapped =
      v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff;
    if (isV4Mapped) {
      return isPrivateIpv4Octets([
        (v6[6]! >> 8) & 0xff,
        v6[6]! & 0xff,
        (v6[7]! >> 8) & 0xff,
        v6[7]! & 0xff,
      ]);
    }
    const first = v6[0]!;
    // ULA fc00::/7, link-local fe80::/10, multicast ff00::/8
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xff00) === 0xff00) return true;
    // NAT64 well-known 64:ff9b::/96 (RFC 6052) and local-use 64:ff9b:1::/48 (RFC 8215),
    // discard-only 100::/64, benchmarking/IETF special 2001::/23 (includes 2001:2::/48),
    // and documentation 2001:db8::/32.
    if (
      first === 0x0064 &&
      v6[1] === 0xff9b &&
      (v6[2] === 1 || (v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0))
    ) {
      return true;
    }
    if (first === 0x0100 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0) return true;
    if (first === 0x2001 && v6[1]! <= 0x01ff) return true;
    if (first === 0x2001 && v6[1] === 0x0db8) return true;
    return false;
  }
  return false;
}

/** Validate an external download/redirect URL syntactically (scheme, credentials, literal IPs, local names). */
export function assertSafeExternalHttpUrl(rawUrl: string, errorPrefix: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${errorPrefix}: invalid download URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${errorPrefix}: disallowed download URL scheme ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${errorPrefix}: download URL must not contain embedded credentials`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`${errorPrefix}: disallowed private/internal download host ${host}`);
  }
  if (detectIpVersion(host) !== 0 && isPrivateOrReservedIp(host)) {
    throw new Error(`${errorPrefix}: disallowed private/internal download host ${host}`);
  }
  return parsed.toString();
}

export interface GuardedHttpResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  text: string;
}

const MAX_GUARDED_BODY_BYTES = 64 * 1024;

function loadNodeBuiltin<T>(id: string, errorPrefix: string): T {
  const getter = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  const mod = typeof getter === "function" ? getter(id) : undefined;
  if (!mod) {
    throw new Error(`${errorPrefix}: Node builtin ${id} unavailable in this runtime`);
  }
  return mod as T;
}

/** Build a Node `dns.lookup`-compatible callback that validates every resolved IP address
 *  against `isPrivateOrReservedIp` before allowing any TCP connection. */
export function createGuardedDnsLookup(errorPrefix: string): typeof DnsModule.lookup {
  const dns = loadNodeBuiltin<typeof DnsModule>("node:dns", errorPrefix);
  return ((
    hostname: string,
    options: unknown,
    callback?: unknown,
  ) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | DnsModule.LookupAddress[],
      family?: number,
    ) => void;
    const opts = typeof options === "object" && options !== null ? (options as DnsModule.LookupOptions) : {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) {
        cb(err, "");
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        cb(new Error(`${errorPrefix}: DNS lookup returned no addresses for ${hostname}`), "");
        return;
      }
      for (const entry of list) {
        if (isPrivateOrReservedIp(entry.address)) {
          cb(
            new Error(
              `${errorPrefix}: disallowed private/internal resolved address ${entry.address} for ${hostname}`,
            ),
            "",
          );
          return;
        }
      }
      if (opts.all) {
        cb(null, list);
      } else {
        const first = list[0]!;
        cb(null, first.address, first.family);
      }
    });
  }) as typeof DnsModule.lookup;
}

/**
 * Perform a single manual-redirect HTTP(S) GET with connection-time DNS/IP SSRF enforcement:
 *  - Uses `agent: false` so every request opens a fresh connection through `createGuardedDnsLookup`
 *    (never reusing pooled sockets from Node's global HTTP(S) agent).
 *  - Enforces a total wall-clock deadline covering DNS lookup + headers + body read.
 *  - Caps text/JSON body reads to `maxBodyBytes`, and handles untyped (`contentType === null`)
 *    small JSON dispatch bodies safely while destroying non-JSON binary streams immediately.
 */
export async function guardedManualGet(input: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  errorPrefix: string;
  readTextBody?: boolean;
  maxBodyBytes?: number;
}): Promise<GuardedHttpResponse> {
  const safeUrl = assertSafeExternalHttpUrl(input.url, input.errorPrefix);
  const parsed = new URL(safeUrl);
  const guardedLookup = createGuardedDnsLookup(input.errorPrefix);
  const transport =
    parsed.protocol === "https:"
      ? loadNodeBuiltin<typeof HttpsModule>("node:https", input.errorPrefix)
      : loadNodeBuiltin<typeof HttpModule>("node:http", input.errorPrefix);
  const maxBytes = input.maxBodyBytes ?? MAX_GUARDED_BODY_BYTES;

  return new Promise<GuardedHttpResponse>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      fn();
    };

    const req = transport.request(
      parsed,
      {
        method: "GET",
        headers: input.headers,
        agent: false,
        lookup: guardedLookup,
        timeout: input.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const rawLoc = res.headers["location"];
        const location = Array.isArray(rawLoc) ? (rawLoc[0] ?? null) : (rawLoc ?? null);
        const rawCt = res.headers["content-type"];
        const contentType = Array.isArray(rawCt) ? (rawCt[0] ?? null) : (rawCt ?? null);
        const ctLower = (contentType ?? "").toLowerCase();
        const isExplicitTextOrJson = ctLower.includes("json") || ctLower.includes("text");
        const isUntyped = contentType === null;

        if (!input.readTextBody || (status >= 300 && status < 400) || (!isExplicitTextOrJson && !isUntyped)) {
          res.destroy();
          finish(() => resolve({ status, location, contentType, text: "" }));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let untypedVerifiedJsonStart = !isUntyped;
        res.on("data", (chunk: Buffer) => {
          // For untyped responses, sniff across chunks until the first non-whitespace byte:
          // if it is NOT `{` (0x7b), treat as binary media stream and abort without buffering.
          if (!untypedVerifiedJsonStart) {
            for (let i = 0; i < chunk.length; i += 1) {
              const b = chunk[i]!;
              if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
                continue;
              }
              if (b !== 0x7b) {
                res.destroy();
                finish(() => resolve({ status, location, contentType, text: "" }));
                return;
              }
              untypedVerifiedJsonStart = true;
              break;
            }
          }
          total += chunk.byteLength;
          if (total > maxBytes) {
            res.destroy();
            finish(() =>
              reject(new Error(`${input.errorPrefix}: dispatch response body exceeded ${maxBytes} bytes`)),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks, total).toString("utf8");
          finish(() => resolve({ status, location, contentType, text }));
        });
        res.on("error", (err) => {
          finish(() => reject(err));
        });
      },
    );

    deadlineTimer = setTimeout(() => {
      req.destroy(new Error(`${input.errorPrefix}: redirect resolution timed out`));
    }, input.timeoutMs);

    req.on("timeout", () => {
      req.destroy(new Error(`${input.errorPrefix}: redirect resolution timed out`));
    });
    req.on("error", (err) => {
      finish(() => reject(err));
    });
    req.end();
  });
}
