# 交接文档 · 健壮性审计(2026-07-21)

> 交接对象:接手的 AI 编码助手(opencode 等)。
> 本文是「多轮 AI 迭代磨损了健壮性」这一担忧的一次系统审计产物 + 后续工作指令。
> **动手前必读本文全文 + 下方「铁律」+ `docs/PROJECT-STATUS.md` 末尾快照。**

## 0. 背景与当前状态

media-track(产品名 Mediary Scout):媒体资源自动获取/追踪产品。Next.js 15 web(App Router,`cacheComponents:true`)+ agent 工作流引擎(`packages/workflow`)+ 五个网盘品牌(115/夸克/光鸭/123/天翼)+ 自部署 docker 栈 + Electron 桌面版。由几十轮 AI 会话迭代构建。

**刚合并发版(勿重复处理)**:
- **PR #148**(`af32fa4`):postgres schema-init 失败不再闩死连接池,启动竞态自愈。
- **PR #149**(`560bfea`):ensureSchema 永久错(28P01/28000/3D000)fail-fast、其余重试;新增 `/api/health`(走真实 DB 读路径)+ web 容器 healthcheck。
- 两者已合并进 main、已部署到实例(软路由 `media-router-tunnel`,运行 `560bfea`)、真机 e2e 通过(`/api/health`→200、容器 healthy、ECONNREFUSED=0)。

## 1. 审计方法(可信度依据)

从 `msitarzewski/agency-agents`(GitHub 13.5 万星)取 **7 个审计人格原文**,本地化注入本仓库地图 + 有意设计清单(防把特性当 bug),**并行只读审计**:
Code Reviewer / AI-Generated Code Security Auditor / Database Reliability Engineer / SRE / Application Security Engineer / Test Automation Engineer / Codebase Archaeologist。

产出 **40 条原始发现**。每条经 **3 镜头对抗验证**(反驳者/复现工程师/影响评估,≥2 票才确认)——验证阶段因渠道问题只跑完一部分(16 票),但**已抓出 1 个误报**(见 Tier D),证明验证机制有效。

**可信度分级**(接手方据此决定要不要再验):
- **Tier A** = 主循环(本人)亲自读代码复核过 + 多审计员收敛 → 可直接进 TDD 修复。
- **Tier B** = 对抗验证 3 镜头判真,但主循环未逐行复核 → 修前快速亲证。
- **Tier C** = 单审计员提出、未验证 → 修前必须亲证(记忆铁律:子代理会误报)。
- **Tier D** = 已判定误报 / 影响≈0 → 不修,记录原因防重复发现。

原始数据留档:`/tmp/audit-harvest-full.json`(临时,会失效;关键内容已抄进本文)。

---

## 2. Tier A —— 已亲证,可直接修(建议按此顺序)

### A1. 🔴 HIGH · worker 触发端点无鉴权 + 无 demo 门禁
- **文件**:`apps/web/app/api/workflows/run-next/route.ts:4-17`、`apps/web/app/api/workflows/run-type3/route.ts:4-21`
- **证据**:两路由鉴权是 `if (secret && header !== secret)` —— 环境**没设** `MEDIA_TRACK_WORKER_SECRET` 时完全放行;且都无 `assertNotDemo()`。GET 复用 POST,`run-type3?force=1` 绕过每日时间门。
- **失败场景**:公网只读 demo(或任何未设 secret 的实例)一个匿名 `GET /api/workflows/run-type3?force=1` 就触发真实 sweep,持久写共享 demo 库(episode 翻 obtained、建 run)。对照:同一逻辑经 server action(`runPatrolNowAction`)有 `assertNotDemo()` 门,HTTP 路由这条旁路没有。
- **审计员**:AppSec + Code Reviewer + Test Automation(3 家独立命中);对抗验证 refute/repro/impact 全判真(high)。
- **建议修**:两路由加 `if (isDemoMode()) return 403`;并把「未设 secret 即放行」改为「多用户/demo 模式下必须 secret,否则拒」。补路由测试(当前零覆盖)。

### A2. 🔴 HIGH · tmdb-cache schema-init 用 `??=` 永久闩死(#148 同款漏网)
- **文件**:`apps/web/lib/tmdb-cache.ts:103-105`
- **证据**:`ensureSchema(){ return (this.schemaReady ??= this.createSchema()) }` —— memoize 的是 Promise。首次 `createSchema()` 失败(启动竞态/DB 瞬时抖动)→ 缓存的 rejected promise 永久返回,进程重启前 TMDB 缓存层一直报错。
- **失败场景**:与 #148 修的 postgres.ts 完全同构的闩死,只是漏在了 tmdb-cache。启动竞态下 TMDB 搜索缓存永久坏死。
- **审计员**:DBRE;主循环亲证。
- **建议修**:照 #148 的做法——失败不缓存(让下次重试),或区分永久错 fail-fast、瞬时错可重试。先写复现失败测试(RED)。

### A3. 🔴 HIGH · 五个外部 HTTP 客户端裸 fetch 无超时(违反项目自己的硬规则)
- **文件**:`pan115-cookie-client.ts`、`quark-cookie-client.ts`、`guangya-client.ts`、`prowlarr-provider.ts`、`notify.ts`(均 `packages/workflow/src/`)
- **证据**:五个文件都调 `fetch(` 但**零** `AbortSignal/timeout` 信号;对照 `pansou-provider.ts` 有 3 个超时信号(#118 事故后补的)。
- **失败场景**:项目记忆明载「新外部 HTTP 一律带超时」,且已被咬两次(#118 PanSou 裸 fetch 卡 4.5min、#68 TMDB 直连挂起)。只有出过事的 PanSou 被补,其余五个漏着——网盘 API/Prowlarr/通知任一上游吊住,对应链路(获取/搜索/队列排空)无限挂起。
- **审计员**:SRE + Codebase Archaeologist;主循环亲证。
- **建议修**:统一超时包装(可抽一个 `fetchWithTimeout(url, opts, ms)` helper),五处接入。注意各客户端合理超时值(下载/离线可长、鉴权/查询要短)。

### A4. 🟠 MEDIUM(自部署下偏 HIGH)· docker-compose 无日志上限
- **文件**:`docker-compose.yml`(全服务无 `logging:` 段)
- **证据**:`grep max-size docker-compose.yml` = 0。
- **失败场景**:已被 2026-07-21 事故实证——web 每 3s 刷 ECONNREFUSED,47h 攒 5.6 万条,磁盘无界膨胀。#148/#149 治了那次的根因,但日志洪泛这个放大器还在:下次任何高频错误循环都会撑爆磁盘。
- **审计员**:SRE;主循环亲证。
- **建议修**:每服务加 `logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }`。

### A5. 🟠 MEDIUM · claimNextQueuedWorkflowRun 无行锁,可双认领双跑
- **文件**:`packages/workflow/src/postgres.ts:~422`(claim)、`~513`(updateWorkflowRunProgress 读改写)
- **证据**:claim 事务是 READ COMMITTED 裸事务,无 `SELECT ... FOR UPDATE SKIP LOCKED`,upsert 无 status 守卫。`grep 'FOR UPDATE' postgres.ts` = 0。sqlite 后端注释(sqlite.ts:~557)证明「原子认领」本是设计要求。
- **失败场景**:默认形态唯一认领方=进程内单 worker,难触发;但一旦 A1 那个无鉴权 HTTP 端点被并发打(或多 worker),同一 queued run 被两方同时认领双跑。
- **审计员**:DBRE + Code Reviewer;对抗验证全判真(high)。
- **建议修**:claim 用 `FOR UPDATE SKIP LOCKED` + status 复查。与 A1 是一对(A1 是触发面,A5 是竞态本体)。补并发测试。

### A6. 🟠 MEDIUM · 30 分钟 stale 判定按 startedAt 杀活着的慢 run → 双 agent 清空该季
- **文件**:`packages/workflow/src/postgres.ts:1373-1396`(reserve 时 expire stale)
- **证据**:仅按 `workflowRun.startedAt < staleActiveRunStartedBefore` 判死,无 liveness 检查;「立即巡检」/API force sweep 在请求上下文跑,绕过 worker tick 的 running 旗标。
- **失败场景**:一个跑得慢但活着的 agent run(大批量转存可超 30min)被判 stale 过期,同季第二个 agent 被触发并行跑,可清空/覆写该季 episode 状态。
- **审计员**:Code Reviewer;对抗验证 repro+impact 判真(high)。
- **建议修**:stale 判定加 liveness(心跳时间戳而非 startedAt),或延长阈值 + running 旗标跨触发路径统一。**这条动的是核心资源状态机,改前务必读 `type-and-multiseason-model` 记忆 + 相关 spec,别破坏多季模型**。

---

## 3. Tier B —— 对抗验证判真,修前快速亲证

- **B1** 🟠 `resolveQueueStorage` 对未知/失效 storageId 原样放行(`apps/web/lib/workflow-runtime.ts:~1732`)→ run 钉在不存在的盘、worker 静默回落 env cookie 执行器。验证 refute/repro/impact 全真。Code Reviewer + Archaeologist。
- **B2** 🟠 「Auth 错误上抛让 worker 冻结网盘」契约五个执行器都承诺、worker 侧从未实现(`workflow-runtime.ts:~1742`)。与记忆 `tianyi-123pan-feasibility` 里的 `transferUntilLanded 假承诺` 同源,值得一并查。Archaeologist。
- **B3** 🟡 `pushNotificationsSince` 先 `slice(0,100)` 再按 since 过滤(`workflow-runtime.ts:~1047`)→ 大规模巡检静默漏推通知(`already_current` 每季必建会顶满 100)。验证判真。
- **B4** 🟡 `unbindStorageAction` 检查在途任务与删盘之间 TOCTOU、非事务(`apps/web/app/actions.ts:~63`);且解绑不清 `pan115.cookie` 全局镜像,env 回退可复活已解绑凭证(`actions.ts:~68`)。验证判真(low)。

---

## 4. Tier C —— 单审计员提出,未验证(修前必须亲证)

- **C1** 🟠 worker tick 基础依赖仍写死默认账号(`workflow-runtime.ts:~1880`)→ 多用户模式下默认账号未配置会饿死全队列。Archaeologist。
- **C2** 🟠 多用户模式失效会话的写操作落入 sentinel 账号 `acct_unauthenticated`,QR 绑盘把网盘永久锁进幽灵账号(`workflow-runtime.ts:532-534`)。Code Reviewer + Archaeologist(两家命中,但仅多用户模式)。
- **C3** 🟠 CI 从不 typecheck `apps/desktop` 与 `workers/tmdb-proxy`(`.github/workflows/ci.yml`)。参见记忆 `web-typecheck-coverage`——tsc 覆盖盲区是本项目老毛病。
- **C4** 🟡 vitest 根配置 `passWithNoTests:true`(`vitest.config.ts:7`)→ 测试发现失灵时 CI 仍绿。
- **C5** 🟡 Postgres 测试套件失联即静默 skip、无「PG 测试真跑了」守门(`tests/repository-contract-postgres.test.ts`);6 个 `*.pg.test.ts` 直连 `MEDIA_TRACK_POSTGRES_URL`(可能是生产连接串),cleanup 风险。
- **C6** 🟡 自部署栈对 `pgdata` 卷(媒体库/追踪状态唯一真相)零备份方案、零文档(`docker-compose.yml:~119`)。DBRE。自部署产品应给个 `pg_dump` cron + 恢复文档。
- **C7** 🟡 `deploy.sh` 自验只核对 BUILD_COMMIT、不探 `/api/health`(`scripts/deploy.sh:~46`)→ 运行时坏版照样报 OK。#149 刚加了 health 端点,deploy 自验可顺带用上。
- **C8** 🟡 多用户模式 proxy matcher 把 `/api/health` 也重定向到 `/login`(`apps/web/proxy.ts:~31`)→ 削弱 #149 刚建的 DB 探针。
- **C9** 🟡 worker 认领热路径每 3s 三次全表读 `workflow_runs` 全量 payload、run 历史永不清理(`postgres.ts:~1453`)。对抗验证判真但**影响=缓慢性能老化,不丢数据不挂服务**(单用户年级仅数百-千行),优先级低。
- **C10** 🟢 迁移 DDL 每冷启动重跑 8 个 ALTER(`postgres.ts:153`,低);孤儿 run 恢复无重试上限(`postgres.ts:440`,毒 run 崩溃环);夸克粘贴凭证不验活入库(唯一不一致品牌);testPushNotification 用客户端 URL 无内网过滤(SSRF,`actions.ts:696`,内网自部署威胁有限)。

---

## 5. Tier D —— 已判误报,不要修

- **D1** ❌ 「三处 pg.Pool 未注册 'error' 监听会崩进程」(DBRE 报 high)。**对抗验证 refute 镜头证伪**:裸 Node 确实崩(真机复现 exit 1),但生产是 Next 16.2.9——框架无条件安装 log-only `uncaughtException` handler 且先于池创建,空闲连接被杀不会崩进程。**加 error 监听是良好实践但非 bug,别当高危修**。

---

## 6. 推荐修复顺序(TDD,逐条 RED→GREEN)

1. **A1 + A5**(一对:无鉴权端点 + 双认领竞态)——安全 + 正确性,最高优先。
2. **A3**(五处 fetch 超时)——机械但高价值,统一 helper。
3. **A2**(tmdb-cache 闩死)——照 #148 模板。
4. **A4**(compose 日志上限)——一次配置改动。
5. **A6**(stale 判定)——动核心状态机,最谨慎,先读多季模型记忆。
6. Tier B 亲证后按需修;Tier C 择要(C3/C6/C7 运维价值高)。

每条:先写失败测试 → 修 → 全量 `vitest` + 三处 `tsc`(根 typecheck 不覆盖 apps/web!)+ **`npm run build:web`**(apps/web 改动必跑,cacheComponents 构建约束单测/tsc 抓不到,#149 栽过)。

---

## 7. 铁律(违反会挨骂 / 破坏生产,不可协商)

1. **代码更新一律经 GitHub**:commit→push→PR→实例 `git pull`。**绝不直接 hack 部署机**(公共仓库,他人吃不到 + git pull 冲掉)。仅实例专属配置(LLM key/cookie/.env/DB settings)在实例直接改。
2. **合并前等 Copilot**:CI 绿≠可合。push 后 `requested_reviewers` API 请求 Copilot 重审 → 读 inline 意见 → 逐条判真伪处理 → 才合。
3. **squash 合并带 `Co-Authored-By`** 保留署名。
4. **改 `apps/web/**` 必跑 `npm run build:web`**(tsc 不覆盖 cacheComponents 路由段约束;`export const dynamic` 在此配置下被禁,动态路由用 `await connection()`)。
5. **称「做完/测好」前必须真验端到端**,单元绿≠产品可用;实例改动要真机 e2e。
6. **子代理/审计发现要亲证再采信**(会误报,见 D1)。
7. **别早停**:事没收完别停下来问/汇报。
8. **别凭记忆/摘要瞎搞**:动代码/下结论前回读一手原文。
9. **有意设计勿当 bug**(下节)。

## 8. 有意设计(不是 bug,别"修")

- tv/anime **多季一次性批量收齐**;电影**系列各论各**(⚠️仅电影);状态由资源同步自动变化,非手动定义/非按 type 路由。**乱改单季化/逐季会毁前端**。
- fileId/shareId/taskId 等 18 位 int64 在 `JSON.parse` 前转字符串(bigint 精度保护,是修复不是 bug)。
- demo mode 双 flag 服务端门禁;多用户默认关、scrypt 认证。
- 秒传本质、离线磁力任务不取消、电影不改名——领域规则。

## 9. 环境与运维备忘

- **实例**:软路由,`ssh media-router-tunnel`(CF Tunnel,无 Access);app 在 `/mnt/nvme0n1-4/docker/mediary-scout`,`./scripts/deploy.sh` 发版(自校验 commit)。live 测应用:`ssh -fN -L 3399:localhost:3300 media-router-tunnel` 后打 `localhost:3399`(绕 CF Access,别加 ExitOnForwardFailure)。
- **本项目的持久记忆**在 `~/.claude/projects/-Users-dirtyfancy-projects-media-track/memory/`(Claude Code 的记忆目录)。opencode 无法自动读——**关键记忆已在本文 §7/§8 蒸馏**;若需深挖某历史决策,让用户把对应 `.md` 贴给你。索引见该目录 `MEMORY.md`。
- **状态快照**:`docs/PROJECT-STATUS.md` 末尾(每个里程碑追加一段)。
- CI job = `build-and-test`(typecheck + vitest + build:web)。vitest 600+。

---
*本文由 Claude Code(Fable 5)在交接前生成于 2026-07-21。审计发现的严重度与可信度分级见 §1;接手方对 Tier B/C 应亲证后再改。*
