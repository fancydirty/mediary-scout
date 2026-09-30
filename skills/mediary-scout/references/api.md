# Mediary Scout Agent API — 完整端点文档

本机 Mediary Scout（自托管媒体获取 agent）的本地 HTTP API。任意 coding agent 无需打开桌面客户端，即可改配置、找片、查库存与进度。所有端点前缀 `/api/agent/`。

> 与 `SKILL.md` 同仓同版本。API 变更应同 PR 更新本文件。

---

## 认证与发现

### 发现文件

桌面 app boot 成功后写入 `~/.mediary/agent.json`（权限 0600）；Docker 实例没有这一步，由用户在跑 agent 的电脑上按仓库 `docs/agent-api.md` 手动建同样格式的文件：

```json
{ "baseUrl": "http://127.0.0.1:<port>", "token": "<hex>", "version": "<app version>" }
```

- App 退出**不**删除此文件。
- 遇 `connection refused` → 桌面版：app 未运行（不是没配置）。Docker：实例没在跑，或文件里的 `baseUrl` 从这台电脑连不上。
- 文件缺失 → 桌面版：app 从未成功启动过，让用户打开桌面 app。Docker：用户还没建这个文件，按 `docs/agent-api.md` 建。

Token 由 Electron 主进程首启生成（32 字节 hex），持久化在 userData（`agent-token` 文件），通过环境变量 `MEDIA_TRACK_AGENT_TOKEN` 注入 server。容器版由运维显式设同名 env——desktop 与容器完全对称。

### 鉴权头

所有 `/api/agent/*` 请求必须带：

```
Authorization: Bearer <token>
```

Token 用常量时间比较。标准调用模板：

```bash
TOKEN=$(jq -r .token ~/.mediary/agent.json)
BASE=$(jq -r .baseUrl ~/.mediary/agent.json)
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/<endpoint>"
```

### 账号语义

- 绑定 owner 账号（v1 只服务 owner，无多用户 agent 授权）。
- demo 模式下**全端点返回 403**。

---

## 错误码总表

| 状态码 | 触发条件 | 响应要点 | agent 应对 |
|---|---|---|---|
| `404` | 环境未配置 agent token（端点隐身） | 端点整体不存在/不可用 | 桌面版：提示用户启动桌面 app；Docker：提示用户在 `.env` 设 `MEDIA_TRACK_AGENT_TOKEN` 后 `docker compose up -d` |
| `404` | `acquire` TMDB 无匹配 | 无 `candidates`、无 `matched` | 告诉用户没搜到，建议换关键词/补 `type` |
| `401` | token 错误 | `WWW-Authenticate: Bearer` | 桌面版：token 失效，让用户重开桌面 app 重新生成 agent.json；Docker：agent.json 里的 token 和 `.env` 的 `MEDIA_TRACK_AGENT_TOKEN` 不一致，让用户改成同一个 |
| `409` | `acquire` 多个高分候选 | `{ "candidates": [top5] }` | 列候选给用户挑，带 `tmdbId` 重发。**绝不瞎猜** |
| `403` | demo 模式 | 全端点拒绝 | 告诉用户这是只读 demo，无法执行写操作 |
| `400` | 校验失败 / 回写脱敏占位值 | 具体字段与原因 | 修正 body 后重试；脱敏值禁止回写 |

> **区分两种 404**：无 token 的 404 是「端点隐身/未启用」；`acquire` 的 404 是「片没搜到」。用其它端点是否也 404、以及响应体结构区分。

---

## GET /api/agent/config

导出配置 JSON，秘密字段脱敏。

**请求**

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/config"
```

**响应 200**

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

**字段说明**

- **秘密字段脱敏**：apiKey / token / 推送密钥只露尾 4 位或显示为 `***`。这些值**不可用于回写**（见 PUT）。
- `storages`：只读列出 `id` / `brand` / `name`，**不含凭据**。`brand` 取值如 `pan115` / `quark` / `guangya`。
- `qualityPreference`：如 `"4K"` / `"1080p"`。
- `preferredLanguage`：如 `"zh"`。
- `dailySweepTime`：`HH:MM`，每日巡检时间。

---

## PUT /api/agent/config

部分更新配置：body 传哪些字段就改哪些字段，底层复用桌面 app 既有 save 函数的校验逻辑。

**请求**

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"qualityPreference":"4K","preferredLanguage":"zh"}' \
  "$BASE/api/agent/config"
```

**响应 200**

```json
{ "updated": ["qualityPreference", "preferredLanguage"], "config": { "…": "脱敏后的新全量配置" } }
```

**规则**

- **拒绝脱敏占位值回写**：任何秘密字段值以 `***` 开头或含 `***` → `400`。防止 agent 把 GET 读到的脱敏值写回、毁掉真凭据。
- **秘密字段仅在用户明确提供新明文值时才写**：LLM `apiKey`、`tmdbApiKey`、`prowlarr.apiKey`、`push.*` 密钥等，用户没给新值就不要放进 body。
- **不接受 `storages`**：改盘绑定要在桌面 app 做（QR/凭据交互无法 agent 化）。
- **校验失败 → 400**：响应含具体字段名与失败原因，据此修正后重试。

**可写字段（示例）**：`qualityPreference`、`preferredLanguage`、`dailySweepTime`、`pansouBaseUrl`、`llm.{baseURL,modelId,apiKey}`、`prowlarr.{baseURL,apiKey}`、`tmdbApiKey`、`push.{bark,serverchan,…}`。以 GET 返回的结构为准。

---

## POST /api/agent/acquire

「帮我找 / 下 XX」——服务端 TMDB 搜索 → 打分选最佳匹配 → 与 UI 同路入队。

**请求 body**

```json
{
  "query": "进击的巨人",
  "type": "tv",
  "season": 2,
  "storageId": "cs_…",
  "tmdbId": 123
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 片名关键词 |
| `type` | `"tv"` / `"movie"` / `null` | 否 | 缺省由服务端判断 |
| `season` | number / `null` | 否 | 剧集季号 |
| `storageId` | `"cs_…"` / `null` | 否 | 缺省用 primary drive |
| `tmdbId` | number / `null` | 否 | 消歧重发时带上用户所选候选的 tmdbId |

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"进击的巨人","type":"tv","season":2}' \
  "$BASE/api/agent/acquire"
```

**响应 200（唯一高分匹配，直接入队）**

```json
{
  "status": "requested",
  "matched": { "tmdbId": 1429, "title": "进击的巨人", "year": 2013 },
  "message": "…"
}
```

`status` 取值：`"requested"` / `"already_tracked"` / `"reserved"` 等。

**响应 409（多个高分候选，歧义）**

```json
{ "candidates": [
  { "tmdbId": 1429, "title": "进击的巨人", "year": 2013, "type": "tv" },
  { "tmdbId": 12345, "title": "…", "year": 2020, "type": "movie" }
] }
```

处理：把 `candidates`（标题/年份/tmdbId）列给用户，让用户选一个，再带 `"tmdbId": <所选>` 重发本端点。**绝不替用户拍板。**

**响应 404（无匹配）**：TMDB 搜不到。告诉用户没搜到，建议换关键词或补 `type`。

---

## POST /api/agent/patrol

手动触发一次巡检（force 路径）。内部走 `runScheduledType3({ force: true })`，返回其结果。

**请求**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/patrol"
```

**响应 200**：巡检运行结果摘要（本次扫描/入队情况）。用户说「触发一次巡检」「跑一遍巡检」时用。

---

## GET /api/agent/library

追踪列表 + 缺集状态，复用 library 页查询。

**请求**

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/library"
# 指定盘：
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/library?storageId=cs_…"
```

**查询参数**：`storageId`（可选，指定某个盘）。

**响应 200**：追踪的剧/影列表，每季 obtained / missing 集数与状态。用户问「我在追哪些剧」「缺哪几集」「我的库存」时用。

---

## GET /api/agent/activity

队列中 / 运行中 / 最近完成 run + 结果摘要，复用 activity 查询。

**请求**

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/activity?limit=20"
```

**查询参数**：`limit`（可选，返回条数，默认 20）。

**响应 200**：队列/运行中任务 + 最近完成 run 的结果摘要。用户问「XX 下好了吗」「下载到哪了」「最近在忙啥」时用。

---

## 范围说明（v1 明确不做）

- 网盘绑定 API（QR 交互无法 agent 化，改盘在桌面 app 做）
- 多用户 agent 授权（v1 只服务 owner）
- 取消 / untrack / 重试等生命周期写操作
- WebSocket 推送

以上均非本 API 提供的端点，不要臆造。
