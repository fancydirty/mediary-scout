# 三站互链 / SEO / 隐私防护 —— 已实测的发现与待办

日期 2026-07-30。以下每条都由我亲自 curl 实证，不是子代理转述。

## 🔴 P0 隐私风险（已实证，未修复）

**用户私有实例子域完全没有 noindex 防护。**

实测 `https://dirtyfancy.mediaryconnect.app/`：
- `X-Robots-Tag` 响应头：**无**
- `<meta name="robots">`：**无**
- `/robots.txt`：**307 跳转到 /login** —— 爬虫拿不到任何 robots 指令

后果：每个付费用户的私有实例都可能被 Google 索引。slug 是用户自选（可能含真名），
被索引即隐私事件，且移除有滞后、信任损失不可逆。

**关键认知（Google 官方）**：`robots.txt` 的 `Disallow: /` **不能**阻止索引 ——
被屏蔽的 URL 仍可能因外链被索引，只是显示无描述；而且屏蔽后爬虫**读不到** noindex。
所以 slug 主机上**绝对不要** `Disallow: /`，必须是「允许抓取 + noindex」。
来源 https://developers.google.com/search/docs/crawling-indexing/block-indexing

### 为什么我修不了（已查证）
`wrangler.jsonc` 的 routes 只挂 `mediaryconnect.app` + `beta.mediaryconnect.app`，
**slug 子域流量直接进 Cloudflare 隧道、不经过 worker**，所以 worker 代码加不了这个头。

且 `token.txt` 第 17 行的 provisioner token（键名 `scout-connect-provisioner-token`，
注意键名带连字符，用 `awk -F= 'NR==17{print substr($0,index($0,"=")+1)}'` 取，
`sed 's/^[A-Z_]*=//'` 取不到）**只有 Tunnel + DNS 权限，没有 Zone Rules 权限** ——
读 `http_response_headers_transform` entrypoint 返回 `Authentication error`。

### 两条修复路径（择一或都做）

**路径 A（推荐，边缘生效，不依赖用户升级）** —— 需用户在 CF 后台操作，
或给一个带 `Zone > Config Rules / Transform Rules > Edit` 权限的 token。

zone `mediaryconnect.app` (`d2680d74d4f6c2d555f07b149338d10c`)
→ Rules → Transform Rules → Modify Response Header → Create rule

表达式（排除营销主机，其余全部命中）:
```
(http.host wildcard "*.mediaryconnect.app")
and not (http.host in {"mediaryconnect.app" "www.mediaryconnect.app" "beta.mediaryconnect.app"})
```
动作: Set static → `X-Robots-Tag` = `noindex, nofollow, noarchive, nosnippet`

优点:对所有 slug 主机、所有响应(HTML/JSON/静态/登录页/错误页)统一加头,
**与用户跑的 Scout 版本无关** —— 旧镜像也受保护。

**路径 B（补充，需用户升级镜像）** —— `apps/web` 对所有响应加
`X-Robots-Tag: noindex, nofollow`。与 A 重复是有意的:A 可能被误删或表达式写错,
B 是第二道;且 B 能保护「用户自带域名裸奔部署」(那时没有我们的 CF zone 兜底)。

### 验收（没跑过不算做完）
```bash
curl -sSI https://dirtyfancy.mediaryconnect.app/ | grep -i x-robots-tag
# 期望: x-robots-tag: noindex, nofollow, noarchive, nosnippet
```

### 附带风险提示
若用 CF for SaaS 逐主机签证书,每个 slug 会**公开出现在 CT 日志**(crt.sh 可查)。
通配证书则不会。若 slug 由用户自选可能含个人信息,文案应提示「slug 会公开可查,别用真名」。

---

## 🟠 P1 已实证的其他问题

**① 主站唯一的 Connect 链接指向 beta,不是 apex(权重灌错地方)**
实测 `mediaryscout.app` 里 `href="https://beta.mediaryconnect.app"` × 1,
指向 apex 的 **0 条**。而 beta 是应该 noindex 的报名表单页。
→ 改指 apex(正文句内锚文本带品牌+关系语义),beta 那条加 `rel="nofollow"`。

**② apex 的 HEAD 请求返回 JSON(真 bug)**
```
HEAD https://mediaryconnect.app/ → content-type: application/json; charset=utf-8
GET  https://mediaryconnect.app/ → content-type: text/html; charset=utf-8
```
Worker 的 HEAD 路径掉进 API 分支。部分抓取器/校验器先发 HEAD,会误判为非 HTML。
修法:HEAD 走与 GET 相同 handler,只丢弃 body。

**③ apex 的 SEO 基础设施全空(实测)**
无 `meta description`、无任何 OG、无 `twitter:card`、无 `canonical`、无 JSON-LD;
`<title>` 仅「Mediary Connect」7 字符;`/sitemap.xml` 404;
`/robots.txt` 200 但**去注释后零有效指令**(纯 CF content-signals 样板注释)。
→ 后果:连品牌词搜索都拿不稳。有人在 GitHub/周刊看到后去搜「mediary connect」,
SERP 返回一个无描述裸标题。这是漏斗上最廉价的漏。

**④ beta 报名页未 noindex**(实测无 `X-Robots-Tag`、无 `meta robots`)
→ 加 `<meta name="robots" content="noindex, nofollow">` + HTTP 头双保险。
robots.txt 仍须 `Allow: /`(否则读不到 noindex)。

**⑤ demo 站零回链**(子代理实测,我未复验)
`demo.mediaryscout.app` 已被索引,但全站唯一出站链接是 GitHub,
**没有任何链接回主站**。已索引站的权重完全没回流。
→ demo banner 加 `<a href="https://mediaryscout.app">Mediary Scout 官网</a>`。
「官网」这个词帮 Google 判断哪个域名是主实体(现在两站都叫 Mediary Scout,存在实体混淆)。

---

## ⚠️ 对「互链一定能增强流量」的诚实评估

用户假设:「这俩站已获索引,链上去一定也能增强我们的流量」。
**跨域链接传权重是真的**(Google 不因同一所有者折扣),但推理有两处断裂:

1. **被索引 ≠ 有权威度可传。** 主站自己的权威度主要来自阮一峰周刊 + HelloGitHub 收录
   + GitHub 仓库,是**个位数量级**可传递权重,不是可再分配的储备。链给 Connect 只会让它
   **被发现和被索引** —— 而这一步提交 sitemap 也能做到。

2. **被索引和有流量之间隔着搜索需求量。** Connect 的核心词需要「先知道 Mediary Scout 存在」,
   **Connect 的自然流量天花板 ≈ Scout 的品牌知名度**,不是 SEO 技术问题。
   互链改善的是「已在 Scout 生态内、有远程访问痛点」的转化路径 —— 那是**站内导流**,
   不是搜索流量增强。

**现实预期**:做完全套技术方案,3 个月内 Connect 从自然搜索获得的点击量级是
**每天 0-5 次**。互链对这个数字的贡献接近 0;它的真实价值是
①让主站已有访客找到 Connect ②让品牌词搜索正确返回定价页。

**link scheme 风险可忽略** —— 3 个同产品家族域名的导航型互链是正常产品站结构,
与 PBN 不在一个量级。但要避免:每站页脚塞 5-8 条重复锚文本;锚文本全写成目标关键词。
当前方案锚文本分布:品牌词 5、功能描述式 3、导航式 2、零 exact-match 堆砌 —— 安全。

---

## 优先级（子代理建议 + 我的判断，一致）

| 序 | 事项 | 理由 |
|---|---|---|
| **1** | slug 子域 noindex 边缘规则 | **唯一「不做会有真实损害」的**;其余都只是「不做则少赚」。分钟级、不依赖代码、不依赖用户升级。风险收益比极端不对称 |
| **2** | apex 的 title + description + canonical | 当前连品牌词都吃不住。改一段 HTML 字符串,收益即时确定。比互链更优先 —— metadata 是「让已找到你的人正确理解你」(转化率高一个量级),互链是「让没找到的人可能找到」(绝对量级近 0) |
| **3** | 主站 banner 改指 apex + demo 加回链 | 互链方案里唯一有实质效果的部分,都是一行改动 |

其余(sitemap、JSON-LD、hreflang、法务页 noindex、内容资产)正确但收益递减,可等。
**特别是 JSON-LD**:`Service` 类型在 Google 没有对应富结果,不会带来任何 SERP 装饰,
它的收益只是实体消歧 + AI 摘要取材准确。别被「结构化数据」名头骗去排前三。

## schema 类型选择（若做 JSON-LD）
- ❌ `SoftwareApplication` 作主类型错误:Connect 不是软件,用户不下载不安装。
  误用会让 Google 把 Connect 和 Scout 当成两个**竞争**软件实体。
- ✅ `Service`(主) + `Offer`(四档) + **`isRelatedTo → SoftwareApplication`**(关键一笔,
  这是「我是 Scout 的附加服务」在结构化数据层的表达)。
- 价格用 `UnitPriceSpecification.billingDuration` + `unitCode: MON` 表达「预付 N 个月」,
  **不要**用 `Subscription`/`priceType: subscription` —— 那声明周期性扣款,与「无自动续费」冲突。
- 创始价用 `LimitedAvailability` + `inventoryLevel: 100`,**售完必须改 `SoldOut` 或移除**。
- 不要 `aggregateRating`/`review`:没真实评价不能造(违反 Google 结构化数据政策)。
