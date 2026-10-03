#!/bin/sh
# scout-connect 唯一部署入口。代码必须先合并到 GitHub；不要直接跑 wrangler deploy。
#
# 支付安全边界:
# - Waffo 私钥只在 Worker secret，不进入仓库。
# - /buy 只有 Waffo 配置齐全才开放按钮；webhook 缺配置一律 503，避免钱到但不发权益。
# - 这里的无扣款自检只能证明配置存在与路由切换成功；上线最终门禁仍是一笔
#   非商户本人真实付款，核对异步通知、主动查单、权益到账和退款。
set -eu

cd "$(dirname "$0")/.."
REPO_ROOT=$(git rev-parse --show-toplevel)

# 1) 禁止从脏工作区部署，保证生产 commit 可追溯。
if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then
  echo "❌ worker 目录有未提交改动。先 commit/push，再部署。" >&2
  git status --short -- . >&2
  exit 1
fi

# 2) 默认只允许部署 origin/main；显式逃生开关保留给事故恢复。
git -C "$REPO_ROOT" fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "❌ HEAD 与 origin/main 不一致，拒绝从未合并或落后的版本部署。" >&2
  echo "   HEAD:        $LOCAL" >&2
  echo "   origin/main: $REMOTE" >&2
  echo "   确需事故恢复：DEPLOY_ALLOW_DIVERGED=1 ./scripts/deploy.sh" >&2
  [ "${DEPLOY_ALLOW_DIVERGED:-}" = "1" ] || exit 1
  echo "   ⚠️ DEPLOY_ALLOW_DIVERGED=1，继续。" >&2
fi

# 3) 生产前置条件。必须在 wrangler deploy 前失败，不能先切代码再发现缺配置。
echo "→ 生产 Waffo secret 预检（只读名称，不读取值）"
SECRET_LIST=$(mktemp)
trap 'rm -f "$SECRET_LIST"' EXIT HUP INT TERM
env -u CF_API_TOKEN npx wrangler secret list --format json >"$SECRET_LIST"
for SECRET_NAME in \
  WAFFO_PRIVATE_KEY
do
  if ! grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$SECRET_NAME\"" "$SECRET_LIST"; then
    echo "❌ 缺少 Worker secret: $SECRET_NAME；尚未部署。" >&2
    exit 1
  fi
done

echo "→ wrangler Waffo 生产配置预检（只读配置名和值）"
for VAR_NAME in \
  WAFFO_MERCHANT_ID \
  WAFFO_STORE_ID \
  WAFFO_ENVIRONMENT \
  WAFFO_PRODUCT_QUARTER \
  WAFFO_PRODUCT_YEAR \
  WAFFO_PRODUCT_TWO_YEARS
do
  if ! grep -Eq "\"$VAR_NAME\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" wrangler.jsonc; then
    echo "❌ wrangler.jsonc 缺少 Waffo var: $VAR_NAME；尚未部署。" >&2
    exit 1
  fi
done
if ! grep -Eq '"WAFFO_ENVIRONMENT"[[:space:]]*:[[:space:]]*"prod"' wrangler.jsonc; then
  echo "❌ wrangler.jsonc 必须将 WAFFO_ENVIRONMENT 固定为 prod；尚未部署。" >&2
  exit 1
fi

echo "→ 生产 D1 Waffo schema 预检（只读）"
if ! env -u CF_API_TOKEN npx wrangler d1 execute scout-connect --remote \
  --command "SELECT waffo_session_id, waffo_order_id FROM payment_orders LIMIT 0; SELECT payment_provider, payment_transaction_id, refunded_at FROM entitlements LIMIT 0;" \
  >/dev/null; then
  echo "❌ 生产 D1 尚未应用 0007-waffo-payment-orders.sql；尚未部署。" >&2
  exit 1
fi

echo "→ production D1 instance-link schema preflight (read-only)"
if ! env -u CF_API_TOKEN npx wrangler d1 execute scout-connect --remote \
  --command "SELECT id, poll_secret_sha256 FROM instance_link_requests LIMIT 0; SELECT id, credential_sha256 FROM instance_credentials LIMIT 0;" \
  >/dev/null; then
  echo "❌ 生产 D1 尚未应用 0008-instance-links.sql；请先应用 0008，再部署。" >&2
  exit 1
fi

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
if ! ALIPAY_OPEN_RESULT=$(env -u CF_API_TOKEN npx wrangler d1 execute scout-connect --remote --json \
  --command "SELECT COUNT(*) AS count FROM payment_orders WHERE provider = 'alipay' AND (status = 'paid' OR (status IN ('created','form_issued','pending') AND expires_at > '$NOW_ISO'));"); then
  echo "❌ 无法查询未完结的支付宝订单，停止部署。" >&2
  exit 1
fi
if ! ALIPAY_OPEN_COUNT=$(printf '%s' "$ALIPAY_OPEN_RESULT" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const findCount = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = findCount(item);
        if (result !== null) return result;
      }
    } else if (value !== null && typeof value === "object") {
      if (typeof value.count === "number" || typeof value.count === "string") return Number(value.count);
      for (const item of Object.values(value)) {
        const result = findCount(item);
        if (result !== null) return result;
      }
    }
    return null;
  };
  try {
    const count = findCount(JSON.parse(input));
    if (count === null || !Number.isInteger(count) || count < 0) process.exit(2);
    process.stdout.write(String(count));
  } catch {
    process.exit(2);
  }
});
'); then
  echo "❌ 无法解析未完结的支付宝订单数量，停止部署。" >&2
  exit 1
fi
echo "→ Alipay payable-order cutover guard: $ALIPAY_OPEN_COUNT"
if [ "$ALIPAY_OPEN_COUNT" -gt 0 ]; then
  echo "❌ 仍有 $ALIPAY_OPEN_COUNT 个支付宝订单没完结（未过期可支付，或已付款未开通）；本次发布移除了支付宝 notify/query 路由，先等可支付订单过期、把已付款的开通完再部署。" >&2
  exit 1
fi

# 4) 本地门禁。
echo "→ typecheck"
npx tsc -p tsconfig.json --noEmit
echo "→ tests"
(cd "$REPO_ROOT" && npx vitest run workers/scout-connect/ --silent)

echo "→ wrangler deploy"
env -u CF_API_TOKEN npx wrangler deploy "$@"

# 5) 不发起交易的生产自检。
echo "→ 部署后 Waffo 自检（不创建订单、不扣款）"
sleep 3
BUY=$(curl -fsS https://mediaryconnect.app/buy 2>/dev/null || echo "")
if ! printf '%s' "$BUY" | grep -q "微信支付"; then
  echo "❌ 线上 /buy 不是微信支付购买页，部署未生效或页面异常。" >&2
  exit 1
fi
# 只有配置齐全时页面才带结账脚本；不能 grep「结账暂未开放」——开放页脚本的 503 分支里也有这句。
if ! printf '%s' "$BUY" | grep -qF 'fetch("/api/checkout"'; then
  echo "❌ Waffo 结账未开放（/buy 没有结账脚本）。检查 WAFFO_PRIVATE_KEY 与 wrangler.jsonc 中的 Waffo vars。" >&2
  exit 1
fi
WEBHOOK=$(curl -s -o /dev/null -w "%{http_code}" -X POST   https://mediaryconnect.app/api/waffo/webhook   -H "content-type: application/json" -d '')
if [ "$WEBHOOK" != "401" ]; then
  echo "❌ Waffo webhook 空请求应 fail-closed 为 401，实际 HTTP $WEBHOOK。" >&2
  echo "   若为 503，通常是 WAFFO_PRIVATE_KEY 未完整配置。" >&2
  exit 1
fi

echo "✅ 部署完成：微信支付页面开放，Waffo webhook 正确 fail-closed。"
echo "   尚未证明真实收款闭环：生产环境仍需由非商户本人完成真实付款并做一次全额退款。"
