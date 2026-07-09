<!-- 中文 GitHub 精选周刊/月刊 自荐 issue 草稿 · 都是「提 issue 自荐」·本地工作文件 -->

# ① OpenGithubs/weekly（+ monthly 同款可复用）
投稿口：https://github.com/OpenGithubs/weekly/issues/new · 格式follow现有 issue（`【开源自荐】项目名：一句话`）
> monthly（https://github.com/OpenGithubs/monthly）同一套，可同文再提一次。

## Issue 标题
```
【开源自荐】Mediary Scout：让 LLM agent 把你想看的影视转存进自己的网盘（115/夸克/光鸭）并回读验证
```

## Issue 正文
```markdown
**项目地址：** https://github.com/fancydirty/mediary-scout
**在线 demo（只读免装）：** https://demo.mediaryscout.app
**官网 / 桌面版下载：** https://mediaryscout.app

**一句话：** 你说要看哪部电影 / 剧 / 番，一个 LLM agent 跨资源站把最合适的资源转存进你自己的 115 / 夸克 / 光鸭网盘（秒传 / 离线，不下载到本地），转存后回读网盘验证到底落了什么，并持续追踪还缺哪几集。

**解决什么：** 大多数「媒体自动化」要么搜得好但不知道你缺哪集，要么会搬文件却从不验证落了什么。这东西把「获取」当成状态问题，由一个凭证据而非凭感觉行动的 agent 驱动——按画质、中文字幕、去重挑片，转存后回读核对真实文件，没合格的宁可报「未找到」也不塞垃圾。季级状态机记着每部剧缺哪几集，定时巡检只回来补缺。

**特点：**
- 桌面版 Mac / Windows 双击即用，也能 docker 挂 NAS 24h 追更
- 多盘 / 多账号：一个实例全家合用，各绑各的盘、各看各的库
- 全程可观测：活动页实时队列 + agent 每步动作 ticker
- 纯自部署、开源（AGPL），凭证只存你自己实例，作者看不到

**技术栈：** Next.js（App Router / PPR）+ 进程内 worker 驱动的沙盒 agent + Postgres + Vercel AI SDK（任意 OpenAI 兼容端点）+ Electron 桌面壳。
```

---

# ② DevWeekly（Jackpopc）
投稿口：https://github.com/Jackpopc/DevWeekly/issues/new · README 明示「提交 issue，推荐或者自荐」

## Issue 标题
```
【自荐】Mediary Scout：agent 驱动的自部署媒体库，把想看的影视转存进自己的网盘并回读验证
```

## Issue 正文
```markdown
**项目：** https://github.com/fancydirty/mediary-scout ｜ **demo：** https://demo.mediaryscout.app ｜ **官网/桌面版：** https://mediaryscout.app

一个人写的开源自部署项目，分享 + 自荐。

你说要看哪部电影 / 剧 / 番，一个 LLM agent 跨资源站把最合适的资源转存进你自己的 115 / 夸克 / 光鸭网盘（秒传 / 离线，不下载到本地），转存后回读网盘验证，并持续追踪还缺哪几集、出新集自动补。

它把「获取」当成状态问题：agent 按画质、中文字幕、去重挑片，转存后回读核对真实落地文件，没合格的宁可报「未找到」。季级状态机 + 定时巡检只补缺。桌面版双击即用，也能 docker 上 NAS；多账号可全家合用，凭证只存你自己实例。

技术栈：Next.js（App Router / PPR）+ 沙盒 agent + Postgres + Vercel AI SDK（任意 OpenAI 兼容端点）+ Electron。工程上有个值得一提的点：给一个能真删你文件的 LLM agent 上确定性镣铐（预算闸门 / 回读验证 / 窄权限沙盒），写了篇复盘 https://dev.to/fancy39_9841cbc02f99f729c/i-gave-an-llm-agent-write-access-to-my-cloud-drive-three-bugs-taught-me-how-to-constrain-it-42nd
```

---

## 备注
- 两处都是**中文精选**，受众里有能真用中国网盘的开发者 → 可产品向+工程向都提。
- 提 issue 前先看该仓库最近几条 issue 的格式/标签惯例，对齐再提（尊重维护者格式=收录率高）。
- ⚠️awesome-selfhosted 要「首发满 4 个月」→ 约 2026-11 初再投（见 README.md 状态表唤醒日）。
