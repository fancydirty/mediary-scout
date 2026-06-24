// Owner escape hatch: reset ANY account's password (incl. the owner) from the box
// itself — for when someone (or the owner) forgets and no admin can reach the panel.
//   docker compose exec web node scripts/reset-password.mjs <username> [newPassword]
// No password arg → a random one is generated and printed. Revokes the account's
// sessions so the old (forgotten) cookie can't linger.
//
// SELF-CONTAINED ON PURPOSE: the Next `output: standalone` runner bundles
// @media-track/workflow into .next (NOT resolvable as a module) and ships no
// packages/workflow/dist — so this script must NOT import the workflow package. It
// uses `pg` (traced into the standalone node_modules) + raw SQL, and replicates the
// scrypt hash format from packages/workflow/src/auth/password.ts EXACTLY:
//   stored = `scrypt:<saltHex(16B)>:<keyHex(64B)>`. If that KDF ever changes, update
// this script too.
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import pg from "pg";

const scrypt = promisify(scryptCb);

async function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

/** In the container MEDIA_TRACK_POSTGRES_URL is already in the env (docker compose).
 *  For a dev shell, best-effort read it from ./.env so `node scripts/...` just works. */
function resolveConnectionString() {
  if (process.env.MEDIA_TRACK_POSTGRES_URL?.trim()) return process.env.MEDIA_TRACK_POSTGRES_URL.trim();
  try {
    const line = readFileSync(".env", "utf8")
      .split("\n")
      .find((l) => l.startsWith("MEDIA_TRACK_POSTGRES_URL="));
    if (line) return line.slice("MEDIA_TRACK_POSTGRES_URL=".length).trim().replace(/^["']|["']$/g, "");
  } catch {
    /* no .env — fall through */
  }
  return null;
}

const username = process.argv[2];
if (!username) {
  console.error("用法: node scripts/reset-password.mjs <username> [newPassword]");
  process.exit(1);
}
const newPassword = process.argv[3] ?? randomBytes(6).toString("base64url");

const connectionString = resolveConnectionString();
if (!connectionString) {
  console.error("缺少 MEDIA_TRACK_POSTGRES_URL(容器内应已注入;dev 请在 .env 或环境变量里设)。");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
// Derive the exit code inside try, exit AFTER finally — calling process.exit() in the
// try block would skip finally and leak the pg connection.
let exitCode = 0;
try {
  const found = await client.query("SELECT id FROM accounts WHERE username = $1", [username]);
  const account = found.rows[0];
  if (!account) {
    console.error(`找不到账号: ${username}`);
    exitCode = 1;
  } else {
    const hash = await hashPassword(newPassword);
    // Atomic: rotate the hash AND revoke sessions together, so a failed DELETE can't
    // leave the password changed while old session cookies still work.
    await client.query("BEGIN");
    try {
      await client.query("UPDATE accounts SET password_hash = $1 WHERE id = $2", [hash, account.id]);
      await client.query("DELETE FROM sessions WHERE account_id = $1", [account.id]);
      await client.query("COMMIT");
    } catch (txError) {
      await client.query("ROLLBACK");
      throw txError;
    }
    console.log(`已重置账号「${username}」的密码为: ${newPassword}`);
    console.log("请用该密码登录后到「设置 → 修改密码」改成你自己的。");
  }
} catch (err) {
  // 42P01 = undefined_table: schema not initialized yet (web never started once).
  if (err && typeof err === "object" && err.code === "42P01") {
    console.error("数据库尚未初始化(accounts 表不存在)。请先启动一次 web 服务完成 schema 初始化,再跑本脚本。");
    exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await client.end();
}
process.exit(exitCode);
