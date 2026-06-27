# v0.3.0 — 光鸭云盘支持 + LLM 真 BYO(任意 OpenAI 兼容服务)

> 草稿,供维护者发 GitHub Release 时使用。

继 v0.2.0(2026-06-25)之后的累积更新。两件大事:**接入第三个网盘品牌「光鸭云盘」**(磁力 / 离线优先),以及**把 LLM 改成真正的 BYO** —— 去掉硬编码的 MiMo 默认端点,改用标准 `Authorization: Bearer` 发 key,任何 OpenAI 兼容服务(DeepSeek / OpenAI / …)都能直接用,不再 401。

## 网盘:接入光鸭云盘(第三个品牌)

- **#50** 接入**光鸭云盘(GuangYaPan)**作为第三个网盘品牌(继 115、夸克)。迅雷系网盘,走**磁力 / 离线下载优先**路径:把 PanSou(magnet)+ 可选 Prowlarr 的磁力 / ed2k / BT 候选,经光鸭离线任务 API 拉进你自己的盘(与 115 离线路径同理)。鉴权用 `access_token` + `refresh_token`(过期自动续期、续期后回写)。v1 **不**转存 115 / 夸克 / 光鸭的分享链(按设计明确报错 `GUANGYA_ONLY_MAGNET`)。纯加法,115 / 夸克零影响。
  - 光鸭 API 集成基于开源 [AList](https://github.com/AlistGo/alist) 的 `guangyapan` driver(逆向来源,致谢)。
  - 连接教程见 [docs/deploy.md → 光鸭云盘连接](deploy.md#光鸭云盘guangyapan连接)。

## LLM:真 BYO(任意 OpenAI 兼容服务)

- **#51(closes #49)** **LLM 真 BYO**:去掉硬编码的 MiMo 默认端点,改用标准 `Authorization: Bearer <key>` 发请求 —— **修复 DeepSeek / OpenAI 等所有 OpenAI 兼容服务此前一律 401 的问题**。同时:LLM **未配置 / 401 时给出友好报错**,不再抛晦涩的底层错误。
- **#53(closes #49)** **点击「获取」时 LLM 预检** —— 未配置直接提示,不再把任务入队空转(避免「点了没反应、队列里一堆失败」)。
  > 注:#53 可能在发版前刚合入,本次一并纳入。

## 获取与活动页

- **#52** 活动页全季获取卡片显示**季号列表「第 1 / 2 / 3 / 4 季」**,而非误导的「第 1 季」(一次性收多季时如实呈现实际在收的季)。

## 部署与基础设施

- **#47(closes #46)** 修复**连不上 Docker Hub 时构建第一步就卡死** —— 首次 `docker compose build` 在拉基础镜像处挂住(`auth.docker.io ... i/o timeout`)。加了镜像加速文档(Docker Desktop / Linux 分别说明,面向国内网络)。
- **#48** 未连任何网盘时,后台 worker **静默跳过**获取轮询,不再每 3 秒刷一行 `PAN115_COOKIE is required` 日志(新装、还没连盘时日志干净)。

## 试用

- 免安装只读 demo: https://mediary.dirtyfancy.sbs
- 自部署:见 [README](../README.md) + [docs/deploy.md](deploy.md)
