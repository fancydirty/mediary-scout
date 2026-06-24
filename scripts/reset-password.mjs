// Owner escape hatch: reset ANY account's password (incl. the owner) from the box
// itself — for when someone (or the owner) forgets and no admin can reach the panel.
//   docker compose exec web node scripts/reset-password.mjs <username> [newPassword]
// No password arg → a random one is generated and printed. Revokes the account's
// sessions so the old (forgotten) cookie can't linger.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadDotEnv } from "./_lib/pan115-cookie.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();

const conn =
  process.env.MEDIA_TRACK_POSTGRES_URL ?? "postgresql://mediatrack:mediatrack@localhost:5432/media_track";
const mod = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const repo = mod.createPostgresWorkflowRepositorySync({ connectionString: conn });

const username = process.argv[2];
if (!username) {
  console.error("用法: node scripts/reset-password.mjs <username> [newPassword]");
  process.exit(1);
}
const newPassword = process.argv[3] ?? randomBytes(6).toString("base64url");

const acct = await repo.getAccountByUsername(username);
if (!acct) {
  console.error(`找不到账号: ${username}`);
  process.exit(1);
}
await repo.setAccountPassword(acct.id, await mod.hashPassword(newPassword));
await repo.deleteSessionsForAccount(acct.id);
console.log(`已重置账号「${username}」的密码为: ${newPassword}`);
console.log("请用该密码登录后到「设置 → 修改密码」改成你自己的。");
process.exit(0);
