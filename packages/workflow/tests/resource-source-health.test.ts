import { describe, expect, it } from "vitest";
import {
  classifySourceFailure,
  mergeSourceHealth,
  isSourceUsable,
  PanSouProtocolError,
  hasRecognisedUnreachableCode,
} from "../src/resource-source-health.js";

describe("classifySourceFailure", () => {
  it("classifies connection refused as unreachable", () => {
    const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), {
      code: "ECONNREFUSED",
    });
    expect(classifySourceFailure(e)).toBe("unreachable");
  });

  it("classifies DNS failure as unreachable", () => {
    const e = Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), {
      code: "ENOTFOUND",
    });
    expect(classifySourceFailure(e)).toBe("unreachable");
  });

  it("classifies a timeout as unreachable", () => {
    expect(classifySourceFailure(new Error("Request timed out after 8000ms"))).toBe("unreachable");
  });

  it("classifies a non-PanSou JSON shape as protocol_error", () => {
    expect(classifySourceFailure(new Error("PANSOU_BAD_RESPONSE: not a PanSou payload"))).toBe(
      "protocol_error",
    );
  });

  it("classifies PanSouProtocolError by instanceof, not by message text", () => {
    // instanceof is the type-safe path; the string prefix is only a cross-process
    // fallback. Renaming the message must not downgrade protocol_error.
    expect(classifySourceFailure(new PanSouProtocolError("whatever wording"))).toBe(
      "protocol_error",
    );
  });

  it("unwraps error.cause to find the socket code (undici wraps it)", () => {
    // Node fetch surfaces a flat "fetch failed" and hides ECONNREFUSED on .cause.
    // Without unwrapping, UNREACHABLE_CODES would never match in production.
    const wrapped = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(classifySourceFailure(wrapped)).toBe("unreachable");
    // Assert the MECHANISM, not just the outcome: the fallback also returns
    // "unreachable", so without this the cause-unwrap could be deleted and the
    // test would stay green (verified by mutation).
    expect(hasRecognisedUnreachableCode(wrapped)).toBe(true);
  });

  it("falls back to unreachable for an unrecognised error rather than pretending success", () => {
    expect(classifySourceFailure(new Error("something weird"))).toBe("unreachable");
  });
});

describe("isSourceUsable", () => {
  it("treats healthy as usable", () => {
    expect(isSourceUsable({ status: "healthy", source: "pansou" })).toBe(true);
  });

  it("treats unreachable and protocol_error as unusable", () => {
    expect(isSourceUsable({ status: "unreachable", source: "pansou" })).toBe(false);
    expect(isSourceUsable({ status: "protocol_error", source: "pansou" })).toBe(false);
  });
});

describe("mergeSourceHealth", () => {
  it("is healthy when every source answered", () => {
    const merged = mergeSourceHealth([
      { status: "healthy", source: "pansou" },
      { status: "healthy", source: "prowlarr" },
    ]);
    expect(merged.status).toBe("healthy");
    expect(merged.unhealthySources).toEqual([]);
  });

  it("is degraded when some sources answered and some did not", () => {
    const merged = mergeSourceHealth([
      { status: "healthy", source: "pansou" },
      { status: "unreachable", source: "prowlarr" },
    ]);
    expect(merged.status).toBe("degraded");
    expect(merged.unhealthySources).toEqual(["prowlarr"]);
  });

  it("is unreachable when no source answered", () => {
    const merged = mergeSourceHealth([
      { status: "unreachable", source: "pansou" },
      { status: "protocol_error", source: "prowlarr" },
    ]);
    expect(merged.status).toBe("unreachable");
    expect(merged.unhealthySources).toEqual(["pansou", "prowlarr"]);
  });

  it("is healthy for an empty list (no sources configured is not a failure)", () => {
    const merged = mergeSourceHealth([]);
    expect(merged.status).toBe("healthy");
    expect(merged.unhealthySources).toEqual([]);
  });
});
