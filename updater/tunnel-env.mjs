import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MANAGED = /^[\t ]*(export[\t ]+)?(TUNNEL_TOKEN|MEDIARY_CONNECT_HOSTNAME)[\t ]*=/;
const TOKEN_LINE = /^[\t ]*(export[\t ]+)?TUNNEL_TOKEN[\t ]*=/;
const HOST_LINE = /^[\t ]*(export[\t ]+)?MEDIARY_CONNECT_HOSTNAME[\t ]*=/;

function splitEnvLines(content) {
  if (content.length === 0) return [];
  return content.replace(/\n$/, "").split("\n");
}

export function rewriteEnvForTunnel(content, { token, hostname }) {
  const kept = splitEnvLines(content).filter((line) => !MANAGED.test(line));
  return [...kept, `TUNNEL_TOKEN=${token}`, `MEDIARY_CONNECT_HOSTNAME=${hostname}`].join("\n") + "\n";
}

function fsFrom(deps) {
  return {
    existsSync: deps.existsSync ?? existsSync,
    statSync: deps.statSync ?? statSync,
    readFileSync: deps.readFileSync ?? readFileSync,
    writeFileSync: deps.writeFileSync ?? writeFileSync,
    chmodSync: deps.chmodSync ?? chmodSync,
    chownSync: deps.chownSync ?? chownSync,
    renameSync: deps.renameSync ?? renameSync,
    unlinkSync: deps.unlinkSync ?? unlinkSync,
  };
}

function stampUtc(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function removeTemp(fs, path) {
  try {
    fs.unlinkSync(path);
  } catch {
    // The write may have failed before the temp file existed.
  }
}

function assertRewritten(oldContent, nextContent) {
  const oldKept = splitEnvLines(oldContent).filter((line) => !MANAGED.test(line));
  const nextLines = splitEnvLines(nextContent);
  const nextKept = nextLines.filter((line) => !MANAGED.test(line));
  const same =
    oldKept.length === nextKept.length && oldKept.every((line, index) => line === nextKept[index]);
  if (!same) throw new Error("新的 .env 丢了原来的配置行");
  if (nextLines.filter((line) => TOKEN_LINE.test(line)).length !== 1) {
    throw new Error("新的 .env 里的隧道配置行数不对");
  }
  if (nextLines.filter((line) => HOST_LINE.test(line)).length !== 1) {
    throw new Error("新的 .env 里的隧道配置行数不对");
  }
}

function installEnv(fs, repoDir, oldContent, { token, hostname, mode, uid, gid }) {
  const next = rewriteEnvForTunnel(oldContent, { token, hostname });
  const tmp = join(repoDir, `.env.tmp-tunnel-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(tmp, next, { mode });
    fs.chmodSync(tmp, mode);
    fs.chownSync(tmp, uid, gid);
    assertRewritten(oldContent, fs.readFileSync(tmp, "utf8"));
    fs.renameSync(tmp, join(repoDir, ".env"));
  } catch (error) {
    removeTemp(fs, tmp);
    throw error;
  }
}

export function writeTunnelEnv(repoDir, { token, hostname }, deps = {}) {
  const fs = fsFrom(deps);
  const now = deps.now ?? (() => new Date());
  const pid = deps.pid ?? process.pid;
  const envPath = join(repoDir, ".env");

  if (!fs.existsSync(envPath)) {
    const dir = fs.statSync(repoDir);
    installEnv(fs, repoDir, "", { token, hostname, mode: 0o600, uid: dir.uid, gid: dir.gid });
    return { backup: null };
  }

  const previous = fs.readFileSync(envPath);
  const oldContent = Buffer.isBuffer(previous) ? previous.toString("utf8") : String(previous);
  const stat = fs.statSync(envPath);
  let backup = join(repoDir, `.env.bak-tunnel-${stampUtc(now())}-${pid}`);
  while (fs.existsSync(backup)) backup += "-1";
  // Written from the bytes already read, created 0600 and exclusively: a copy would carry the
  // .env's own (often 0644) mode until a later chmod, and the backup holds the old credentials.
  fs.writeFileSync(backup, previous, { mode: 0o600, flag: "wx" });
  fs.chownSync(backup, stat.uid, stat.gid);
  installEnv(fs, repoDir, oldContent, {
    token,
    hostname,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  });
  return { backup };
}

/** Undo writeTunnelEnv after the tunnel failed to start, so a later web restart does not read
 *  a token for a tunnel that never came up. backup = what writeTunnelEnv returned: put those
 *  bytes back (atomically, with the current .env's mode and owner), or, when it created .env
 *  itself (null), remove it. */
export function restoreTunnelEnv(repoDir, backup, deps = {}) {
  const fs = fsFrom(deps);
  const envPath = join(repoDir, ".env");
  if (backup === null) {
    fs.unlinkSync(envPath);
    return;
  }
  const current = fs.statSync(envPath);
  const tmp = join(repoDir, `.env.tmp-tunnel-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(tmp, fs.readFileSync(backup), { mode: current.mode & 0o777 });
    fs.chmodSync(tmp, current.mode & 0o777);
    fs.chownSync(tmp, current.uid, current.gid);
    fs.renameSync(tmp, envPath);
  } catch (error) {
    removeTemp(fs, tmp);
    throw error;
  }
}
