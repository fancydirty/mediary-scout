# Agent API：让编程 agent 直接操作巡影

桌面版和 Docker 实例都提供一组本地 HTTP 接口，Claude Code、Codex、opencode 这类编程 agent 可以不打开网页就操作巡影：改设置、发起获取、看进度。

开了多用户的实例里，这组接口操作的都是站主账号（第一个注册的那个）；「立即巡检」会把所有账号都巡检一遍。其他成员要操作自己的库，用网页。

## 开启

**桌面版**：自动开启。第一次启动时会生成 token，并把地址和 token 写到 `~/.mediary/agent.json`，skill 就从这个文件读。

**Docker**：

1. 生成一个随机 token：`openssl rand -hex 32`。这个 token 能改设置、发起获取，别用短的或好猜的。
2. 写进部署目录的 `.env`：`MEDIA_TRACK_AGENT_TOKEN=<上一步的输出>`，然后在部署目录运行 `docker compose up -d`。
3. 在跑编程 agent 的那台电脑上自己建连接文件（这台电脑要能访问实例，比如同一局域网或 Tailscale）：

```bash
mkdir -p ~/.mediary && chmod 700 ~/.mediary
printf '{"baseUrl":"http://<主机IP>:3000","token":"<同一个 token>"}\n' > ~/.mediary/agent.json
chmod 600 ~/.mediary/agent.json
```

## 装上 skill

skill 在本仓库的 `skills/mediary-scout` 里。桌面版用户手上没有仓库，先拉一份：

```bash
git clone --depth 1 https://github.com/fancydirty/mediary-scout /tmp/mediary-scout
mkdir -p ~/.claude/skills/ && cp -r /tmp/mediary-scout/skills/mediary-scout ~/.claude/skills/      # 或 ~/.codex/skills/、~/.config/opencode/skills/
```

Windows 上在 Git Bash 里跑同样的命令，或者手动把 `skills/mediary-scout` 文件夹复制到 `%USERPROFILE%\.claude\skills\`。

skill 用 `curl` 和 `jq` 调接口。Git Bash 不带 `jq`，Windows 上先装一下（`winget install jqlang.jq`）；macOS / Linux 没有的话用 `brew install jq` 或 `apt install jq`。

之后直接跟 agent 说「帮我找进击的巨人第二季」「蜘蛛侠下好了吗」「把画质改成 high」就行。能说哪些话见 [`skills/mediary-scout/SKILL.md`](../skills/mediary-scout/SKILL.md)。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/agent/config` | 读设置（密钥打码） |
| `PUT` | `/api/agent/config` | 改部分设置（拒绝写回打码的 `***`） |
| `POST` | `/api/agent/acquire` | 查 TMDB 后入队获取（有歧义返回 409） |
| `POST` | `/api/agent/patrol` | 立即巡检一轮 |
| `GET` | `/api/agent/library` | 在追的作品和缺的集 |
| `GET` | `/api/agent/activity` | 正在跑的任务和最近的通知 |

全部要带 `Authorization: Bearer <token>`。没配 token 时这些接口返回 404（等于不存在）；token 不对或没带返回 401。
