import { describe, expect, it } from "vitest";
import { rewriteEnvForTunnel } from "./tunnel-env.mjs";

const TOKEN = "tok_value_0123456789";
const HOST = "home.mediaryconnect.app";

describe("rewriteEnvForTunnel", () => {
  it("turns an empty file into exactly the two managed lines", () => {
    // Drops the two assignments, or adds a third line, and the contract breaks.
    expect(rewriteEnvForTunnel("", { token: TOKEN, hostname: HOST })).toBe(
      `TUNNEL_TOKEN=${TOKEN}\nMEDIARY_CONNECT_HOSTNAME=${HOST}\n`,
    );
  });

  it("keeps unrelated lines byte-for-byte and in order, including a CRLF line", () => {
    const content = [
      "DOCKER_MIRROR=docker.1ms.run",
      "# keep this comment",
      "",
      "WEB_PORT=3300",
      "CRLF_VALUE=keep\r",
      "TUNNEL_TOKEN=old",
      "  TUNNEL_TOKEN = old",
      "export TUNNEL_TOKEN=old",
      "MEDIARY_CONNECT_HOSTNAME=x",
      "TUNNEL_TOKEN=duplicate",
      "MEDIARY_CONNECT_HOSTNAME=also-old",
      "MY_TUNNEL_TOKEN=x",
      "#TUNNEL_TOKEN=x",
      "TUNNEL_TOKENS=x",
      "",
    ].join("\n");
    expect(rewriteEnvForTunnel(content, { token: TOKEN, hostname: HOST })).toBe(
      [
        "DOCKER_MIRROR=docker.1ms.run",
        "# keep this comment",
        "",
        "WEB_PORT=3300",
        "CRLF_VALUE=keep\r",
        "MY_TUNNEL_TOKEN=x",
        "#TUNNEL_TOKEN=x",
        "TUNNEL_TOKENS=x",
        `TUNNEL_TOKEN=${TOKEN}`,
        `MEDIARY_CONNECT_HOSTNAME=${HOST}`,
        "",
      ].join("\n"),
    );
  });

  it("keeps every line of a file that has no trailing newline", () => {
    const content = "DOCKER_MIRROR=docker.1ms.run\n# comment\n\nWEB_PORT=3300\nPLAIN=last";
    expect(rewriteEnvForTunnel(content, { token: TOKEN, hostname: HOST })).toBe(
      `DOCKER_MIRROR=docker.1ms.run\n# comment\n\nWEB_PORT=3300\nPLAIN=last\nTUNNEL_TOKEN=${TOKEN}\nMEDIARY_CONNECT_HOSTNAME=${HOST}\n`,
    );
  });
});
