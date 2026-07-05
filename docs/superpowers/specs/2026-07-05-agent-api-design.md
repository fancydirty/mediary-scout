# Agent API + Agent skill 设计（agent-first 操作面）

日期：2026-07-05
状态：已与用户逐段评审通过（4 段全过）

## 目标

让任意 coding agent（Claude Code / Codex / opencode / …）无需打开桌面客户端即可操作 Mediary Scout：改配置、触发找片、查库存与进度。实现方式是**本地 HTTP API + 仓库内 Agent Skill**，不做 MCP server、不做 CLI 二进制（均为 v2 候选，v1 明确不做）。

核心判断：agent 的"CLI"就是 curl。skill 教会 agent「读发现文件 → 调 API」，零安装、跨 agent 通用。

## 范围（用户选定 B 档）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/agent/config` | GET | 导出配置 JSON（秘密字段脱敏） |
| `/api/agent/config` | PUT | 部分更新配置（传啥改啥） |
| `/api/agent/acquire` | POST | 「帮我找 XX」→ TMDB 解析 → 入队 |
| `/api/agent/patrol` | POST | 手动触发巡检（force 路径） |
| `/api/agent/library` | GET | 追踪列表 + 缺集状态 |
| `/api/agent/activity` | GET | 队列/运行中/最近 run 摘要 |

明确不做：网盘绑定 API（QR 交互无法 agent 化）、多用户 agent 授权（v1 只服务 owner）、取消/untrack/重试等生命周期写操作（C 档，v2）、WebSocket 推送。

## 认证与发现

- **Token 生成**：Electron 主进程首启生成 32 字节 hex token，持久化在 userData（`agent-token` 文件），通过 env `MEDIA_TRACK_AGENT_TOKEN` 注入 server child。容器版由运维显式设同名 env 启用——**desktop/容器完全对称，都是 env 注入**，server 侧零特殊分支。
- **发现文件**：`~/.mediary/agent.json`，权限 0600，desktop boot 成功后写入：
  ```json
  { "baseUrl": "http://127.0.0.1:<port>", "token": "<hex>", "version": "<app version>" }
  ```
  App 退出不删除；agent 遇 connection refused 即知 app 未运行。
- **鉴权**：所有 `/api/agent/*` 要求 `Authorization: Bearer <token>`，常量时间比较。**未配置 token 的环境返回 404**（端点隐身），token 错误返回 401 + `WWW-Authenticate: Bearer`。
- **账号语义**：绑定 owner 账号。demo 模式全端点 403（复用 `assertNotDemo`）。

## 端点契约

### GET /api/agent/config

```json
{
  "llm": { "baseURL": "…", "modelId": "…", "apiKey": "sk-***7f2a" },
  "qualityPreference": "4K",
  "preferredLanguage": "zh",
  "dailySweepTime": "09:30",
  "pansouBaseUrl": "…",
  "prowlarr": { "baseURL": "…", "apiKey": "***" },
  "tmdbApiKey": "***",
  "push": { "bark": "…", "serverchan": "***" },
  "storages": [ { "id": "cs_…", "brand": "pan115", "name": "…" } ]
}
```

- 秘密字段（apiKey/token/推送密钥）只露尾 4 位或 `***`。
- `storages` 只读列出（id/brand/name），不含凭据；PUT 不接受 storages。

### PUT /api/agent/config

- Body 为部分对象，传啥改啥；底层复用 `actions.ts` 既有 save 函数的校验逻辑。
- **拒绝脱敏占位值回写**：以 `***` 开头或含 `***` 的秘密字段值 → 400，防 agent 把读到的脱敏值写回毁真值。
- 响应：`{ "updated": ["字段"], "config": <脱敏后新全量> }`。
- 校验失败 → 400 + 具体字段与原因。

### POST /api/agent/acquire

Body: `{ "query": "进击的巨人", "type": "tv"|"movie"|null, "season": 2|null, "storageId": "cs_…"|null, "tmdbId": 123|null }`

- 服务端 TMDB 搜索 → 打分选最佳匹配 → 与 UI 同路（`queueCandidateTracking` / reserve 逻辑）。
- 唯一高分匹配 → 直接入队，返回 `{ "status": "requested"|"already_tracked"|"reserved"|…, "matched": {"tmdbId","title","year"}, "message" }`。
- **歧义（多个高分候选）→ 409 + `{ "candidates": [top5] }`**，agent 让用户挑后带 `tmdbId` 重发。绝不瞎猜。
- 无匹配 → 404。`storageId` 缺省用 primary drive。

### POST /api/agent/patrol

- 内部走 `runScheduledType3({ force: true })`，返回其结果。

### GET /api/agent/library?storageId=…

- 复用 library 页查询：追踪的剧/影、每季 obtained/missing 集、状态。

### GET /api/agent/activity?limit=20

- 队列中/运行中/最近完成 run + 结果摘要（复用 activity 查询）。

## Agent skill

- **位置**：仓库 `skills/mediary-scout/SKILL.md` + `references/api.md`（完整端点文档）。与代码同仓同版本，API 变更同 PR 改 skill。
- **分发**：README「Agent 接入」一节，`cp -r skills/mediary-scout ~/.claude/skills/`（Codex/opencode 类似）。
- **结构**：frontmatter（name/description 塞满中文触发词：帮我找/下载 XX、XX 下好了吗、我在追哪些剧、改画质、触发巡检）+ 连接三步（cat agent.json / 文件不存在→提示启动 / refused→app 未运行）+ 表驱动能力速查 + 关键规则（409 候选交用户挑、`***` 脱敏值绝不回写、秘密字段仅用户明确提供新值才写）。
- 正文 ≤100 行，细节下沉 references/api.md。
- **验证**：本机真装进 Claude Code/opencode，说「帮我找 XX」全程自主跑通才算完。

## 实现切面

```
apps/web/lib/agent-api/
  auth.ts        token 解析（env）+ 常量时间比较 + 无 token→404 语义
  config-io.ts   读（脱敏）/写（校验+拒占位值），复用 actions.ts 底层 save
  acquire.ts     query→TMDB 搜索→打分→唯一匹配 or 409 候选→queueCandidateTracking
apps/web/app/api/agent/
  config/route.ts (GET+PUT) · acquire/route.ts · patrol/route.ts · library/route.ts · activity/route.ts
apps/desktop/src/
  agent-manifest.ts  纯函数：token 生成/持久化、agent.json 内容与 0600 写入（单测）
  main.ts            boot 成功后写 manifest；spawn 时注入 MEDIA_TRACK_AGENT_TOKEN
skills/mediary-scout/
  SKILL.md + references/api.md
```

## 测试策略

- **单测**：auth（常量比较/404 语义/env 缺省）、config 脱敏与占位值拒写、acquire 打分歧义判定、agent-manifest 纯函数。
- **集成**：vitest 直调 route handler（项目既有模式），SQLite 后端全端点 happy path + 认证矩阵（无 token/错 token/对 token）。
- **容器回归**：不设 `MEDIA_TRACK_AGENT_TOKEN` 时全端点 404，现有测试零变化。
- **真机 e2e**：打包安装 → `cat ~/.mediary/agent.json` → curl 全端点 → Claude Code 装 skill 说「帮我找 XX」跑通真实获取。
