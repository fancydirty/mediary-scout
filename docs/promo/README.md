<!-- 推广弹药索引 · 本地工作文件,不提交公共 repo · 最后更新 2026-07-07 -->

# 推广发布帖索引

**定标：赚吆喝/口碑，不赚钱**（项目净亏、零收入）。优化目标 = 在「会欣赏手艺、会讨论、会 star」的人群里制造高质量声量，不是最大化安装量。**消费向平台（什么值得买/酷安/appinn）暂不碰**——声量低质、churn 高。

**主线叙事：桌面版打头，自部署断后。** 入口从「会 docker」降到「双击即用」。

## 硬链接（所有帖统一）

- 官网 / 桌面版下载：https://mediaryscout.app （Mac `Mediary.Scout-1.2.0-arm64.dmg` / Win `Mediary.Scout.Setup.1.2.0.exe`）
- 只读 demo：https://demo.mediaryscout.app
- 源码：https://github.com/fancydirty/mediary-scout
- 网盘品牌：115 / 夸克 / 光鸭 GuangYaPan
- ⚠️桌面版**不含 PanSou 容器**（docker 栈才自带）；资源源丰富度取决于 PanSou 频道配置。

## 两台声量发动机

**A · 中文自部署/NAS 圈**（能真用 + 会讨论；115/夸克/光鸭是中国网盘）
**B · 工程故事圈**（可能永不用、但会 star + 转；钩子 = 给有真实副作用权力的 agent 上镣铐）

## 首发顺序 + 状态

| # | 渠道 | 引擎 | 草稿 | 门槛 | 状态 |
|---|------|------|------|------|------|
| — | 恩山无线论坛 | A | `enshan-launch.md` | 无邀请码 | ⚠️ 之前发过，效果不佳 |
| — | NodeSeek | A | `nodeseek-launch.md` | 无邀请码 | ✅ 已发 nodeseek.com/post-811070 |
| — | DeepFlood | A | `nodeseek-launch.md`（同款） | 无邀请码 | ✅ 已发 deepflood.com/post-38340 |
| — | dev.to 长文 | B | `../blog/2026-06-28-dev-to-agent-architecture.md` | 无 | ✅ 已发（[链接](https://dev.to/fancy39_9841cbc02f99f729c/i-gave-an-llm-agent-write-access-to-my-cloud-drive-three-bugs-taught-me-how-to-constrain-it-42nd)），cover 已上 |
| 1 | Hacker News | B | `hn-submission.md`（投 dev.to 文链接，非 Show HN） | 无 | ⏳ 待发（美东工作日早上） |
| 2 | r/LocalLLaMA | B | `r-localllama.md` | 无 | ⏳ 待发 |
| 2 | r/AI_Agents | B | `r-ai-agents.md` | 无 | ⏳ 待发 |
| 3 | r/selfhosted | B | `r-selfhosted.md` | 无 | ⏳ 待发 |
| 3 | Lobsters | B | 投 dev.to 文链接 | ⚠️需邀请 | 🔒 等邀请 |
| — | V2EX / LinuxDo | A | `v2ex` / `linuxdo` | ⚠️需邀请码 | 🔒 等邀请码 |
| — | HelloGitHub · 阮一峰周刊 | B | （issue 投稿） | 无 | ✅ 已投/已收录（流量退） |
| — | OpenGithubs/weekly | A/B | `cn-github-weekly-issues.md` | issue 自荐 | ✅ 已提（[#127](https://github.com/OpenGithubs/weekly/issues/127)，含 GIF+卡片） |
| — | OpenGithubs/monthly | A/B | 同款 | issue 自荐 | ⏸ 暂缓（同 org，避免与 weekly 同时刷=像 bot；隔几天再提或让 monthly 从 weekly 收） |
| — | DevWeekly | A/B | `cn-github-weekly-issues.md` | issue 自荐 | ✅ 已提（[#46](https://github.com/Jackpopc/DevWeekly/issues/46)，含 GIF） |
| — | Gitee 镜像（国内 GitHub） | A | 镜像仓 | 已建 | ✅ 公开 [gitee.com/dirtyfancy/mediary-scout](https://gitee.com/dirtyfancy/mediary-scout)；**已配 Gitee 自动拉取镜像**（管理→仓库镜像管理，定时从 GitHub 拉，无需手动同步）。⚠️别再手动 `git push gitee`（会与 pull-mirror 打架/被回滚）；本地 gitee remote 已删 |
| 🔒 | awesome-selfhosted | B | 结构化 yml PR 到 -data 仓库 | ⚠️首发满 4 个月 | 🔒 **~2026-11-05 才够格**（首发 07-05+4mo；⚠️LLM 草稿会被 ban，需人工精确格式） |

**⚠️国际渠道核心约束**：产品用中国网盘（115/夸克/光鸭），海外受众**用不了**→ 绝不主打「用我的工具」，一律主打**工程故事**（给有真实副作用权力的 agent 上镣铐），网盘只当领域背景。这决定了国际首发 = dev.to 长文 + HN + agent 架构向 subreddit，而非 Show HN 产品帖。

## 发帖注意

- **开场放动图**：`docs/images/demo.gif`（恩山/reddit 直接传，动图最抓人）；`library.png`/`activity.png` 作补充截图。
- **英文帖去 AI 味**（stop-slop）：无 em-dash、句长变化、别编数据。show-hn / r-selfhosted / dev.to 已按此写。
- **诚实定位**必留：开源纯自部署、不提供也永不提供托管、凭证只在你自己实例。
- 先发 1，看一波真反馈，再铺 2/3。V2EX/LinuxDo 等邀请码到手。
