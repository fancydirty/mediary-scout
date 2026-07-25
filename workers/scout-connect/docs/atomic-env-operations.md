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
cp .env "$BACKUP_FILE"
# 验证本次备份是否成功（不依赖旧备份）
if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ 备份失败，停止"
  exit 1
fi
echo "✓ 备份到 $BACKUP_FILE"
```

**第 2 步：原子化写入（不是 sed -i）**
```bash
# 保留原 .env 权限（macOS/BSD 用 %Lp，Linux 用 %a，只取权限位）
ORIG_PERMS=$(stat -f %Lp .env 2>/dev/null || stat -c %a .env 2>/dev/null || echo "644")
# 读取原 .env，保留所有非 TUNNEL_TOKEN 的行
grep -v '^TUNNEL_TOKEN=' .env > .env.new
# 追加新 token（用 printf 避免 shell 展开）
printf 'TUNNEL_TOKEN=%s\n' '新token' >> .env.new
# 继承权限
chmod "$ORIG_PERMS" .env.new 2>/dev/null || true
# 原子替换
mv .env.new .env
```

**第 3 步：立刻验证**
```bash
docker compose --profile tunnel up -d cloudflared
# 等待最多 60 秒，每 5 秒检查一次（首次拉镜像可能较慢）
MAX_WAIT=60
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  if docker compose logs cloudflared --tail 50 2>/dev/null | grep -q "Registered tunnel connection"; then
    echo "✅ Tunnel 连接成功"
    break
  fi
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "❌ 验证失败，自动回滚"
  # 第 4 步：自动回滚
  LATEST_BACKUP=$(ls -t .env.bak-* 2>/dev/null | head -1)
  if [ -z "$LATEST_BACKUP" ]; then
    echo "❌ 找不到备份文件"
    exit 1
  fi
  cp "$LATEST_BACKUP" .env
  # 必须用 stop + rm + up -d（重读 .env），down 不支持指定服务名
  docker compose stop cloudflared 2>/dev/null || true
  docker compose rm -f cloudflared 2>/dev/null || true
  docker compose --profile tunnel up -d cloudflared
  echo "✅ 已回滚，服务恢复到配置前状态"
  exit 1
fi
```

## 关键改进

1. **原子操作** — mv 是原子的，不会"写了一半"
2. **强制验证** — 写完必须检查 Registered
3. **自动回滚** — 验证失败立刻恢复
4. **用户永远有备份** — 所有 .env.bak-* 文件保留

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
