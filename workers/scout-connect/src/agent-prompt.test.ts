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
  it("contains the hostname in the goal, verification, and closing steps", () => {
    const out = buildAgentPrompt(INPUT);
    // goal (https://…), 第 5 步 verification, 第 6 步 closing — 3 occurrences
    expect(countOccurrences(out, INPUT.hostname)).toBe(3);
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
    expect(out).toContain("Registered tunnel connection");
    expect(out).toContain("docker compose ls");
    expect(out).toContain("docker compose logs cloudflared --tail 30");
  });

  it("covers the audited failure modes", () => {
    const out = buildAgentPrompt(INPUT);
    // image-pull retry (OrbStack e2e finding)
    expect(out).toContain("docker compose --profile tunnel pull");
    // backup discipline
    expect(out).toContain("备份");
    // not "restart" (restart doesn't re-read .env)
    expect(out).toContain("restart 不会重读 .env");
    // Access verification is done by the human, not the agent
    expect(out).toContain("不要自行声称验证结果");
  });

  it("is deterministic for the same input", () => {
    expect(buildAgentPrompt(INPUT)).toBe(buildAgentPrompt(INPUT));
  });
});
