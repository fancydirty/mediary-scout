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

### 待观察

1. GSC「网页索引」里确认 `/admin`、`/login` 不出现在已收录清单（若此前已被收录，noindex 生效需等重新抓取）
2. 付费站 HTTP 明文：HSTS 只对**回访过 HTTPS 的浏览器**生效；首次 http 访问仍会明文命中。
   **仍需在 Cloudflare 侧开 “Always Use HTTPS”**（Rules → Settings，一键，零风险）—— 需要账号操作
3. 主站英文版仍未做（第 1 轮起就在待办，等中文基线数据）
