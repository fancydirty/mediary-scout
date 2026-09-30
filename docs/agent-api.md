# Agent API：让编程 agent 直接操作巡影

桌面版和 Docker 实例都提供一组本地 HTTP 接口，Claude Code、Codex、opencode 这类编程 agent 可以不打开网页就操作巡影：改设置、发起获取、看进度。

## 开启

- **桌面版**：自动开启。第一次启动时会把连接信息写到 `~/.mediary/agent.json`。
- **Docker**：在 `.env` 里设 `MEDIA_TRACK_AGENT_TOKEN=<一串随机字符>`，再在部署目录运行 `docker compose up -d`。

## 装上 skill

```bash
mkdir -p ~/.claude/skills/ && cp -r skills/mediary-scout ~/.claude/skills/      # 或 ~/.codex/skills/、~/.config/opencode/skills/
```

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
