# Scout Connect 原子化 .env 操作设计

## 问题
当前 agent 直接修改 .env，风险：
1. 操作失败时用户环境被破坏
2. 没有自动回滚机制
3. 用户无法撤销

## 解决方案：原子化操作 + 自动验证 + 一键回滚

### 流程

**第 1 步：完整备份**
```bash
BACKUP_FILE=".env.bak-$(date +%Y%m%d-%H%M%S)"
# 必须检查 cp 退出码：磁盘满/IO 错误会写出截断文件，光看"文件存在"会漏
if ! cp .env "$BACKUP_FILE"; then
  echo "❌ 备份失败（cp 返回非零），停止"
  exit 1
fi
# 验证本次备份是否成功（不依赖旧备份）
if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ 备份失败，停止"
  exit 1
fi
# 比对字节数，确认不是被截断的半个文件——回滚到截断的 .env 等于毁掉配置
if [ "$(wc -c < .env)" != "$(wc -c < "$BACKUP_FILE")" ]; then
  echo "❌ 备份不完整（大小与原文件不一致），停止"
  rm -f "$BACKUP_FILE"
  exit 1
fi
echo "✓ 备份到 $BACKUP_FILE"
```

**第 2 步：原子化写入（不是 sed -i）**
```bash
# 用 cp -p 建立 .env.new，直接继承原文件权限/属主。
# 不要用 stat 解析权限位：GNU coreutils 的 -f 是"文件系统信息"，
# `stat -f %Lp` 会打印文件系统垃圾且退出码为 0，导致 `|| stat -c %a` 兜底
# 永不触发，chmod 拿到垃圾值失败后被 `|| true` 吞掉，
# 结果 600 的 .env 静默变成 644——token 对同机其他用户可读。
cp -p .env .env.new
# 读取原 .env，保留所有非 TUNNEL_TOKEN 的行（'>' 截断写入，不改动已有权限）
grep -v '^TUNNEL_TOKEN=' .env > .env.new
# 追加新 token（用 printf 避免 shell 展开）
printf 'TUNNEL_TOKEN=%s\n' '新token' >> .env.new
# 原子替换
mv .env.new .env
# 复核权限
echo "✓ .env 权限: $(ls -l .env | cut -c1-10)"
```

**第 3 步：立刻验证**
```bash
# 必须先 stop + rm -f 再 up -d：
# 1) up -d 可能复用已有容器，不会重读新的 TUNNEL_TOKEN
# 2) 旧容器的日志里已有 Registered 行，会让坏 token 假装验证通过
docker compose stop cloudflared 2>/dev/null || true
docker compose rm -f cloudflared 2>/dev/null || true
docker compose --profile tunnel up -d --force-recreate cloudflared
# 等待最多 60 秒，每 5 秒检查一次（首次拉镜像可能较慢）
# cloudflared 正常会建立 4 条连接（connIndex=0..3），健康标准是 4 条
MAX_WAIT=60
ELAPSED=0
REGISTERED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  # grep -c 无匹配时退出码为 1，用 || true 防止 set -e 提前中断
  REGISTERED=$(docker compose logs cloudflared --tail 50 2>/dev/null | grep -c "Registered tunnel connection" || true)
  if [ "$REGISTERED" -ge 4 ]; then
    echo "✅ Tunnel 连接成功（Registered ×$REGISTERED）"
    break
  fi
done

# 只有 0 条才算失败回滚：1~3 条说明 token 有效、隧道已在转发流量，
# 回滚一个能用的隧道比连接数不满更糟
if [ "$REGISTERED" -eq 0 ]; then
  echo "❌ 验证失败，自动回滚"
  # 第 4 步：自动回滚
  # 优先用本次运行创建的备份，避免并发/其他备份把 ls -t 带偏
  if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
    RESTORE_FROM="$BACKUP_FILE"
  else
    RESTORE_FROM=$(ls -t .env.bak-* 2>/dev/null | head -1)
  fi
  if [ -z "$RESTORE_FROM" ]; then
    echo "❌ 找不到备份文件"
    exit 1
  fi
  cp "$RESTORE_FROM" .env
  echo "✓ 已从 $RESTORE_FROM 恢复"
  # 必须用 stop + rm + up -d（重读 .env），down 不支持指定服务名
  docker compose stop cloudflared 2>/dev/null || true
  docker compose rm -f cloudflared 2>/dev/null || true
  docker compose --profile tunnel up -d cloudflared
  echo "✅ 已回滚，服务恢复到配置前状态"
  exit 1
fi

if [ "$REGISTERED" -lt 4 ]; then
  echo "⚠️ 只建立了 $REGISTERED/4 条连接（隧道可用但冗余不足），请报告这个数字"
fi
```

## 关键改进

1. **原子操作** — mv 是原子的，不会"写了一半"
2. **备份可信** — 检查 cp 退出码 + 字节数，杜绝回滚到截断文件
3. **权限不外泄** — 用 `cp -p` 继承权限，绝不用 `stat` 解析（GNU 的 `-f` 语义不同，
   会让含 token 的 600 文件静默变 644）
4. **强制验证** — 写完必须检查 Registered，健康标准 4 条
5. **容器强制重建** — 先 stop + rm -f 再 `up -d --force-recreate`，
   否则复用旧容器会读不到新 token，且旧日志的 Registered 行会让坏 token 假装通过
6. **自动回滚** — 验证失败立刻恢复，优先用本次运行的备份而非 `ls -t`
7. **用户永远有备份** — 所有 .env.bak-* 文件保留

## 用户体验

### 成功
```
✓ 备份 → .env.bak-20260725-105030
✓ 写入新 token
✓ 验证：Registered ×4
→ 配置成功！
```

### 失败（自动恢复）
```
✓ 备份 → .env.bak-20260725-105030
✓ 写入新 token
✗ 验证：无 Registered
→ 自动回滚
✓ 服务已恢复
```
