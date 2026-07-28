#!/bin/sh
# Mediary Connect 接入脚本。由用户(或其 agent)在 Mediary Scout 部署机上运行:
#
#   curl -fsSL https://mediaryconnect.app/connect.sh | sh -s -- <取件码>
#   # 或指定部署目录:
#   curl -fsSL https://mediaryconnect.app/connect.sh | sh -s -- <取件码> --dir /path/to/deploy
#
# 它做「确定性的那部分」——凭码换 token、原子写 .env、带 --profile tunnel 起
# cloudflared、轮询到隧道真通才报成功。找机器/SSH/问用户由 agent 的提示词负责。
set -eu

WORKER_BASE="${MEDIARY_CONNECT_BASE:-https://mediaryconnect.app}"
CLAIM_CODE=""
DEPLOY_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
    --dir=*) DEPLOY_DIR="${1#--dir=}"; shift ;;
    -*) echo "未知参数: $1" >&2; exit 2 ;;
    *) if [ -z "$CLAIM_CODE" ]; then CLAIM_CODE="$1"; else echo "多余参数: $1" >&2; exit 2; fi; shift ;;
  esac
done

if [ -z "$CLAIM_CODE" ]; then
  echo "用法: connect.sh <取件码> [--dir 部署目录]" >&2
  exit 2
fi

# 1) 定位部署目录:--dir 指定 > 当前目录。必须含 docker-compose.yml 且有 web 服务。
if [ -n "$DEPLOY_DIR" ]; then
  cd "$DEPLOY_DIR" || { echo "❌ 进不去目录: $DEPLOY_DIR" >&2; exit 1; }
fi
COMPOSE_FILE=""
for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
  [ -f "$f" ] && COMPOSE_FILE="$f" && break
done
if [ -z "$COMPOSE_FILE" ]; then
  echo "❌ 当前目录没有 docker-compose.yml。请用 --dir 指定 Mediary Scout 部署目录。" >&2
  echo "   （当前目录: $(pwd)）" >&2
  exit 1
fi
if ! grep -qE '(^|[[:space:]])web:' "$COMPOSE_FILE"; then
  echo "❌ $COMPOSE_FILE 里找不到 web 服务——这可能不是 Mediary Scout 的部署目录。" >&2
  exit 1
fi

# 2) docker 可用性
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ 没找到 docker。请先安装 Docker / OrbStack。" >&2
  exit 1
fi

# 3) 凭码换 token(worker 现场向 CF 取)
echo "→ 用取件码换取隧道凭据…"
# 不用 -f:让 4xx 也返回响应体,以便按状态码分类报错(-f 会吞掉状态)。
# 末行追加 HTTP 状态码,再拆出来。
RESP=$(curl -sS --max-time 20 -w '\n%{http_code}' -X POST "$WORKER_BASE/api/claim/exchange" \
  -H "content-type: application/json" \
  -d "{\"code\":\"$CLAIM_CODE\"}" 2>/dev/null) || {
  echo "❌ 网络错误:连不上 $WORKER_BASE。检查这台机器能否访问外网后重试。" >&2
  exit 1
}
HTTP_CODE=$(printf '%s' "$RESP" | tail -n1)
EXCHANGE=$(printf '%s' "$RESP" | sed '$d')
case "$HTTP_CODE" in
  2*) : ;;  # 成功,继续
  403)
    echo "❌ 这个接入端点已被撤销(endpoint not active)。请回控制台确认服务仍有效,或重新选择专属地址。" >&2
    exit 1 ;;
  400)
    echo "❌ 取件码已过期(15 分钟)或无效。回控制台点「获取接入命令」重新生成一个。" >&2
    exit 1 ;;
  *)
    echo "❌ 换取失败(HTTP $HTTP_CODE)。稍后重试;持续失败请把这个状态码告诉支持。" >&2
    exit 1 ;;
esac
# 从 JSON 抠出 token 与 hostname(不引 jq,用 sed;两个字段都是简单字符串)
TUNNEL_TOKEN=$(printf '%s' "$EXCHANGE" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
HOSTNAME=$(printf '%s' "$EXCHANGE" | sed -n 's/.*"hostname"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -z "$TUNNEL_TOKEN" ] || [ -z "$HOSTNAME" ]; then
  echo "❌ 换取响应里没有 token/hostname,无法继续。" >&2
  exit 1
fi
echo "  ✓ 已获取,目标地址:https://$HOSTNAME"

# 4) 原子写入 .env(先备份,再临时文件 + mv;绝不半途留下损坏的 .env)
ENV_FILE=".env"
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"
BACKUP=".env.bak-$(date +%Y%m%d-%H%M%S)-$$"
while [ -e "$BACKUP" ]; do BACKUP="$BACKUP-1"; done
cp "$ENV_FILE" "$BACKUP"
# 备份可能含历史/旧的 TUNNEL_TOKEN(长期有效机密);若原 .env 权限较宽
# (常见 0644),cp 出的备份同样可读。显式收紧到仅属主可读写,别让 token
# 对同机其他用户泄露。(chmod 失败不致命,只告警——备份本身已完成。)
chmod 600 "$BACKUP" 2>/dev/null || echo "  ⚠️ 无法收紧备份权限,请自行检查 $BACKUP" >&2
echo "  ✓ 已备份 .env → $BACKUP"

TMP=$(mktemp ".env.tmp.XXXXXX") || { echo "❌ 无法创建临时文件" >&2; exit 1; }
# 保留除 TUNNEL_TOKEN 外的所有行,再追加新 token
grep -v '^TUNNEL_TOKEN=' "$ENV_FILE" > "$TMP" 2>/dev/null || true
printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" >> "$TMP"
mv "$TMP" "$ENV_FILE"
echo "  ✓ 已写入 TUNNEL_TOKEN"

# 5) 带 --profile tunnel 启动(这个 flag 是关键:漏了它 cloudflared 根本不起,
#    其他容器却正常,看起来「成功」实则隧道没通)。
echo "→ 启动隧道(docker compose --profile tunnel up -d)…"
if ! docker compose --profile tunnel up -d 2>&1; then
  echo "❌ docker compose 启动失败。已保留备份 $BACKUP。" >&2
  exit 1
fi

# 6) 轮询到隧道真通(/api/health 返回 ok)才算成功。最多 120 秒。
echo "→ 等待隧道就绪(最多 120 秒)…"
DEADLINE=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BODY=$(curl -fsS --max-time 8 "https://$HOSTNAME/api/health" 2>/dev/null) || BODY=""
  case "$BODY" in
    *'"status":"ok"'*|*'"status": "ok"'*)
      echo ""
      echo "✅ 完成!你的实例已可远程访问:https://$HOSTNAME"
      echo "   浏览器打开它,首次会要求设置/输入访问密码。"
      exit 0
      ;;
  esac
  sleep 5
done

echo "" >&2
echo "⚠️ 隧道已启动,但 120 秒内没能确认 https://$HOSTNAME 就绪。" >&2
echo "   常见原因:" >&2
echo "   - 镜像还在拉(慢网络)。稍等再打开 https://$HOSTNAME 试试。" >&2
echo "   - UDP 受限:在 .env 追加 TUNNEL_TRANSPORT_PROTOCOL=http2 后重跑" >&2
echo "     docker compose --profile tunnel up -d" >&2
echo "   查隧道日志:docker compose logs cloudflared --tail 30" >&2
exit 1
