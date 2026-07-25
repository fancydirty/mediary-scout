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
cp .env .env.bak-$(date +%Y%m%d-%H%M%S)
ls -lh .env.bak-* | tail -1  # 确认备份成功
```

**第 2 步：原子化写入（不是 sed -i）**
```bash
# 读取原 .env，保留所有非 TUNNEL_TOKEN 的行
grep -v '^TUNNEL_TOKEN=' .env > .env.new
# 追加新 token
echo "TUNNEL_TOKEN=新token" >> .env.new
# 原子替换
mv .env.new .env
```

**第 3 步：立刻验证**
```bash
docker compose restart cloudflared
sleep 15
if docker compose logs cloudflared --tail 20 | grep -q "Registered tunnel connection"; then
  echo "✅ Tunnel 连接成功"
else
  echo "❌ 验证失败，自动回滚"
  # 第 4 步：自动回滚
  LATEST_BACKUP=$(ls -t .env.bak-* | head -1)
  cp $LATEST_BACKUP .env
  docker compose restart cloudflared
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
