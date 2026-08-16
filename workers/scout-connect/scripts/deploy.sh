#!/bin/sh
# scout-connect 唯一部署入口。代码必须先合并到 GitHub；不要直接跑 wrangler deploy。
#
# 支付安全边界:
# - 支付宝四项凭证全部在 Worker secrets，不进入仓库。
# - /buy 只有四项齐全才开放按钮；notify 缺配置一律 503，避免钱到但不发权益。
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
echo "→ 生产支付宝 secrets 预检（只读名称，不读取值）"
SECRET_LIST=$(mktemp)
trap 'rm -f "$SECRET_LIST"' EXIT HUP INT TERM
env -u CF_API_TOKEN npx wrangler secret list --format json >"$SECRET_LIST"
for SECRET_NAME in \
  ALIPAY_APP_ID \
  ALIPAY_PRIVATE_KEY \
  ALIPAY_ALIPAY_PUBLIC_KEY \
  ALIPAY_SELLER_ID
do
  if ! grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$SECRET_NAME\"" "$SECRET_LIST"; then
    echo "❌ 缺少 Worker secret: $SECRET_NAME；尚未部署。" >&2
    exit 1
  fi
done

echo "→ 生产 D1 支付 schema 预检（只读）"
if ! env -u CF_API_TOKEN npx wrangler d1 execute scout-connect --remote \
  --command "SELECT refund_request_no, last_queried_at FROM payment_orders LIMIT 0; SELECT payment_provider, payment_transaction_id, refunded_at FROM entitlements LIMIT 0;" \
  >/dev/null; then
  echo "❌ 生产 D1 尚未完整应用 0006-alipay-payment-orders.sql；尚未部署。" >&2
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
echo "→ 部署后支付宝自检（不创建订单、不扣款）"
sleep 3
BUY=$(curl -fsS https://mediaryconnect.app/buy 2>/dev/null || echo "")
if ! printf '%s' "$BUY" | grep -q "支付宝支付"; then
  echo "❌ 线上 /buy 不是支付宝购买页，部署未生效或页面异常。" >&2
  exit 1
fi
if printf '%s' "$BUY" | grep -q "支付宝结账暂未开放"; then
  echo "❌ 支付宝结账未开放。检查 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY /" >&2
  echo "   ALIPAY_ALIPAY_PUBLIC_KEY / ALIPAY_SELLER_ID 四项 Worker secrets。" >&2
  exit 1
fi
NOTIFY=$(curl -s -o /dev/null -w "%{http_code}" -X POST   https://mediaryconnect.app/api/alipay/notify   -H "content-type: application/x-www-form-urlencoded" -d '')
if [ "$NOTIFY" != "400" ]; then
  echo "❌ 支付宝 notify 空请求应 fail-closed 为 400，实际 HTTP $NOTIFY。" >&2
  echo "   若为 503，通常是四项支付宝 secrets 未完整配置。" >&2
  exit 1
fi

echo "✅ 部署完成：支付宝页面开放，notify 正确 fail-closed。"
echo "   尚未证明真实收款闭环：必须再做一笔非商户本人真实付款与全额退款。"
