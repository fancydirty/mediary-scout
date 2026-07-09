<!-- LinuxDo 发布帖草稿 · 类目建议:开发调优 · 语气:技术、社区向、开源精神,可比 V2EX 详细 · ⚠️需邀请码 -->

# 标题
Mediary Scout：你说要看哪部剧，LLM agent 自动从资源站搜罗、转存进你自己的 115 / 夸克 / 光鸭并回读验证（开源 / 自部署 / 桌面版双击即用 / 有 demo）

# 正文

一个人写的开源项目，自部署党 / 网盘折腾党应该会对胃口，发上来分享 + 求反馈。

**TL;DR：** 你说要某部电影 / 剧 / 番 → 一个 LLM agent 跨索引源搜罗资源 → 把最合适的**转存**进你自己的 115 / 夸克 / 光鸭网盘（秒传 / 离线，不下载到本地）→ 转存后**回读网盘验证**到底落了什么 → 持续追踪还缺哪几集 + 定时巡检补缺。

- 🖥 **桌面版（Mac / Windows，双击即用）：** https://mediaryscout.app
- 🔗 **在线 demo（只读、免安装即玩）：** https://demo.mediaryscout.app
- 📦 **源码：** https://github.com/fancydirty/mediary-scout

demo 是纯前端回放，不连真盘、不写库，点进去直接看 agent 走「搜索 → 转存 → 验证 → 入库」整条流程。

## 解决什么痛点

大多数「媒体自动化」要么搜得好但不知道你到底缺哪集，要么会搬文件却从不验证落了什么。Mediary Scout 把获取当成一个**状态问题**，由一个**凭证据而非凭感觉**行动的 agent 驱动：

- **agent 选片**：读真实搜索结果（PanSou / Prowlarr），按画质偏好、**中文字幕**硬需求、去重来挑——没中字宁可报「未找到」也不给你扒生肉。转存后回读网盘核对真实落地文件。
- **季级状态机 + 定时巡检**：知道每部剧每季缺哪几集，定时只回来处理「仍有缺」的，不重复劳动。
- **多盘 / 多账号**：一个账号挂多块盘，每块盘是一等工作区（账号锚点·网盘端点的树模型）；一个实例还能多人合用——各自注册、各绑各的盘、各看各的库，密码忘了站主能在后台重置、站主自己忘了有 CLI 逃生口。
- **全程可观测**：活动页实时队列 + agent 每步动作 ticker；转存失败如实报「转存失败 + 原因」，不糊弄成「找不到资源」。

## 架构 / 技术栈

```
Web UI (Next.js, App Router/PPR) --入队--> Postgres 队列 + run 状态
                                              |
                                  进程内 worker → V2 沙盒 agent
                                     agent 搜索: PanSou / Prowlarr
                                     agent 转存/回读: 115 / 夸克 / 光鸭
                                     验证 + 标记 回写 Postgres
                                  定时巡检 --只补缺--> 队列
```

- **状态全落 Postgres**，run 可在 worker 重启后续跑（agent 从真实网盘 + DB 状态重建，不依赖缓存的对话历史）。
- agent 权限**窄而受审计**，所有副作用由确定性 workflow 拥有，agent 只在沙盒里搜 / 转存 / 回读。
- LLM 走 Vercel AI SDK，任意 OpenAI 兼容端点自带 key；TMDB 三通道 fallback；公网走 Cloudflare Tunnel（免公网 IP）。
- 桌面版是同一套引擎的 Electron 壳（spawn standalone server），数据落本机 SQLite；服务器版走 Postgres。

## 上手两条路

- **单机 / 先试试：** 官网下桌面版，双击打开，设置里填网盘和 LLM 就能用。不碰命令行、不装 docker。
- **24h 挂机 / 全家合用：** `docker compose up -d` 一把拉起（web + Postgres + 自带 PanSou），其余在设置页里填（网盘扫码 / cookie、LLM、可选 Prowlarr）。

彩蛋：README 里放了一段部署提示词，**把它丢给 Claude Code / Codex / opencode，agent 会按问答引导帮你把实例部署起来**——自己懒得读文档可以试试。

## 关于资源源

搜罗走 PanSou（可选叠加 Prowlarr）。能搜到多好的资源，取决于 PanSou 连了哪些频道——桌面版本身不含 PanSou 容器（想要更丰富的源，按官网教程自建一个，Mac OrbStack / Win Docker Desktop）；docker 那套则自带一个。仓库里附了一份好频道配置。

## 定位（说在前面）

开源、纯自部署，**不提供也永远不会提供托管服务**——你自己跑实例、自带网盘 / LLM / 元数据凭证。它做的就是你本来在自己网盘里也能手动完成的那些文件操作。

接入新网盘品牌是个收敛的插件活（已有 115 / 夸克 / 光鸭），欢迎 issue / PR；或者就去 demo 点两下，告诉我哪里反人类。给个 star 也行 🙏
