import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync as writeBytes } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreTunnelEnv, rewriteEnvForTunnel, writeTunnelEnv } from "./tunnel-env.mjs";

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

const repos = [];

afterEach(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  repos.length = 0;
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tunnel-env-"));
  repos.push(dir);
  return dir;
}

describe("writeTunnelEnv", () => {
  it("creates a missing .env as mode 0600 and chowns it to the deploy directory", () => {
    const dir = makeRepo();
    const owner = statSync(dir);
    const chowns = [];
    const result = writeTunnelEnv(dir, { token: TOKEN, hostname: HOST }, {
      now: () => new Date("2026-10-03T04:05:06.000Z"),
      pid: 99,
      chownSync(path, uid, gid) {
        chowns.push({ path, uid, gid });
      },
    });
    expect(result).toEqual({ backup: null });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      `TUNNEL_TOKEN=${TOKEN}\nMEDIARY_CONNECT_HOSTNAME=${HOST}\n`,
    );
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(chowns).toEqual([{ path: expect.any(String), uid: owner.uid, gid: owner.gid }]);
    expect(chowns[0].path.startsWith(dir)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith(".env.tmp"))).toEqual([]);
  });

  it("backs up the old bytes, keeps the original mode, and chowns backup and temp to the .env owner", () => {
    const dir = makeRepo();
    const envPath = join(dir, ".env");
    const old = "DOCKER_MIRROR=docker.1ms.run\n# keep\n\nWEB_PORT=3300\nTUNNEL_TOKEN=old\n  TUNNEL_TOKEN = spaced\n";
    writeBytes(envPath, old);
    chmodSync(envPath, 0o640);
    const owner = statSync(envPath);
    const chowns = [];
    const result = writeTunnelEnv(dir, { token: TOKEN, hostname: HOST }, {
      now: () => new Date("2026-10-03T04:05:06.000Z"),
      pid: 99,
      chownSync(path, uid, gid) {
        chowns.push({ path, uid, gid });
      },
    });
    const backup = join(dir, ".env.bak-tunnel-20261003-040506-99");
    expect(result).toEqual({ backup });
    expect(readFileSync(backup).equals(Buffer.from(old))).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(envPath).mode & 0o777).toBe(0o640);
    expect(readFileSync(envPath, "utf8")).toBe(
      `DOCKER_MIRROR=docker.1ms.run\n# keep\n\nWEB_PORT=3300\nTUNNEL_TOKEN=${TOKEN}\nMEDIARY_CONNECT_HOSTNAME=${HOST}\n`,
    );
    expect(chowns.map(({ uid, gid }) => ({ uid, gid }))).toEqual([
      { uid: owner.uid, gid: owner.gid },
      { uid: owner.uid, gid: owner.gid },
    ]);
    expect(chowns[0].path).toBe(backup);
    expect(chowns[1].path.startsWith(dir)).toBe(true);
    expect(chowns[1].path).not.toBe(envPath);
  });

  it("leaves .env byte-for-byte untouched and removes the temp file when writing it fails", () => {
    const dir = makeRepo();
    const envPath = join(dir, ".env");
    const old = Buffer.from("KEEP=1\nTUNNEL_TOKEN=old\n# comment\n");
    writeBytes(envPath, old);
    chmodSync(envPath, 0o640);
    expect(() =>
      writeTunnelEnv(dir, { token: TOKEN, hostname: HOST }, {
        now: () => new Date("2026-10-03T04:05:06.000Z"),
        pid: 99,
        chownSync() {},
        writeFileSync(path) {
          writeBytes(path, Buffer.from("partial"));
          throw new Error("simulated write failure");
        },
      }),
    ).toThrow(/simulated write failure/);
    expect(readFileSync(envPath).equals(old)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).filter((name) => name.startsWith(".env.tmp"))).toEqual([]);
  });

  it("does not replace .env when the temp file drops a kept line", () => {
    const dir = makeRepo();
    const envPath = join(dir, ".env");
    const old = "KEEP=1\nWEB_PORT=3300\n";
    writeBytes(envPath, old);
    expect(() =>
      writeTunnelEnv(dir, { token: TOKEN, hostname: HOST }, {
        now: () => new Date("2026-10-03T04:05:06.000Z"),
        pid: 7,
        chownSync() {},
        writeFileSync(path) {
          writeBytes(path, `TUNNEL_TOKEN=${TOKEN}\nMEDIARY_CONNECT_HOSTNAME=${HOST}\n`);
        },
      }),
    ).toThrow(/配置行/);
    expect(readFileSync(envPath, "utf8")).toBe(old);
    expect(readdirSync(dir).filter((name) => name.startsWith(".env.tmp"))).toEqual([]);
  });
});

describe("restoreTunnelEnv", () => {
  it("puts the backed-up bytes back with the current .env's mode when the tunnel did not start", () => {
    const dir = makeRepo();
    const envPath = join(dir, ".env");
    const old = "DOCKER_MIRROR=docker.1ms.run\nWEB_PORT=3300\n";
    writeBytes(envPath, old);
    chmodSync(envPath, 0o640);
    const { backup } = writeTunnelEnv(dir, { token: TOKEN, hostname: HOST }, { chownSync() {} });
    restoreTunnelEnv(dir, backup, { chownSync() {} });
    expect(readFileSync(envPath, "utf8")).toBe(old);
    expect(statSync(envPath).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).filter((name) => name.startsWith(".env.tmp"))).toEqual([]);
  });

  it("removes a .env it created itself", () => {
    const dir = makeRepo();
    const { backup } = writeTunnelEnv(dir, { token: TOKEN, hostname: HOST }, { chownSync() {} });
    expect(backup).toBeNull();
    restoreTunnelEnv(dir, backup, { chownSync() {} });
    expect(readdirSync(dir).includes(".env")).toBe(false);
  });
});
