# Mediary Scout 桌面应用(macOS)— 设计文档

> brainstorming 产出,用户逐段认可(2026-07-04)。终点是 writing-plans,不在本文。

## 目标(一句话)

把 media-track 打包成 macOS 桌面应用,让非技术用户「下载即用」——免去 Docker/Postgres/compose/隧道的自部署门槛;自动追更在「新的一天首次打开」时触发,常开(Mac mini 当服务器)则像容器一样常驻。**核心引擎(Next 服务 + 进程内 worker + agent + 巡检)一行不改地复用**,桌面端只新增:原生壳、SQLite 数据层、打包。

## 第一约束:防代码分裂(为什么这不是「第二个产品」)

桌面端 = 同一个引擎的第二个启动器,不是重写。分层看谁共享、谁可能分裂:

| 层 | 份数 | 分裂风险 |
|---|---|---|
| 产品逻辑/UI/worker/agent/搜索/巡检(`apps/web` + `packages/workflow`) | **一份** | **永不分裂**——新功能落这里一次,容器 + 桌面跑同一个 server 都自动吃到 |
| 原生壳(`apps/desktop`) | 桌面独有 | 纯 glue,和产品逻辑解耦,加功能从不需要改它 |
| 数据层(`WorkflowRepository` 接口后的实现) | PG 一份 + SQLite 一份 | **唯一的缝**,由共享契约测试锁死 |

**唯一的税**在数据层:绝大多数新功能只往 `(id, payload json)` 的 payload 加字段 → 两个引擎都只多存 JSON,**零数据层改动**;只有「新表 / 新索引查询」才需在 `postgres.ts` + `sqlite.ts` 各写一处,且**共享契约测试套件强制两边语义一致**(一处偏差就红),不可能悄悄分裂。

**收敛轨迹(不在本 v1)**:桌面跑通后,可用独立小 PR 把容器也翻 SQLite(单实例栈 SQLite 完全够,顺手干掉 compose 的 postgres 服务 + pgdata 卷 + DB 密码),使**全产品收敛成一份数据层**;仅 Vercel 只读 Demo(serverless 多实例)保留 PG。v1 不碰正在跑的软路由。

## 架构

```
Electron 主进程(本身是 Node)
 ├─ app.requestSingleInstanceLock():二次启动只聚焦已有窗口,绝不重开第二个 server
 ├─ whenReady → 选空闲端口 → spawn(process.execPath, ['apps/web/server.js'],
 │     { env: { ELECTRON_RUN_AS_NODE: '1', MEDIA_TRACK_SQLITE_PATH, PORT, ...creds env } })
 │     ↑ 用 Electron 二进制当纯 Node 跑子进程(ABI 与 better-sqlite3 原生模块一致,无需另打包 Node)
 │     引擎 = 现有 Docker CMD 那个 standalone server:Next 服务 + 进程内 worker
 │            (background-worker.ts:3s 轮询 → 清队列 + 自门控每日巡检 + 启动时孤儿恢复)—— 原样复用
 ├─ 轮询 http://127.0.0.1:PORT 直到 listening → BrowserWindow 加载它(展示现有 web UI,零改)
 ├─ Tray(菜单栏)常驻:打开主窗口 / 开机自启开关 / 退出
 │     关窗口 = 隐藏(server 继续跑,巡检不断);仅「退出」SIGTERM server 才真停
 └─ 数据/凭证:SQLite 文件 + 一切在 ~/Library/Application Support/MediaryScout/
```

**对称性**:Docker 是容器 CMD 拉起 server,桌面是 Electron 拉起同一个 server。启动路径几乎一致。

## 数据层:Postgres → SQLite(接口后换实现,两套并存)

- 新增 `SqliteWorkflowRepository implements WorkflowRepository`(新文件 `packages/workflow/src/sqlite.ts`,`better-sqlite3`),与 `PostgresWorkflowRepository`(`postgres.ts`)平级。调用方只认接口,不动。
- Schema:现有表基本 `(id text, payload jsonb)` → SQLite `(id text primary key, payload text)`,payload 存 JSON 文本。映射:`payload::json->>'x'` → `json_extract(payload,'$.x')`;`ON CONFLICT` → SQLite UPSERT;`RETURNING` → SQLite 3.35+ 原生。**原生 SQL 只集中在 `postgres.ts` + `tmdb-cache.ts` 两处**,业务代码不含裸 SQL,故端口有界。
- `tmdb-cache.ts`(也用 pg):港一份 SQLite 版(小),或桌面端降级为纯 worker 内存缓存——实现时二选一。
- 引擎选择:`getWorkflowRepository()` 按 env——有 `MEDIA_TRACK_SQLITE_PATH` 走 SQLite,否则 `MEDIA_TRACK_POSTGRES_URL` 走 PG。两套长期并存(web/Docker/Demo=PG,桌面=SQLite)。
- better-sqlite3 同步 → 接口 async 方法内同步调用后返回即可;单进程单连接、WAL 模式、自然串行,无并发问题。
- 凭证/设置(115/夸克/光鸭 cookie/token、LLM key、TMDB、画质/语言偏好)本就存在 DB 的 settings 表 → 随 SQLite 落在 App 数据目录,**无需新增密钥存储**。

## 生命周期 + 「首次打开触发」

- **单实例锁**:防双 server 抢端口 + 双 worker。
- **关窗 ≠ 退出**:关窗口隐藏,server 子进程继续 → 巡检不断;Tray「退出」才 SIGTERM server 真停。
- **开机自启**:`app.setLoginItemSettings({ openAtLogin })`,Tray 开关。伺候常开 Mac mini。
- **优雅退出**:SIGTERM server;跑到一半的任务留 DB `running` 态 → 下次启动 `recoverOrphanedRuns` 续跑(现成)。SQLite 关前 WAL checkpoint。
- **「首次打开触发」= 零新逻辑**:App 启动 → server 起 → worker 首个 tick(≤3s)调 `runScheduledType3` → 门控放行当天第一次。同日再开:单实例锁使不重开 server,且门控也会挡。中断关闭→重开:`recoverOrphanedRuns` 续跑。常开:内部 3s 轮询持续每日触发门。
- **桌面口径决策(已定)**:现有巡检门是「一天一次 **且** 到设定时间点(默认北京 06:00,给常开服务器摊负载用)」。桌面若只在早于该点时开一下就关会永不跑 → **桌面端把门改为「只看日期」**(今天没跑过就跑,不看几点):给 `runScheduledType3` 加 `ignoreTimeGate` 配置(共享函数加参,非分叉),桌面传 true,常开服务器仍可用时间点门。

## 打包 / 签名 / 分发

- **`electron-builder` 出 `.dmg`**:Electron 壳 + Next standalone 产物(`.next/standalone`+static+public)+ `packages/workflow` dist + **better-sqlite3 原生模块**(electron-builder 按 Electron ABI 自动重建,`npmRebuild`)。server 子进程复用 Electron 二进制当 Node,不另打包 Node 运行时。
- **签名 + 公证**:用户有 Apple 开发者号 → v1 直接出**签名+公证** dmg(electron-builder `mac.notarize` + `hardenedRuntime`;证书/API key 走本地 keychain / env secrets,不入库)。免去「右键打开/xattr」那步。
- **自动更新**:v1 缓着(手动下新 dmg);electron-updater 待后续版本。

## 错误处理与边界

- **端口占用**:启动时探测选空闲端口(不硬编码),把选中端口传给窗口 URL。
- **server 起不来**:health 轮询设超时上限,超时则弹原生错误框(而非白窗);日志落 App 数据目录便于诊断。
- **僵尸子进程**:退出/崩溃时确保 SIGTERM;单实例锁 + 退出钩子避免遗留 server。
- **首启无网盘**:worker 已有「无盘静默跳过」(`isDriveConfigured`),桌面首启空库直接进连接页,不报错。
- **崩溃/断电中断任务**:留 DB `running` → 下次 `recoverOrphanedRuns` 续跑(现成)。

## 测试

- **数据层(重头,安全网)**:抽共享**契约测试套件**,对 PG + SQLite **各跑一遍**——SQLite 语义与 Postgres 一处偏差即红。覆盖 `WorkflowRepository` 全部方法 + `tmdb-cache`。
- **Electron 主进程逻辑**:选端口 / health 等待 / 巡检门配置 / Tray 状态机 / 关窗保活 / 退出清理,抽**纯函数**单测;Electron 绑定薄到不必测。
- **复用**:现有 1169 vitest + agent/巡检逻辑一行没改,全部照覆盖。
- **打包后真机 e2e**:装 `.app` → 启动(server 起 + 窗口 health 200)→ 连盘 → 获取一部 → **关窗后 server 仍跑(巡检续)** → 退出才停;「纯日期门」验:清 last_run 启动→触发,同日再开→不重跑;开机自启开关真写 LoginItem。

## 文件结构(供 writing-plans 展开)

- 新增 `apps/desktop/`:Electron 主进程(`main.ts`:单实例锁/spawn server/health 等待/窗口/Tray/生命周期)、纯逻辑模块(`server-launch.ts` 选端口+等待、`tray.ts` 菜单状态)、`electron-builder` 配置。
- 新增 `packages/workflow/src/sqlite.ts`(`SqliteWorkflowRepository`)+ 契约测试套件(`tests/repository-contract.ts` 参数化 PG/SQLite)。
- 改 `getWorkflowRepository()` 工厂(加 SQLite 分支)、`runScheduledType3`(加 `ignoreTimeGate`)、`tmdb-cache`(SQLite 变体或降级)。
- `apps/web` / `packages/workflow` 产品逻辑与 UI:**零改动**(除上述工厂/门控小接线)。

## v1 明确不做(YAGNI)

Windows(快速跟进版)/ Telegram 双向(砍,不适用 CN)/ 自动更新(手动 dmg)/ 容器翻 SQLite(桌面跑通后独立小 PR)/ PG→SQLite 迁移工具(桌面=全新安装:重连网盘,媒体库从盘+TMDB 自动重建,追更列表手动重加一次——一次性重设,可接受)。
