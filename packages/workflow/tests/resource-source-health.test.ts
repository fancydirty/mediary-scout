import { describe, expect, it } from "vitest";
import {
  classifySourceFailure,
  mergeSourceHealth,
  isSourceUsable,
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
