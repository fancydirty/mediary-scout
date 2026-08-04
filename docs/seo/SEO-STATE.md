# SEO 状态

> 每轮更新：证据、已发布内容、待观察指标、下一步。供下一 session 从真实状态继续。

## 产品与转化模型

```
自建 NAS/软路由/闲置机的中文用户，在「网盘里囤了资源但追剧要手动搜/转存/核对」时，
用 Mediary Scout 完成「指定片名 → agent 自动获取并核对入网盘」，
随后发生 GitHub star / 部署 / （可选）购买 Mediary Connect 远程访问。
```

两个站：
- **mediaryscout.app** —— 开源产品主站（Vercel 项目 `mediary-site`，静态单页 `site/`）
- **mediaryconnect.app** —— 付费远程访问服务站（Cloudflare Worker `scout-connect`）

注意：`mediaryscout.com` **不是我们的**，是抢注停放页（$500 要价）。不购买；靠品牌实体信号（JSON-LD + GitHub 反链 + 内容）压制。

## 第 1 轮（2026-08-03）：技术基线

### 审计发现

| # | 站 | 问题 | 级别 |
|---|---|---|---|
| 1 | 主站 | robots.txt 404、sitemap.xml 404 | 阻断发现 |
| 2 | 主站 | 无 canonical | 重复内容 |
| 3 | 主站 | 无 JSON-LD | 品牌实体缺失 |
| 4 | 付费站 | 合规页 5 页 + `?lang=en` 全无 canonical / head 内 hreflang | 重复内容 |
| 5 | 付费站 | 合规页无 description | CTR |
| 6 | 付费站 | 无 JSON-LD，两站无实体串联 | 品牌实体缺失 |
| 7 | 主站 | 无英文版（README 是双语，站只有中文） | 未开发流量池（本轮未做） |

### 本轮已实施

- **主站**：`site/robots.txt`（Allow + Sitemap 声明）、`site/sitemap.xml`（单规范 URL，锚点刻意不列）、`<link rel=canonical>`、JSON-LD `SoftwareApplication` + `FAQPage`（5 条，逐条与页面可见 FAQ 一致，有校验）
- **付费站**：合规页 5 页 × 中英 = 10 个 URL 全部补 `canonical` + 自含 `hreflang`（zh-Hans / en / x-default）+ 真实 `description`；首页补 JSON-LD `Product`(**三档**真实价格 Offer:季 ¥45 / 年 ¥108 / 两年 ¥188,与定价区可见档位逐一对应) + `Organization`，用 `isRelatedTo` 指回主站
- 保留原设计：法务页不进 sitemap（既有测试明确的有意决定，本轮不推翻）

### 验证证据

- 新增测试 6 条（compliance-page ×3、home-page ×3），全部经反向验证真红：移除 canonical / x-default / description / JSON-LD 各自转红
- 全量 **2832 passed / 15 skipped**；根 typecheck + apps/web tsc 干净
- 主站 JSON-LD 本地结构校验：SoftwareApplication 必填齐全、FAQPage 5 条 Q/A 完整、**与页面可见 FAQ 逐条一致**

### 3. 我自己犯的错：脚本重排 bullet 时误删了 README 表格

Copilot 第 2 轮的 **suppressed** 评论抓到的（inline 是 0、"generated no new comments"，
只有折叠区里这一条）—— **再次印证「suppressed 必须读」这条铁律。**

**原因**：重排 bullet 的脚本用 `re.findall` 提取 5 个 bullet 后，只把
`intro + bullets` 拼回原段落 —— 而表格和 "New brands plug into…" 段位于
bullet **之后**、下个 `##` **之前**，被整段丢弃。

**我为什么没发现**：验收时只查了 bullet 顺序（`grep -oE '^\- \*\*'`），
没查表格是否还在。**验收范围窄于改动范围 = 没验收。**

→ **教训**：用脚本做「段落级重写」时，验收必须查 `git diff --numstat`
（本轮修完是 3+/3-，与预期一致）而不只看自己关心的那几行。
段落重排优先用「只交换 bullet」的窄操作，不要重建整段。

### 待观察（发布后）

1. 生产 `https://mediaryscout.app/robots.txt` 与 `/sitemap.xml` 返回 200（Vercel 静态目录是否直出）
2. GSC 提交两站 sitemap → 观察「已发现 / 已抓取 / 已收录」变化
3. 品牌词「mediary scout」「mediary connect」SERP：我们的 `.app` 是否稳定压过抢注 `.com`
4. 合规页（尤其 `/refund`、`/pricing`）是否开始出长尾词
5. 富结果：FAQ / 产品价格是否在 SERP 出现

### 下一步（按优先级）

1. 发布后按上表核对生产 HTML 与状态码（本 PR 合并后立即做）
2. 在 GSC 注册两站并提交 sitemap（**需要用户账号操作**）
3. 主站英文版（`/en/`）—— README 已双语，内容成本低；先验证中文版基线数据再做
4. 机会地图：从「自建/NAS + 网盘自动化 + 追剧」聚类，考虑用例页（如「NAS 自动追剧」「115 自动转存」）——**先等第 1 轮数据，不预先批量造页**


## 第 2 轮（2026-08-04）：私有页面索引防护 + HSTS

参照一份外部「技术 SEO 全站审计」清单做交叉检查，只吸收我们真正缺的项（其余
如 canonical/sitemap/hreflang/结构化数据第 1 轮已完成；转化归因我们有
Paddle webhook + D1 entitlements，比 GA4 更硬）。

### 审计发现（真实公网复验，绕开本机代理 fake-ip）

| 级别 | 问题 | 证据 |
|---|---|---|
| **P0** | `/admin` 未登录返回完整管理页 HTML 且无 noindex | `<title>Mediary Connect Admin</title>`，含「邀请/token」字样 |
| **P0** | 付费站 `http://` 明文 200，无跳转、无 HSTS | `--resolve mediaryconnect.app:80:104.21.73.181` → `HTTP/1.1 200 OK`，无 Location |
| **P1** | `/login` 无 noindex | 200 + 无 robots meta |
| ✅ | `/buy`、`/payment-success` 已有 noindex | 当初想到了，漏了 admin/login |
| ✅ | `/console` 302 跳转 | 无索引风险 |
| ✅ | www 子域无解析、主站 http→308+HSTS、图片 alt 齐全、TTFB ~0.44s | 无需处理 |

### 本轮已实施

- `/admin`：`noindex, nofollow, noarchive`（不索引 + 不顺链爬内部路径 + 不留快照）
- `/login`：`noindex`
- worker 全站 HTML 响应加 HSTS：`max-age=63072000; includeSubDomains`
  —— **刻意不加 `preload`**（进预加载列表不可逆，等站点稳定运营后再单独决定）

### 验证证据

- 新增 4 条测试（admin ×2、login ×1、HSTS ×1），逐项反向验证真红：
  移除 HSTS → 1 红；移除 admin noindex → 2 红；移除 login noindex → 1 红
- 全量 **2836 passed / 15 skipped**；**四处 tsc**（根 / apps-web / worker / desktop）全干净
  （第 1 轮教训：只跑两处就下结论，被 CI 抓到两个真实类型错误）

### 3. 我自己犯的错：脚本重排 bullet 时误删了 README 表格

Copilot 第 2 轮的 **suppressed** 评论抓到的（inline 是 0、"generated no new comments"，
只有折叠区里这一条）—— **再次印证「suppressed 必须读」这条铁律。**

**原因**：重排 bullet 的脚本用 `re.findall` 提取 5 个 bullet 后，只把
`intro + bullets` 拼回原段落 —— 而表格和 "New brands plug into…" 段位于
bullet **之后**、下个 `##` **之前**，被整段丢弃。

**我为什么没发现**：验收时只查了 bullet 顺序（`grep -oE '^\- \*\*'`），
没查表格是否还在。**验收范围窄于改动范围 = 没验收。**

→ **教训**：用脚本做「段落级重写」时，验收必须查 `git diff --numstat`
（本轮修完是 3+/3-，与预期一致）而不只看自己关心的那几行。
段落重排优先用「只交换 bullet」的窄操作，不要重建整段。

### 待观察

1. GSC「网页索引」里确认 `/admin`、`/login` 不出现在已收录清单（若此前已被收录，noindex 生效需等重新抓取）
2. 付费站 HTTP 明文：HSTS 只对**回访过 HTTPS 的浏览器**生效；首次 http 访问仍会明文命中。
   **仍需在 Cloudflare 侧开 “Always Use HTTPS”**（Rules → Settings，一键，零风险）—— 需要账号操作
3. 主站英文版仍未做（第 1 轮起就在待办，等中文基线数据）


## 第 3 轮（2026-08-04）：第一篇内容页（需求来自真实社区反馈）

### 需求证据（不是猜的）

linux.do 开源推广帖发布 4 小时：**250 浏览 / 12 赞 / 5 条实质回帖**。回帖解码：

| 用户 | 诉求 | 性质 |
|---|---|---|
| Reso1mi（追问 2 轮） | 转存成功后要 hook 带出 `{网盘, 目录, 文件名}`，去调 OpenList 做离线下载/同步/刷新媒体库 | **产品缺口**（本轮不做：需要 pending+ack 事件队列，非简单 webhook；等对方发 issue 再从架构谈） |
| 阿呸 | 「115 搞了好几年，docker 跑了好几个 115 相关的东西」→ 立刻部署 | **核心用户画像确认**：115/夸克老玩家 |

→ 结论：目标用户是「已经在用网盘 + 会折腾 docker」的人，他们的第一个决策点是**选哪个网盘**。

### 本轮已实施

**新页面** `site/guides/which-cloud-drive/`（首个内容页，主站从单页站变成可扩展内容站）

- 核心资产：**实测资源量数据**（夸克 523 / 115 461 / 光鸭 361 / 123 120 / 天翼 63），带完整采样口径（2026-07、6 部片、单 PanSou 实例、频道会影响结果）—— 这是通用 AI 写不出来的独家数据
- 能力边界表：谁吃分享链接、谁只吃磁力（光鸭 v1 不转存分享链接这个坑）
- 决策表：按「要资源最多 / 要磁力兜底 / 不想花钱 / 只追剧集」给建议
- 数据与 README 逐个数字核对一致（有脚本验证）
- 明写「数据会过时」+ 采样时间，不伪造精度

**内链与收录**
- 首页 FAQ「支持哪些网盘？」加入内链（避免孤岛页）
- `sitemap.xml` 加入指南页
- **JSON-LD 与可见 FAQ 的一致性约束仍然满足**（第 1 轮建立）—— 加内链时去标签后多了一个空格导致不一致，已对齐

**Article 结构化数据**：headline / datePublished / author / publisher / isPartOf

### 踩到并修掉的坑

CSS 相对路径写成 `../style.css`，但文章在 `guides/which-cloud-drive/` 两层目录下，实际需要 `../../` → **404 → 页面变成白底黑字**，与暗色站完全脱节。浏览器实测才发现（`body` 背景 `rgba(0,0,0,0)` vs 首页 `rgb(18,18,18)`）。
**已全部改为根绝对路径**（`/style.css`），以后无论嵌几层都不会再错。

→ 教训：静态多层目录页面，一律用根绝对路径，别用相对路径。

### 验证证据

- 全量 **2836 passed / 15 skipped**；`build:web` 通过
- 浏览器真实渲染核对：背景 `rgb(18,18,18)`、文字白、表格边框走站点变量、3 个 callout、导航/面包屑/页脚齐全、移动端 viewport 正确
- 数据一致性脚本：5 个数字与 README 逐一对齐

### 3. 我自己犯的错：脚本重排 bullet 时误删了 README 表格

Copilot 第 2 轮的 **suppressed** 评论抓到的（inline 是 0、"generated no new comments"，
只有折叠区里这一条）—— **再次印证「suppressed 必须读」这条铁律。**

**原因**：重排 bullet 的脚本用 `re.findall` 提取 5 个 bullet 后，只把
`intro + bullets` 拼回原段落 —— 而表格和 "New brands plug into…" 段位于
bullet **之后**、下个 `##` **之前**，被整段丢弃。

**我为什么没发现**：验收时只查了 bullet 顺序（`grep -oE '^\- \*\*'`），
没查表格是否还在。**验收范围窄于改动范围 = 没验收。**

→ **教训**：用脚本做「段落级重写」时，验收必须查 `git diff --numstat`
（本轮修完是 3+/3-，与预期一致）而不只看自己关心的那几行。
段落重排优先用「只交换 bullet」的窄操作，不要重建整段。

### 待观察（下一轮的决策依据）

1. GSC：这一页多久被发现/收录，出什么词的曝光
2. 若出现「有曝光但排名 11~50」的词 → 那就是下一篇的选题（Google 已认为相关、只差内容）
3. 候选下一篇（暂不写，等数据）：《Docker Hub 拉不动的四个可用镜像站》（国内刚需）、《不用公网 IP 的三种远程访问对比》（带 Connect 商业承接）
4. **暂不写**：115 封号经验（可能招麻烦）、LLM 选型（三个月就过期）


## 第 4 轮（2026-08-04）：内容纠错 + 可读性修复（均由用户直接指出）

### 1. 首篇文章数据过时（上线当天就过时）

**问题**：文章说「123网盘不支持磁力、可用池 120」，实际 123 已支持磁力离线下载。

**代码证据**：
- `pan123-client.ts` 完整离线链路 `resolve → submit → poll`
- `storage-brands.ts` 的 `allowedResourceTypesForKinds("pansou-123")` 返回 `["123","magnet"]`，与 115 的 `["115","magnet"]` **同构**

**我的理解错误**：把 `prowlarr` 与 `pansou-magnet` 两个 kind 名当成两种不同的「磁力能力」。
**磁力就是磁力** —— 不管来自 PanSou 还是 Prowlarr，网盘能离线下载就都能吃。已在 README 与文章写明。

**更新**：123 可用池 `120 → 481`（120 分享 + 361 磁力），**反超 115 的 461**。
同步了 README（描述/表格/排序说明）+ 文章（meta/og/三张表/结论段）+ 修订标注。
有脚本逐项核对文章与 README 数据一致、无残留旧数字。

→ **教训**：带具体数字的内容页是**易腐资产**。产品能力一变，文章就成了错误信息。
以后新增网盘能力时，`README` 表格与 `site/guides/*` 必须同批次更新（本轮已建立核对脚本习惯）。

### 2. Connect 推广横幅「字都看不清」

**根因（浏览器实测）**：`.connect-text a` **此前没有任何 CSS 规则** → 浏览器默认
`rgb(0,0,238)` 纯蓝（访问过变紫），压在深绿渐变底上几乎不可读。

| 项 | 修前 | 修后 |
|---|---|---|
| 链接 | `rgb(0,0,238)` 无下划线 | `var(--accent)` 对比度 9.76 + 常显下划线 |
| 正文 | `#b3b3b3` 对比度 8.93 / 14px | `#cbcbcb` 对比度 **11.55** / 14.5px |

链接加下划线是刻意的：不让颜色单独承载「这是链接」这一信息，色觉障碍用户同样可辨。

**过程中踩的坑**：新加了第二条 `.connect-text p`，但它在原规则**之前** —— 同优先级
后者胜，改动看似无效。**必须浏览器实测才发现**（computed style 值没变）。
已去重、直接改原规则，注释写明防再犯。

### 3. 我自己犯的错：脚本重排 bullet 时误删了 README 表格

Copilot 第 2 轮的 **suppressed** 评论抓到的（inline 是 0、"generated no new comments"，
只有折叠区里这一条）—— **再次印证「suppressed 必须读」这条铁律。**

**原因**：重排 bullet 的脚本用 `re.findall` 提取 5 个 bullet 后，只把
`intro + bullets` 拼回原段落 —— 而表格和 "New brands plug into…" 段位于
bullet **之后**、下个 `##` **之前**，被整段丢弃。

**我为什么没发现**：验收时只查了 bullet 顺序（`grep -oE '^\- \*\*'`），
没查表格是否还在。**验收范围窄于改动范围 = 没验收。**

→ **教训**：用脚本做「段落级重写」时，验收必须查 `git diff --numstat`
（本轮修完是 3+/3-，与预期一致）而不只看自己关心的那几行。
段落重排优先用「只交换 bullet」的窄操作，不要重建整段。

### 待观察

1. 这一页已被 sitemap 收录，GSC 数据仍在等（第 3 轮起）
2. **建议在 linux.do 帖子里回帖挂这篇文章链接** —— 有人问「选哪个网盘」时正好用，帖子还活着，导流效率最高
3. 下一篇选题仍等 GSC 的「有曝光但排名 11~50」词
