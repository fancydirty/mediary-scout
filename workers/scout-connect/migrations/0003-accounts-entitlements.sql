-- P3: accounts + entitlements + magic link 登录态
-- 从"邀请制手工开通"升级为"自助付费开通"

-- 账号表:邮箱即身份
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                  -- act_<nanoid>
  email TEXT NOT NULL UNIQUE,           -- 小写;唯一标识
  paddle_customer_id TEXT,              -- ctm_...(可空:内测期手工开的没有)
  created_at TEXT NOT NULL,             -- ISO 8601 UTC
  last_login_at TEXT                    -- 最近一次魔法链接登入
);
-- accounts.email 已由 UNIQUE 约束自动建索引,不再重复建。
CREATE INDEX idx_accounts_paddle_customer ON accounts(paddle_customer_id);

-- 预付时长账本:每次充值一行,expires_at 叠加
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,                  -- ent_<nanoid>
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL,             -- 到期时刻(UTC ISO)
  source TEXT NOT NULL,                 -- paddle | founding | manual | beta
  paddle_transaction_id TEXT,           -- txn_...(幂等键,UNIQUE when not null)
  months INTEGER NOT NULL,              -- 本次充值月数
  created_at TEXT NOT NULL
);
CREATE INDEX idx_entitlements_account ON entitlements(account_id);
CREATE UNIQUE INDEX idx_ent_txn ON entitlements(paddle_transaction_id)
  WHERE paddle_transaction_id IS NOT NULL;

-- endpoints 新增 account_id,关联 accounts
ALTER TABLE endpoints ADD COLUMN account_id TEXT REFERENCES accounts(id);
CREATE INDEX idx_endpoints_account ON endpoints(account_id);

-- endpoints 新增停用/清除时间戳(决策 #14:7 天宽限 → 停用 → 180 天删 CF 资源)
ALTER TABLE endpoints ADD COLUMN grace_until TEXT;    -- 宽限截止
ALTER TABLE endpoints ADD COLUMN suspended_at TEXT;   -- 停用时刻(DNS 已删)
ALTER TABLE endpoints ADD COLUMN purge_after TEXT;    -- 180 天后删 CF 资源
