import { describe, expect, it } from "vitest";
import { buildConnectPrompt, CLAIM_CODE_PLACEHOLDER } from "./connect-prompt.js";

const OK = {
  hostname: "dirtyfancy.mediaryconnect.app",
  claimCode: "claim.YWJj.1730000000000.deadbeef",
  baseUrl: "https://mediaryconnect.app",
};

describe("buildConnectPrompt", () => {
  it("embeds the hostname, claim code, and connect.sh command", () => {
    const out = buildConnectPrompt(OK);
    expect(out).toContain("https://dirtyfancy.mediaryconnect.app");
    expect(out).toContain(`curl -fsSL https://mediaryconnect.app/connect.sh | sh -s -- ${OK.claimCode}`);
  });

  it("carries the go-find-the-machine intelligence (SSH, ask, don't guess)", () => {
    const out = buildConnectPrompt(OK);
    expect(out).toContain("SSH");
    expect(out).toContain("绝不猜地址乱试");
    expect(out).toContain("部署目录");
  });

  it("NEVER contains a tunnel token — only the short-lived claim code (token 不落库)", () => {
    const out = buildConnectPrompt(OK);
    // 提示词只带取件码;真正的 token 由 connect.sh 现场换取。
    expect(out).not.toMatch(/TUNNEL_TOKEN=/);
    expect(out).toContain("15 分钟");
  });

  it("uses only the origin of baseUrl, dropping any path/query", () => {
    const out = buildConnectPrompt({ ...OK, baseUrl: "https://mediaryconnect.app/console?x=1" });
    expect(out).toContain("https://mediaryconnect.app/connect.sh");
    expect(out).not.toContain("/console?x=1");
  });

  it("accepts the console injection placeholder as a valid claim code", () => {
    expect(() => buildConnectPrompt({ ...OK, claimCode: CLAIM_CODE_PLACEHOLDER })).not.toThrow();
    expect(buildConnectPrompt({ ...OK, claimCode: CLAIM_CODE_PLACEHOLDER })).toContain(
      CLAIM_CODE_PLACEHOLDER,
    );
  });

  it("rejects a hostname with shell/path metacharacters", () => {
    expect(() => buildConnectPrompt({ ...OK, hostname: "h.example.com; rm -rf /" })).toThrow();
    expect(() => buildConnectPrompt({ ...OK, hostname: "h.example.com/../x" })).toThrow();
  });

  it("rejects a claim code with injection characters", () => {
    expect(() => buildConnectPrompt({ ...OK, claimCode: "abc; curl evil" })).toThrow();
    expect(() => buildConnectPrompt({ ...OK, claimCode: "abc\ndef" })).toThrow();
  });

  it("rejects a non-URL baseUrl", () => {
    expect(() => buildConnectPrompt({ ...OK, baseUrl: "not a url" })).toThrow();
  });
});
