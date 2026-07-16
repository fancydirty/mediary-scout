# media-track TMDB 代理 Worker

把 TMDB 元数据请求经此 Worker 代理:注入作者的 TMDB read token、KV 缓存(电影 7d / 电视·搜索 1h)、只代理白名单元数据路径。让自部署用户即使不填自己的 key 也能取元数据。

## 部署(需 `npx wrangler`,已登录)

```bash
# 1. 建 KV namespace,把输出的 id 填回 wrangler.jsonc 的 kv_namespaces[0].id
npx wrangler kv namespace create TMDB_CACHE --config workers/tmdb-proxy/wrangler.jsonc

# 2. 写入作者 TMDB token(值取自项目 .env 的 TMDB_READ_TOKEN)
grep '^TMDB_READ_TOKEN=' .env | cut -d= -f2- | tr -d '"' \
  | npx wrangler secret put TMDB_READ_TOKEN --config workers/tmdb-proxy/wrangler.jsonc

# 3. 部署。wrangler.jsonc 里声明了 custom domain(tmdb-proxy.mediaryscout.app,
#    要求该 zone 在同一 Cloudflare 账号),部署时自动建 DNS + 证书;
#    workers.dev URL 同时保留,旧版本客户端继续可用
npx wrangler deploy --config workers/tmdb-proxy/wrangler.jsonc
```

把部署 URL 填入 `apps/web/lib/workflow-runtime.ts` 的 `DEFAULT_TMDB_PROXY_BASE_URL`(用 custom domain 而非 `*.workers.dev`——后者在部分国内运营商被整域阻断,见 #83)。

## 校验

```bash
# 第一次 X-Cache: MISS;第二次 X-Cache: HIT(KV 缓存 + 作者 key 注入都通)
curl -s -D - "https://<部署URL>/movie/278?language=zh-CN" -o /dev/null | grep -i x-cache
curl -s -D - "https://<部署URL>/movie/278?language=zh-CN" -o /dev/null | grep -i x-cache
curl -s -o /dev/null -w "%{http_code}\n" "https://<部署URL>/account/x"   # 白名单外 → 404
```

## 防滥用

- **KV 缓存**是主力:绝大多数重复查询不回源,作者 key 调用量近乎不增。
- **限流**:在 Cloudflare dashboard → 该 Worker → Settings 加 Rate limiting 规则(建议 per-IP 60 req/min)。

## 测试

纯函数 handler(`src/handler.ts`)依赖全注入(KV/fetch),单元测试 `src/handler.test.ts` 由仓库根 `npm test`(vitest)自动发现。类型:`npx tsc -p workers/tmdb-proxy/tsconfig.json --noEmit`。
