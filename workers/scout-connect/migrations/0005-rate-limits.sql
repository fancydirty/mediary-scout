-- Migration 0005 — 跨实例限流表(替换内存限流)
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the Worker version that reads rate_limits.
-- 表不存在时限流查询会抛错;发信路由把限流失败当「放行」处理(fail open,
-- 见 routes.ts 的理由),所以漏跑本迁移不会 500,但限流等于没有。
--
-- 为什么需要:原限流器是**内存**滑动窗口,而 Worker 每次请求可能落在不同的
-- 隔离实例上,各有一份计数。生产实测:同一邮箱连打 5 次得到
-- `429 202 429 202 202` —— 代码逻辑正确,拦不拦全看请求落到哪个实例,
-- 实际拦截率约 40%。发信入口(/api/auth/magic、/waitlist)是公开的
-- 「触发发邮件」放大面,需要真正跨实例的一致计数。
--
-- How to run:
--   cd workers/scout-connect
--   npx wrangler d1 execute scout-connect --local \
--     --file=./migrations/0005-rate-limits.sql
--   npx wrangler d1 execute scout-connect --remote \
--     --file=./migrations/0005-rate-limits.sql
--   # then, and only then:
--   npx wrangler deploy
--
-- (If CF_API_TOKEN is exported in your shell, prefix with `env -u CF_API_TOKEN`.)
--
-- On transactions: NO explicit transaction statements — D1 rejects them, and
-- `wrangler d1 execute --file` already applies the file as one atomic unit.
--
-- On re-running: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS make
-- this file idempotent — a second run is a no-op, not an error.

-- 一行 = 一次被计数的请求。按 (bucket, key) 分组,按 at 做滑动窗口。
--   bucket: 限流用途,如 'signup_ip' / 'signup_email'。不同用途各自计数。
--   key:    该用途下的标识(IP 或邮箱)。**不建唯一约束** —— 同一 key 在窗口内
--           本就该有多行(每次请求一行),唯一约束会让第二次请求直接失败。
CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  -- RFC3339 UTC。用文本而非 epoch:与本库其它时间列(created_at/expires_at)
  -- 一致,且 D1 的字符串比较对 RFC3339 是正确的时序比较。
  at TEXT NOT NULL
);

-- 计数查询的形状是 WHERE bucket=? AND key=? AND at>?,三列全覆盖。
-- at 放最后:前两列是等值匹配,范围条件必须在复合索引末尾才用得上。
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON rate_limits (bucket, key, at);

-- 清理用:按时间扫全表(不分 bucket/key)。没有这条索引,过期清理会全表扫描。
CREATE INDEX IF NOT EXISTS idx_rate_limits_at
  ON rate_limits (at);
