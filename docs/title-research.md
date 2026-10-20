# 可选：查作品的其他译名

同一部作品可能有几个中文译名。例如 `Silent` 也叫「静雪」，只搜其中一个名字时，资源源可能返回很少的结果或同名的其他作品。

可以让获取 agent 用 [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) 查公开网页，核对其他译名，再把找到的名字交给原来的 `searchResources` 搜资源。网页只作参考；PanSou / Prowlarr 仍负责返回可转存的候选，TMDB 仍决定目标作品和集数。

在部署目录的 `.env` 中加入：

```dotenv
MEDIA_TRACK_TITLE_RESEARCH=parallel
```

Docker Compose 用户运行 `docker compose up -d web` 让设置生效。直接运行源码时，把同名环境变量传给服务进程并重启。桌面版需要从设置了该环境变量的进程启动；目前没有对应的设置页开关。

默认关闭。删除该变量或设为 `off` 并重启，就会撤掉两个网页工具，不再向 Parallel 发请求。已有 PanSou 地址、Prowlarr 配置和网盘权限照常生效；暂存清理及中断后的收尾也不会获得网页工具。

开启后，agent 在已有名字搜得少或有歧义时，可以用 `researchTitle` 查译名，用 `readTitleReference` 读取来源页。搜索使用 Fast 模式，无需 Parallel 账号或 API key。每次获取最多共四次网页搜索/读取，每次最多等待 20 秒；失败会作为工具错误返回，agent 仍可使用已有资源证据。服务有免费额度限制，并非无限使用。

查询词和读取的网页地址会发送给 Parallel；只用于公开的作品名称、年份和来源页，不要放入私密留言、网盘信息或凭据。网页内容是不可信的参考材料，不能作为转存候选，也不能证明已经获取到资源。

## English

Set `MEDIA_TRACK_TITLE_RESEARCH=parallel` in the service environment and restart (Compose: `docker compose up -d web`). The acquisition agent can research alternate/localized titles with free, anonymous Parallel Search MCP, using Fast mode for search, then retry those titles through the existing resource search. No Parallel account or API key is required. The two tools are off by default; remove the variable or set it to `off` to disable them. Desktop users must launch the app with the variable set; there is no settings-page toggle.

Queries and source-page URLs are sent to Parallel. Only public title information belongs in these tools. They share a four-call budget per acquisition, with a 20-second deadline per call. Errors and free-tier limits return tool evidence; the existing resource search remains available. Web references never become transfer candidates or replace TMDB metadata, and recovery runs do not get web tools.
