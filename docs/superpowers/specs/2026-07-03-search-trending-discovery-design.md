# 搜索页近期热门发现区 — 设计文档

> 关联 issue #95。brainstorming 产出,用户已认可方向(2026-07-03)。

## 目标(一句话)

搜索页未搜索时的空白区改为「近期热门」发现区:三个按库类型对齐的榜单(电影/剧集/动漫),数据由 CF Worker 每日定时刷新缓存,用户打开**不触发任何 TMDB 请求**;点击海报=用该片名发起搜索。

## 背景与现状

- 搜索页(`apps/web/app/page.tsx` 的 `SearchResults`)在 `query` 为空时渲染一个占位符「输入目标名称 / 搜索后才会请求元数据」,占满整个内容区——一片死白,零发现引导(issue #95、用户反馈)。
- 有结果时是 2 列候选卡片(海报 + 标题 + 年份·类型 + 简介 + 获取按钮)。
- TMDB 访问已有三通道 fallback(用户 key → env → 作者 CF Worker `media-track-tmdb-proxy`,见 `apps/web/lib/workflow-runtime.ts` 的 `getTmdbAccesses`);Worker 是一个带 KV 缓存 + 端点白名单的只读代理(`workers/tmdb-proxy/src/handler.ts`)。
- 海报全站直连 `image.tmdb.org`(`activity-feed.tsx` 等);已有 `posterPath ?` 条件兜底占位。

## 榜单类型(细分决策)

三个 Tab,对齐产品的 `电影/电视剧/动漫` 三类库:

| Tab | 标签 | TMDB 端点(含固定 query) | 语义 |
| --- | --- | --- | --- |
| movie | 热门电影 | `trending/movie/week?language=zh-CN` | 本周趋势 |
| tv | 热门剧集 | `trending/tv/week?language=zh-CN` | 本周趋势 |
| anime | 热门动漫 | `discover/tv?language=zh-CN&sort_by=popularity.desc&with_genres=16&with_original_language=ja` | 当前热度(TMDB 无 trending 动漫端点,日语动画按热度排是标准替代;实测返回良好) |

- 默认 Tab = `movie`。Tab 由 URL query `?trending=<movie|tv|anime>` 控制(纯 `<Link>` 软导航,与现有 `?tab`/`?filter` 一致,无客户端状态)。
- 每 Tab 取前 12 条(`results.slice(0, 12)`);trending 每页 20 条,足够。
- **不做** top_rated/now_playing/upcoming 等多 rail(YAGNI;三类型细分已是最贴产品的粒度)。未来若要扩展,在此表加行即可。

## 数据流与缓存(用户打开零 TMDB)

```
TMDB (trending/movie, trending/tv, discover/tv-anime)
        │  Worker Cron scheduled(),每天一次
        ▼
CF Worker KV  ── 3 个 key(= cacheKeyFor(canonical URL))
        │  用户访问 → proxy 命中 KV → 永不触达 TMDB
        ▼
Next getTrending(kind) → TrendingRow(server component) → 搜索页空态
```

### Worker 侧(`workers/tmdb-proxy`)

1. **白名单**:`ALLOWED_PREFIXES` 加 `"trending/"`(`discover/` 已在内)。
2. **Cron Trigger**:`wrangler.jsonc` 加 `"triggers": { "crons": ["0 22 * * *"] }`(UTC 22:00 ≈ 北京次日 06:00,与每日巡检同节奏)。
3. **`scheduled()` handler**(`src/index.ts`):遍历三个 canonical URL,fetch TMDB → `kv.put(cacheKeyFor(url), body, { expirationTtl: 25h })`。TTL 25h > 24h 刷新间隔,做兜底;即便某天 Cron 失败,旧数据多撑 1 小时而非立即失效。
4. **canonical URL 单一来源**:三个榜单 URL 定义为 `TRENDING_FEEDS` 常量(path + 固定 query),`scheduled()` 写入与前端读取都用同一份,保证 `cacheKeyFor` 命中(cacheKey = path + 排序后 query)。
5. Cron 是**预热**,非唯一来源:即使 KV 未命中(冷启动/刚部署),前端请求仍会走 proxy 的反应式 miss 逻辑正常回源(白名单已放行),只是当天第一次由某访客触发一次——Cron 存在时这一次也不会发生。

### Next 侧

- 新增 `apps/web/lib/trending.ts`:
  - `TRENDING_KINDS`(movie/tv/anime → 标签 + 端点 path/query)常量。
  - `getTrending(kind): Promise<TrendingCard[]>`:用 `getTmdbAccesses` 拿通道,fetch 对应端点,`mapTrendingResults` 映射为 `TrendingCard`。任何失败(网络/解析/空)→ 返回 `[]`(静默降级,绝不抛)。
  - `mapTrendingResults(raw, kind): TrendingCard[]`(**纯函数,单测重点**):TMDB result → `{ tmdbId, title, year, posterPath, mediaType }`;兼容 movie(`title`/`release_date`)与 tv/anime(`name`/`first_air_date`);缺 `poster_path` 保留(前端兜底);过滤无 `id`/无标题项。
- `TrendingCard`:`{ tmdbId: number; title: string; year: number | null; posterPath: string | null; mediaType: "movie" | "tv" }`(anime 的 mediaType 仍是 `tv`——它是 TV 型标题,与库模型一致)。

## 组件与渲染

- 新增 `apps/web/components/trending-row.tsx`(server component):
  - props:`{ activeKind: TrendingKind; basePath: string }`。
  - `const cards = await getTrending(activeKind)`;`cards.length === 0` → 渲染**原占位符**(退回「输入目标名称」),即静默降级不留空段。
  - 否则:标题「近期热门」+ 三个 Tab 药丸(`<Link href="{basePath}?trending={kind}">`,active 态高亮)+ 右侧「每日更新 · 来自 TMDB」注记 + 海报网格。
  - 海报卡:`<Link href="{basePath}?q={encodeURIComponent(title)}">` 包裹;海报 `posterPath ? <img src="image.tmdb.org/t/p/w342{posterPath}"> : <film-icon 占位>`;下方标题(单行省略)+ `年份 · 类型`;左上角 `#{index+1}` 排名角标。
  - 网格:`repeat(auto-fill, minmax(140px, 1fr))`,响应式(桌面 6/行,窄屏自适应),复用现有 `.candidate-grid`/poster 样式风格,新增少量 class 到 `globals.css`。
- 接线 `page.tsx`:
  - `HomeSurface` 读 `?trending`(默认 movie)与既有 `?q`。
  - `SearchResults` 的 `searchView.state === "empty"` 分支:把当前的 `quiet-state` 占位符换成 `<TrendingRow activeKind={...} basePath={...} />`(有 query 时该分支本就不渲染,零干扰)。
  - Tab 切换要保持在搜索页空态:`?trending=tv` 不带 `?q`,天然停留在空态。

## 错误、降级与边界

- `getTrending` 任何失败 → `[]` → 组件渲染原占位符。搜索框与搜索流**完全不受影响**。
- Demo 只读站:trending 纯读、不写 DB,可正常展示(增强首屏),无写入风险;`isDemoMode` 无需特判。
- 海报被墙(`image.tmdb.org` 在部分墙内网络不可达,软路由实例全站海报皆空):trending 作为首屏会显示一排 film-icon 占位。**这是全站既有问题**(搜索结果卡同样受影响),不在本功能范围;海报代理是独立议题,本次不揽,仅在文档记录。
- 多网盘:trending 是全局发现(与具体网盘无关),`basePath` 仅用于点击后把搜索落在当前工作区,不影响榜单数据本身。

## 测试

- `workers/tmdb-proxy/src/handler.test.ts`:
  - `trending/movie/week` 进白名单(此前 404 → 现 200/缓存路径)。
  - `scheduled()` 遍历 `TRENDING_FEEDS`,对每个 URL 调 `kv.put`,key = `cacheKeyFor(url)`,TTL = 25h(注入 fake fetch + fake KV,断言写入)。
- `apps/web/lib/trending.test.ts`(纯函数):
  - `mapTrendingResults` movie 形状(title/release_date/poster_path → 卡片)。
  - tv/anime 形状(name/first_air_date)。
  - 缺 poster_path 保留、缺 id/标题过滤、`results` 缺失 → `[]`。
- 组件/端到端:preview 渲染热门网格 + 点海报跳 `?q=`;真机 e2e(落地页可见热门、点击进结果流)。
- 全量 vitest + 根/apps-web 双 tsc + `npm run build:web` + worker 独立 vitest(`workers` 已在根 vitest include)。

## 文件清单

- 改 `workers/tmdb-proxy/src/handler.ts`(白名单 + scheduled + TRENDING_FEEDS)、`workers/tmdb-proxy/src/index.ts`(注册 scheduled)、`workers/tmdb-proxy/wrangler.jsonc`(crons)。
- 新增 `apps/web/lib/trending.ts` + `apps/web/lib/trending.test.ts`。
- 新增 `apps/web/components/trending-row.tsx`。
- 改 `apps/web/app/page.tsx`(空态接线)、`apps/web/app/globals.css`(海报网格样式)。
- 改 `workers/tmdb-proxy/src/handler.test.ts`。

## 部署注记

Worker 改动需 `wrangler deploy`(作者账号);Cron 首次部署后次日生效,当天前端走反应式回源不受影响。Next 侧改动随实例 `git pull` + rebuild 上线。
