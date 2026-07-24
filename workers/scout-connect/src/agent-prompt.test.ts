import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "./agent-prompt.js";

const INPUT = {
  hostname: "kiki-connect.example.com",
  tunnelToken: "eyJsecret-tunnel-token-value",
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buildAgentPrompt", () => {
  it("contains the hostname exactly twice", () => {
    const out = buildAgentPrompt(INPUT);
    expect(countOccurrences(out, INPUT.hostname)).toBe(2);
  });

  it("contains the tunnel token exactly once", () => {
    const out = buildAgentPrompt(INPUT);
    expect(countOccurrences(out, INPUT.tunnelToken)).toBe(1);
  });

  it("contains key fixed phrases", () => {
    const out = buildAgentPrompt(INPUT);
    expect(out).toContain("Scout Connect");
    expect(out).toContain("docker compose --profile tunnel up -d");
    expect(out).toContain("TUNNEL_TRANSPORT_PROTOCOL=http2");
  });

  it("is deterministic for the same input", () => {
    expect(buildAgentPrompt(INPUT)).toBe(buildAgentPrompt(INPUT));
  });
});
