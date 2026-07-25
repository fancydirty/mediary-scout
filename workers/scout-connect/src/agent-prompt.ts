export function buildAgentPrompt(input: {
  hostname: string;
  tunnelToken: string;
}): string {
  return `你是在帮用户配置 Mediary Scout 的「Scout Connect」远程访问。

目标:让用户的自托管实例经 Cloudflare Tunnel 发布到:
  https://${input.hostname}
门禁是 Cloudflare Access 邮箱 OTP(浏览器打开时先要求邮箱验证码,通过后才进应用)。
不要修改获取/网盘/LLM 业务逻辑。

安全红线:
- TUNNEL_TOKEN 是机密。不提交 git、不写进文档/截图/issue、不打印日志,只写入实例 .env。
- 全程在你正在操作的这台机器的部署目录里执行;不要碰任何 git 源码克隆(那是源码,不是部署)。

第 0 步·环境门(先做,不过就停):
1. 执行 \`docker info\` — 若报 command not found / permission denied,提示用户(需装 Docker/加 sudo/OrbStack),停止。
2. 执行 \`docker compose ls\` — 找到 Config file 路径指向 mediary-scout 部署目录的那个 project。
3. \`cd\` 到该目录,确认 docker-compose.yml 里有名为 web 的服务。若无,停止并向用户确认目录。

第 1 步·写凭证(原子化操作 + 自动回滚):
⚠️ 1a. 强制备份(不可跳过):
  \`\`\`bash
  BACKUP_FILE=".env.bak-$(date +%Y%m%d-%H%M%S)"
  cp .env "$BACKUP_FILE"
  # 验证本次备份是否成功（不依赖旧备份）
  if [ ! -f "$BACKUP_FILE" ]; then
    echo "❌ 备份失败，停止"
    exit 1
  fi
  echo "✓ 备份到 $BACKUP_FILE"
  \`\`\`

⚠️ 1b. 原子化写入(不用 sed -i):
  \`\`\`bash
  # 保留原 .env 权限（macOS/BSD 用 %Lp，Linux 用 %a，只取权限位）
  ORIG_PERMS=$(stat -f %Lp .env 2>/dev/null || stat -c %a .env 2>/dev/null || echo "644")
  # 保留所有非 TUNNEL_TOKEN 的行
  grep -v '^TUNNEL_TOKEN=' .env > .env.new
  # 追加新 token（用 printf 避免 shell 展开）
  printf 'TUNNEL_TOKEN=%s\\n' '${input.tunnelToken}' >> .env.new
  # 继承权限
  chmod "$ORIG_PERMS" .env.new 2>/dev/null || true
  # 原子替换
  mv .env.new .env
  \`\`\`

⚠️ 1c. 立刻验证 + 失败自动回滚:
  \`\`\`bash
  docker compose --profile tunnel up -d cloudflared
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
    echo "❌ 验证失败,自动回滚到备份"
    LATEST_BACKUP=$(ls -t .env.bak-* 2>/dev/null | head -1)
    if [ -z "$LATEST_BACKUP" ]; then
      echo "❌ 找不到备份文件"
      exit 1
    fi
    cp "$LATEST_BACKUP" .env
    # 关键：必须用 stop + rm + up -d（重读 .env），down 不支持指定服务名
    docker compose stop cloudflared 2>/dev/null || true
    docker compose rm -f cloudflared 2>/dev/null || true
    docker compose --profile tunnel up -d cloudflared
    echo "✅ 已回滚,你的服务恢复到配置前状态"
    exit 1
  fi
  
  if [ "$REGISTERED" -lt 4 ]; then
    echo "⚠️ 只建立了 $REGISTERED/4 条连接（隧道可用但冗余不足），请报告这个数字"
  fi
  \`\`\`

⚠️ 1d. git 忽略检查:
  \`\`\`bash
  if [ -d .git ] && ! git check-ignore -q .env 2>/dev/null; then
    echo ".env" >> .git/info/exclude
  fi
  \`\`\`

❌ 绝对禁止:
- 禁止 \`sed -i\` 或 \`echo >\` 直接覆盖 .env
- 禁止跳过验证步骤
- 禁止在没确认备份的情况下修改

第 2 步(可选)·UDP 受限: 先跳过,第 4 步失败时再回来加。

第 3 步·启动:
- 在部署目录执行 \`docker compose --profile tunnel up -d\`
- 注意:首次运行会拉取 cloudflared 镜像(几十 MB,慢网络可能几分钟),这是正常的。
- 若拉取镜像失败(报 failed to fetch / EOF / not found 一类):
  重试 \`docker compose --profile tunnel pull\` 1-2 次;仍失败则提示用户网络/镜像源问题
  (国内网络常见,可配置 Docker 镜像加速后重试),不要反复瞎试。

第 4 步·确认连通(关键,别急着判失败):
1. 先 \`docker compose ps cloudflared\` — 应显示 Up。若是 Created/Starting/空,等 30 秒再看,不要判失败。
2. 再 \`docker compose logs cloudflared --tail 30\` — 看到 "Registered tunnel connection"(通常 connIndex=0..3 共 4 条)即成功。
3. 若 1 分钟后仍无 Registered:
   a. 确认 token 是完整一行(没被换行/截断/带了多余字符);
   b. 确认在正确目录、compose 服务名是 web、cloudflared 与 web 在同一 docker 网络;
   c. 确认出站 7844 端口没被防火墙拦;
   d. 回到第 2 步,在 .env 追加 TUNNEL_TRANSPORT_PROTOCOL=http2,然后重新执行
      \`docker compose --profile tunnel up -d\`(不是 restart——restart 不会重读 .env),再看日志。

第 5 步·验证门禁(由人来完成,不是 agent):
- 请用户在自己的设备浏览器打开 https://${input.hostname}
- 应先到 Cloudflare Access 邮箱验证页(输入受邀邮箱收验证码;若没收到,查垃圾邮件)
- 通过后进入 Mediary Scout 面板
- 你(agent)不要自行声称验证结果;让用户告诉你看到了什么。
- 若用户直接看到应用而无 Access 页,立刻停止并提示(门禁没生效,需作者检查)。

第 6 步·收尾(告诉用户):
- https://${input.hostname} 现在可从任何设备访问;token 页面只显示一次,但 token 本身长期有效,重启容器/宿主不影响。
- 以后若无法访问,先 \`docker compose logs cloudflared --tail 30\` 看隧道是否还活着。

完成后用简短中文汇报三项:隧道是否 Registered、Access 验证页是否(由用户确认)出现、能否进入面板。
若卡在某步,说明卡在哪、日志关键行、你的下一步建议。
`;
}
