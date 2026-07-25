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
    // backup discipline: mandatory cp + verification that the backup exists
    expect(out).toContain('BACKUP_FILE=".env.bak-');
    expect(out).toContain('cp .env "$BACKUP_FILE"');
    expect(out).toContain('if [ ! -f "$BACKUP_FILE" ]');
    // atomic write: printf with a literal format string, never shell expansion
    expect(out).toContain("printf 'TUNNEL_TOKEN=%s\\n'");
    // rollback must use stop + rm -f + up -d (down can't target a service,
    // restart doesn't re-read .env)
    expect(out).toContain("docker compose stop cloudflared");
    expect(out).toContain("docker compose rm -f cloudflared");
    // verification polls instead of a fixed sleep (avoids false negatives)
    expect(out).toContain("MAX_WAIT=60");
    // not "restart" (restart doesn't re-read .env)
    expect(out).toContain("restart 不会重读 .env");
    // Access verification is done by the human, not the agent
    expect(out).toContain("不要自行声称验证结果");
  });

  it("is deterministic for the same input", () => {
    expect(buildAgentPrompt(INPUT)).toBe(buildAgentPrompt(INPUT));
  });
});
