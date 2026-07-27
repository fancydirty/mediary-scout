const TOKEN_HEREDOC_MARKER = "MEDIARY_TUNNEL_TOKEN_EOF";

/**
 * True when the token can be embedded in the generated shell script safely
 * AND would produce a valid single-line .env entry.
 *
 * A quoted heredoc treats its body literally, so quotes/backslashes/newlines
 * cannot inject commands. The two real problems are:
 *  - a line equal to the marker, which would end the heredoc early
 *  - newlines, which are safe but would write a second, malformed .env line
 */
export function canEmbedTunnelToken(token: string): boolean {
  if (token.includes("\n") || token.includes("\r")) return false;
  if (token.includes(TOKEN_HEREDOC_MARKER)) return false;
  return true;
}

export function buildAgentPrompt(input: {
  hostname: string;
  tunnelToken: string;
}): string {
  // The token is interpolated into a shell script that the invitee's agent
  // runs on their machine. Embedding it as '<token>' was a command injection:
  // a single quote closed the quoting and the rest executed as shell.
  // It now travels inside a QUOTED heredoc (fully literal, no expansion).
  if (!canEmbedTunnelToken(input.tunnelToken)) {
    // Never throw on the reveal path -- that would deny the user their token.
    // Callers use canEmbedTunnelToken() to fall back to manual instructions.
    throw new Error("tunnelToken cannot be embedded; check canEmbedTunnelToken");
  }
  // The hostname lands in URLs and shell text; it comes from a slug, so keep
  // it to the DNS charset instead of trusting it.
  if (!/^[a-zA-Z0-9.-]+$/.test(input.hostname)) {
    throw new Error("hostname contains characters that cannot be embedded");
  }
  return `你是在帮用户配置 Mediary Scout 的「Mediary Connect」远程访问。

目标:让用户的自托管实例经 Cloudflare Tunnel 发布到:
  https://${input.hostname}
门禁是应用自身的访问密码(浏览器首次打开时会要求设置访问密码;设置后远程访问必须登录,局域网直连不受影响)。
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
  # 加 PID 后缀：同一秒内跑两次（或并发跑）会撞名，把上一份备份覆盖掉，
  # 那就违背了「所有 .env.bak-* 都保留」的承诺。
  BACKUP_FILE=".env.bak-$(date +%Y%m%d-%H%M%S)-$$"
  # 极端情况下仍撞名就别覆盖，直接换一个
  while [ -e "$BACKUP_FILE" ]; do
    BACKUP_FILE="$BACKUP_FILE-1"
  done
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
  \`\`\`

⚠️ 1b. 原子化写入(不用 sed -i):
  \`\`\`bash
  # 用 cp -p 建立 .env.new，直接继承原文件权限/属主。
  # 不要用 stat 解析权限位：GNU coreutils 的 -f 是"文件系统信息"，
  # \`stat -f %Lp\` 会打印文件系统垃圾且退出码为 0，导致 \`|| stat -c %a\` 兜底
  # 永不触发，chmod 拿到垃圾值失败后被 \`|| true\` 吞掉，
  # 结果 600 的 .env 静默变成 644——token 对同机其他用户可读。
  # 必须检查 cp -p 退出码：失败就意味着权限没继承，不能硬着头皮往下走。
  if ! cp -p .env .env.new; then
    echo "❌ 创建 .env.new 失败（cp -p 非零），已中止，.env 未被改动"
    rm -f .env.new
    exit 1
  fi
  # docker compose 认这些写法都算 TUNNEL_TOKEN：前导空格、= 两侧空格、export 前缀。
  # 只匹配 '^TUNNEL_TOKEN=' 会漏掉它们，留下一条含旧密钥的重复行，
  # 而且下面的行数自检也会跟着算错。三处（过滤/计数/校验）必须用同一个正则。
  TOKEN_RE='^[[:space:]]*(export[[:space:]]+)?TUNNEL_TOKEN[[:space:]]*='
  # 保留所有非 TUNNEL_TOKEN 的行（'>' 截断写入，不改动已有权限）
  # grep 退出码：0=有匹配行，1=没有保留行（.env 只有 TUNNEL_TOKEN，合法），
  # >=2 才是真错误。必须区分——若 grep 报错，'>' 已把 .env.new 截断成空，
  # 继续 mv 会用「只剩 token」的文件覆盖 .env，静默清空 API_KEY/DB 等全部配置。
  grep -Ev "$TOKEN_RE" .env > .env.new
  GREP_RC=$?
  if [ "$GREP_RC" -ge 2 ]; then
    echo "❌ 读取 .env 失败（grep 退出码 \${GREP_RC}），已中止，.env 未被改动"
    rm -f .env.new
    exit 1
  fi
  # 追加新 token。用「带引号的 heredoc」承载 token：内容完全按字面处理，
  # 不做任何展开。绝不要写成 printf ... '<token>'——token 里只要有一个单引号
  # 就会闭合引号，后面的内容会被 shell 当命令执行（这是真实存在过的注入）。
  TOKEN_VALUE=$(cat <<'${TOKEN_HEREDOC_MARKER}'
${input.tunnelToken}
${TOKEN_HEREDOC_MARKER}
)
  if ! printf 'TUNNEL_TOKEN=%s\\n' "$TOKEN_VALUE" >> .env.new; then
    echo "❌ 写入 token 失败，已中止，.env 未被改动"
    rm -f .env.new
    exit 1
  fi
  # 替换前自检：新文件必须含 TUNNEL_TOKEN，且非 token 行数与原文件一致
  OLD_KEPT=$(grep -Ecv "$TOKEN_RE" .env || true)
  NEW_KEPT=$(grep -Ecv "$TOKEN_RE" .env.new || true)
  if [ "$OLD_KEPT" != "$NEW_KEPT" ]; then
    echo "❌ 新文件丢了配置行（原 $OLD_KEPT 行 → 新 $NEW_KEPT 行），已中止"
    rm -f .env.new
    exit 1
  fi
  if ! grep -Eq "$TOKEN_RE" .env.new; then
    echo "❌ 新文件里没有 TUNNEL_TOKEN，已中止"
    rm -f .env.new
    exit 1
  fi
  # 原子替换（mv 也要查退出码：只读文件系统/权限问题会让 token 根本没写进去，
  # 却继续往下验证，最后得出「已写入」的错误结论）
  if ! mv .env.new .env; then
    echo "❌ 替换 .env 失败（mv 非零），已中止，.env 未被改动"
    rm -f .env.new
    exit 1
  fi
  # 真的比对权限：备份是替换前的原样，两者权限必须一致。
  # 只 echo 不比对会让保证听起来比实际检查更强（上面那个 stat 坑就是这么藏住的）。
  ENV_MODE=$(ls -l .env | cut -c1-10)
  BAK_MODE=$(ls -l "$BACKUP_FILE" | cut -c1-10)
  if [ "$ENV_MODE" != "$BAK_MODE" ]; then
    echo "⚠️ .env 权限($ENV_MODE) 与备份($BAK_MODE) 不一致，请报告这一行"
  else
    echo "✓ .env 权限保持 $ENV_MODE"
  fi
  \`\`\`

⚠️ 1c. 立刻验证 + 失败自动回滚:
  \`\`\`bash
  # 必须先 stop + rm -f 再 up -d：
  # 1) up -d 可能复用已有容器，不会重读新的 TUNNEL_TOKEN
  # 2) 旧容器的日志里已有 Registered 行，会让坏 token 假装验证通过
  docker compose --profile tunnel stop cloudflared 2>/dev/null || true
  docker compose --profile tunnel rm -f cloudflared 2>/dev/null || true
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
    REGISTERED=$(docker compose --profile tunnel logs cloudflared --tail 50 2>/dev/null | grep -c "Registered tunnel connection" || true)
    if [ "$REGISTERED" -ge 4 ]; then
      echo "✅ Tunnel 连接成功（Registered ×\${REGISTERED}）"
      break
    fi
  done
  
  # 只有 0 条才算失败回滚：1~3 条说明 token 有效、隧道已在转发流量，
  # 回滚一个能用的隧道比连接数不满更糟
  if [ "$REGISTERED" -eq 0 ]; then
    echo "❌ 验证失败,自动回滚到备份"
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
    # 回滚本身也要校验，否则「回滚完 .env 还是坏的」而且没人知道
    if ! cp "$RESTORE_FROM" .env; then
      echo "❌ 回滚失败（cp 非零）！请手动执行: cp $RESTORE_FROM .env"
      exit 1
    fi
    if [ "$(wc -c < "$RESTORE_FROM")" != "$(wc -c < .env)" ]; then
      echo "❌ 回滚不完整！请手动执行: cp $RESTORE_FROM .env"
      exit 1
    fi
    echo "✓ 已从 $RESTORE_FROM 恢复"
    # 关键：必须用 stop + rm + up -d（重读 .env），down 不支持指定服务名
    docker compose --profile tunnel stop cloudflared 2>/dev/null || true
    docker compose --profile tunnel rm -f cloudflared 2>/dev/null || true
    docker compose --profile tunnel up -d --force-recreate cloudflared
    # 回滚后必须再验一次：容器可能仍然起不来，这时候说「已恢复」是骗人的
    RB_ELAPSED=0
    RB_REGISTERED=0
    while [ $RB_ELAPSED -lt 30 ]; do
      sleep 5
      RB_ELAPSED=$((RB_ELAPSED + 5))
      RB_REGISTERED=$(docker compose --profile tunnel logs cloudflared --tail 50 2>/dev/null | grep -c "Registered tunnel connection" || true)
      if [ "$RB_REGISTERED" -ge 1 ]; then break; fi
    done
    if [ "$RB_REGISTERED" -ge 1 ]; then
      echo "✅ 已回滚,你的服务恢复到配置前状态（Registered ×\${RB_REGISTERED}）"
    else
      echo "❌ 已还原 .env,但 cloudflared 仍未连上。请把下面日志发给支持:"
      docker compose --profile tunnel logs cloudflared --tail 30 2>/dev/null || true
    fi
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
- 应看到 Mediary Scout 的登录页(全新实例首次打开是设置访问密码的页面)
- 请用户设置访问密码 — 这就是门禁:设置后远程访问必须登录,之后进入 Mediary Scout 面板
- 你(agent)不要自行声称验证结果;让用户告诉你看到了什么。
- 若用户直接看到应用主界面而没有任何登录/设密码页,立刻停止并提示(门禁没生效,需作者检查)。

第 6 步·收尾(告诉用户):
- https://${input.hostname} 现在可从任何设备访问;token 页面只显示一次,但 token 本身长期有效,重启容器/宿主不影响。
- 以后若无法访问,先 \`docker compose logs cloudflared --tail 30\` 看隧道是否还活着。

完成后用简短中文汇报三项:隧道是否 Registered、登录/设密码页是否(由用户确认)出现、能否进入面板。
若卡在某步,说明卡在哪、日志关键行、你的下一步建议。
`;
}

/**
 * Delivery-safe wrapper: an unusual token must never block the reveal.
 *
 * If the token cannot be embedded in the script (multi-line, or containing
 * the heredoc marker), return manual instructions instead of throwing, so
 * the user still gets their token and a way to finish the setup.
 */
export function buildAgentPromptOrManual(input: {
  hostname: string;
  tunnelToken: string;
}): string {
  if (canEmbedTunnelToken(input.tunnelToken)) {
    return buildAgentPrompt(input);
  }
  return `你是在帮用户配置 Mediary Scout 的「Mediary Connect」远程访问。

⚠️ 这个 tunnel token 的格式不常见(含换行或保留标记),自动脚本无法安全生成。
请让用户联系支持重新签发 token,不要尝试手工拼 shell 命令写入。

在此之前可以先确认环境:
1. \`docker info\` 能跑通(装了 Docker / OrbStack)。
2. \`docker compose ls\` 找到 mediary-scout 部署目录。
3. 目标地址是 https://${input.hostname},门禁为应用自身的访问密码(首次打开时设置)。

安全红线:
- TUNNEL_TOKEN 是机密。不提交 git、不写进文档/截图/issue、不打印日志。
- 不要用 \`sed -i\` / \`echo >\` 直接改 .env;改前必须备份。
`;
}
