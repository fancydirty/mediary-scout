# Deploy Mediary Scout

> **English summary.** Self-host with one command — `docker compose up -d` brings up web (Next.js + in-process worker) + Postgres + a bundled PanSou. Open `http://<host>:3000`, go to Settings, scan-login your 115 / Quark drive (or paste a 光鸭 / GuangYaPan `access_token` + `refresh_token`), add an OpenAI-compatible LLM endpoint, and you're running. To reach it from your phone / TV / on the go, use **Tailscale** (private mesh — safest) or a **Cloudflare Tunnel** (public HTTPS, no public IP). **Never expose `:3000` raw to the internet.** Full walkthrough below (Chinese).

一行命令起整套:**web(Next + 进程内 worker)+ Postgres + 自带 PanSou**。本指南覆盖:选宿主 → compose 起服务 → 从自己的设备访问 → 安全/升级。

## 目录
- [选择你的宿主](#选择你的宿主)
- [Compose 快速开始](#compose-快速开始)
- [光鸭云盘(GuangYaPan)连接](#光鸭云盘guangyapan连接)
- [想跑真实获取还需要](#想跑真实获取还需要)
- [可选增强](#可选增强)
- [从你的设备访问](#从你的设备访问)
- [安全](#安全)
- [国内构建加速](#国内构建加速连不上-docker-hub)
- [升级](#升级)

## 选择你的宿主

任何能跑 Docker 的常开机器都行。挑一个:

- **NAS(群晖 / 威联通 / unRAID)** —— 最推荐(常开、省电)。群晖用 Container Manager、威联通用 Container Station、unRAID 用 Community Apps 的 Compose Manager 插件,把本仓库 `docker-compose.yml` 贴进去起即可。`pgdata` 卷落在阵列/SSD 上。
- **软路由(iStoreOS 等)** —— 作者实测在带镜像加速的 iStoreOS 上一把过。用 Docker 插件或 ssh 跑 compose;软路由存储小,`pgdata` 指到外挂盘。
- **闲置 PC / Linux 主机** —— 装 Docker + Compose 插件,`git clone` 后 `docker compose up -d`。睡眠会停巡检,建议设为常开。
- **VPS** —— 跑得动;115/夸克转存走网盘服务端,VPS 带宽不影响转存速度,只要能连上网盘 API 即可。⚠️ VPS 在公网,务必看[安全](#安全)。

下面的 compose 步骤在以上任何宿主都一样。

## Compose 快速开始

```bash
git clone https://github.com/fancydirty/mediary-scout && cd mediary-scout
docker compose up -d        # 首次会构建 web 镜像,几分钟
```

打开 `http://<你的主机>:3000`:
1. **设置 → 网盘**:115 扫码登录(cookie 持久化到数据库,后续自动转存);夸克在设置选夸克品牌粘贴 cookie;光鸭云盘在设置选光鸭品牌粘贴 `access_token` + `refresh_token` 两个值(见 [光鸭云盘连接](#光鸭云盘guangyapan连接))。
2. 就这样。**TMDB 元数据经作者 CF Worker 开箱即用**(想用自己额度可在设置填 TMDB key);**PanSou 网盘搜索源已自带**。

### 组成 / 端口

| 服务 | 镜像 | 说明 |
|---|---|---|
| `web` | 本仓库 `Dockerfile` | Next.js + 进程内 worker(`instrumentation.ts` 自启),`:3000` |
| `postgres` | `postgres:16-alpine` | 持久卷 `pgdata`;表首次查询自建,无需迁移 |
| `pansou` | `ghcr.io/fish2018/pansou-web` | 网盘搜索源,compose 内经服务名 `http://pansou` 调用 |

### 覆盖配置

`docker-compose.yml` 的 `environment:` 已设好库连接、PanSou 地址、adapters。要覆盖额外项(TMDB / 115 cookie / LLM / Prowlarr / CID),在仓库根放 `.env`(参照 `.env.example`)——compose 会自动加载(缺失也无妨)。

## 光鸭云盘(GuangYaPan)连接

光鸭云盘(迅雷旗下,2026 年上线)是第三个支持的网盘品牌。它走**磁力 / 离线下载优先**路径:agent 把 PanSou(magnet 类型)与可选 Prowlarr 找到的磁力 / ed2k / BT 候选,经光鸭的离线下载 API 拉进你自己的盘——和 115 的离线任务路径同理。

> ⚠️ **v1 仅支持磁力 / 离线。** 光鸭目前**不**转存 115 / 夸克 / 光鸭自己的**分享链**(这类候选会按设计明确报错 `GUANGYA_ONLY_MAGNET`,不静默失败)。所以光鸭和 **Prowlarr 搭配最好**(磁力覆盖更全)。
>
> 和所有获取一样,光鸭也需要先配好 **AI 模型(LLM)**,见下文「[想跑真实获取还需要](#想跑真实获取还需要)」。

光鸭用 **`access_token` + `refresh_token`** 鉴权(不是 cookie、不是扫码)。`access_token` 约 2 小时过期,`refresh_token` 会在过期时自动续期,续期后的新 token 自动写回该盘,无需你手动重粘。

### 1. 在设置页粘 token

**设置 → 网盘连接 → 选「光鸭云盘」标签页**。最省事:把下面 Console 打印出来的内容(打印的两段、或它复制到剪贴板的 JSON,都行)整段粘到**第一个框**,再点框下方的 **「识别并拆分 token」**,两个框会自动填好;确认无误后点「连接光鸭」。(也可以仍按老办法手动把两个值分别粘进两个框。)连接时会用 token 校验登录态、并在你盘里建好 `Mediary Scout/{Movies,TV,Anime}` 分类目录。

### 2. 怎么拿到这两个 token

1. 用浏览器登录光鸭云盘网页版:**[https://www.guangyapan.com](https://www.guangyapan.com)**(或 app.guangyapan.com),确保已登录。
2. 按 **F12** 打开 DevTools → 切到 **Console(控制台)** 标签。
3. 粘贴并运行下面这段(它从 `localStorage` 里读出登录态。光鸭把凭证存在键 `credentials_<clientid>`,当前 clientid 是 `aMe-8VSlkrbQXpUR`,即键名 `credentials_aMe-8VSlkrbQXpUR`):

   ```js
   (() => {
     const clientId = "aMe-8VSlkrbQXpUR"; // 光鸭 web app 的 client_id
     const raw = localStorage.getItem(`credentials_${clientId}`);
     if (!raw) { console.warn("没找到 credentials_* —— 请确认已登录光鸭网页版后重试"); return; }
     const c = JSON.parse(raw);
     const out = { accessToken: c.access_token, refreshToken: c.refresh_token };
     console.log("accessToken:\n" + out.accessToken);
     console.log("\nrefreshToken:\n" + out.refreshToken);
     try { copy(JSON.stringify(out, null, 2)); console.log("\n(已复制到剪贴板)"); } catch {}
     return out;
   })();
   ```

   > 如果 `credentials_aMe-8VSlkrbQXpUR` 取不到(光鸭后续改了 clientid),在 Console 里跑 `Object.keys(localStorage).filter(k => k.startsWith("credentials_"))` 看实际键名,把后缀换进上面的 `clientId`。

4. 控制台会打印 `accessToken` 与 `refreshToken`(且尝试把 `{accessToken, refreshToken}` JSON 复制到剪贴板)。把打印的两段、或复制的 JSON,整段粘到设置页**第一个框**,点 **「识别并拆分 token」**即可自动填好两个框(不必手动分辨哪段是哪个)。

> 🔒 **别把 token 贴到任何公开地方**(issue、聊天群、截图、粘贴板网站)。它们等同你光鸭账号的登录态;只该出现在你自己实例的设置页里。

### 3. 来源致谢(API 逆向)

光鸭云盘的网盘 API 集成,基于开源项目 **[AList](https://github.com/AlistGo/alist)** 的 `guangyapan` driver(目录 [`drivers/guangyapan`](https://github.com/AlistGo/alist/tree/main/drivers/guangyapan))。该 driver 是本项目逆向光鸭 API 的来源,在此致谢。

## 想跑真实获取还需要

- **AI 模型**(设置 → AI 模型):填一个 OpenAI 兼容的 `baseURL / apiKey / modelId`——agent 靠它决策。不填则获取流程无法规划。
- **115 目录 CID**(`.env` 或环境变量):`TV_SHOWS_CID` / `MOVIES_CID` / `ANIME_CID` 等落盘父目录。

## 可选增强

- **自己的 TMDB key**(设置 → TMDB 元数据):直连你自己的额度,调不通自动回退作者代理。
- **出站代理**(`.env` 设 `HTTP_PROXY` / `HTTPS_PROXY`):墙内想用**自己的 TMDB token / 额度**时用得到。TMDB 的 API 主机(`api.themoviedb.org`)在国内常被单独墙(官网能开 ≠ API 能通),直连不到你的 token 就用不上。给容器配一个能穿透的代理即可让全部出站请求(TMDB / PanSou / Prowlarr)走它:在仓库根 `.env` 里写 `HTTP_PROXY=http://172.17.0.1:7890` 和 `HTTPS_PROXY=http://172.17.0.1:7890`(`172.17.0.1` 是 Docker 默认网关,指向宿主机;端口换成你宿主上代理软件的实际端口,如 Clash 的 7890),再 `docker compose up -d`。`NO_PROXY` 可排除内网地址。**不设代理时行为不变**——TMDB token 留空走作者内置代理依旧开箱即用,这条只为「墙内 + 想用自己 token」准备。
  - **内置代理也连不上时同样用此法**(#83 实例):内置 TMDB 代理托管在 Cloudflare Workers,`*.workers.dev` 域名在部分国内网络/运营商下也会被阻断——症状是搜索报 `All N TMDB access(es) failed: TimeoutError`(N 为通道数,未配 token 时为 1)。此时无论是否有自己的 token,都需要按上面配 `HTTP_PROXY` / `HTTPS_PROXY` 让容器出站走代理。
  - **WSL2 部署注意**(#83 踩坑实录):容器内的 `127.0.0.1` 指容器自身,填 Windows 宿主上的代理要用 WSL2 虚拟网卡的宿主 IP;且 Windows 防火墙常拦截来自 WSL2 虚拟网卡的入站连接(即使代理软件开了「允许局域网连接」),需要放行防火墙或在 WSL2 内起一层转发(监听 0.0.0.0 转发到 127.0.0.1:代理端口),容器再指向 WSL2 自身 IP。
- **Prowlarr**(设置 → 资源提供商):接入索引器聚合,磁力与 PanSou 结果合并,走 115 或光鸭的离线下载落盘(夸克无磁力 API)。
- **换 PanSou 实例**(设置 → 资源提供商):默认用 compose 自带的;想指向别的实例/公共域名在此手填。

## 从你的设备访问

默认 web 只监听宿主的 `:3000`(局域网内手机 / 电视浏览器直接开 `http://<宿主局域网IP>:3000` 即可)。想在外网(手机流量、出门在外)也能用,二选一——**都不需要公网 IP、都别把 `:3000` 裸暴露公网**:

### 方式一:Tailscale(私有 mesh,推荐家用)

最简单也最安全。把宿主和你的手机 / 电脑 / 电视都加入同一个 Tailscale 网络(tailnet),它们之间用稳定私有 IP 互访,不经公网、自动加密。

1. 宿主装并登录:`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`(NAS 多有现成套件/插件)。
2. 手机 / 电脑 / 电视装 Tailscale app,登同一账号。
3. 任意设备开 `http://<宿主的-tailscale-IP>:3000`(或起个 MagicDNS 名字)。

家人也想用:把他们的设备加进你的 tailnet(或用 Tailscale 分享)即可,无需开放任何公网端口。

### 方式二:Cloudflare Tunnel(需要公网 HTTPS 域名时)

想要一个任意设备浏览器都能直接打开的 `https://media.yourdomain.com`,又没有公网 IP——用 Cloudflare Tunnel(`cloudflared`)把宿主**出站**反连到 Cloudflare,路由器不开任何端口、不暴露公网 IP。本仓库的 `docker-compose.yml` 已内置一个**可选** `cloudflared` 服务(`tunnel` profile,默认不启),随栈一条命令起。

前提:一个托管在 Cloudflare 的域名(本指南以 `media.yourdomain.com` 为例)。

**1. 在 Cloudflare 控制台建隧道、拿 token(推荐 dashboard 托管,配置集中、好接 Access)**

- **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**,起个名(如 `mediary`)。
- 连接方式选 **Docker**,**复制那串连接器 token**(`eyJ...` 一长串)。下一步用它,先不用管它给的 docker 命令。
- 建好后进隧道的 **Public Hostname → Add a public hostname**:
  - Subdomain `media`,Domain 选 `yourdomain.com`(→ `media.yourdomain.com`)。
  - **Service:Type = HTTP,URL = `web:3000`**。⚠️ 这里必须填 compose 服务名 `web`,**不是 `localhost`**——`cloudflared` 跑在 compose 网络里,`localhost` 指的是它自己那个容器。
  - 保存。DNS 的 CNAME 由 Cloudflare 自动建,无需手动加记录。

**2. 在宿主放 token、随栈起隧道**

```bash
echo 'TUNNEL_TOKEN=粘贴你的连接器token' >> .env
docker compose --profile tunnel up -d        # 多起一个 cloudflared 容器
docker compose logs -f cloudflared           # 看到 "Registered tunnel connection" 即通
```

隧道通了之后,`https://media.yourdomain.com` 就能从任意设备打开。`.env` 里的 token 不会进 git(`.env` 已被忽略)。

> 隧道连不上 / 老掉线? cloudflared 默认是 `auto`(优先 QUIC/UDP,理论上会回退 HTTP/2)。但有些网络(部分校园网、运营商、严格防火墙)封/限 UDP 时,auto 未必干净回退,隧道就注册不上或老掉线。这时在 `.env` 设 `TUNNEL_TRANSPORT_PROTOCOL=http2` 强制走 TCP 上的 HTTP/2,再 `docker compose --profile tunnel up -d` 重起即可。

**3. ⚠️ 必须加 Cloudflare Access(否则等于把实例裸挂公网)**

Mediary Scout 默认单用户、无登录,公网入口必须靠 Access 这类前置鉴权挡住:

- **Zero Trust → Access → Applications → Add an application → Self-hosted**。
- Application domain 填 `media.yourdomain.com`。
- 加一条 **Allow** 策略,例如 Include = **Emails** = 你自己的邮箱(进站会先要求邮箱一次性验证码登录)。想给家人用就把他们的邮箱也加进白名单。
- 保存后,任何访问 `media.yourdomain.com` 的人都要先过 Access 这关,才能到达应用。

> 想自启:`cloudflared` 容器已 `restart: unless-stopped`,宿主重启会自动拉起;隧道配置在 Cloudflare 侧托管,改公网主机名 / Access 策略都在控制台改,不用动宿主。

## 安全

- 本项目只走**自部署**,作者不托管(见 [distribution-and-legal-positioning.md](distribution-and-legal-positioning.md))。默认单用户、无登录。
- **别在公网裸暴露 `:3000`**。要远程用就走上面的 Tailscale(私有)或 Cloudflare Tunnel + Access(带鉴权)。
- 想多人合用同一实例(各绑各的网盘、各看各的库):设环境变量 `MEDIA_TRACK_MULTI_USER=1` 开多用户模式(出注册 / 登录页)。即便开了多用户,也仍建议放在 Tailscale / Access 之后。

## 多用户与忘记密码

默认单用户、无登录。想让家人 / 朋友合用同一台实例(各绑各的网盘、各看各的库、互相看不见):

1. 设环境变量 **`MEDIA_TRACK_MULTI_USER=1`** 并重启 web(`docker compose up -d web`)。
2. 第一个打开站点的人会看到**认领屏**:设个用户名 + 密码即成**站主**。
   - 如果这台实例**之前已经是单用户、有媒体库了**,认领会**原样接管**现有的库和网盘——不会丢。
3. 之后每个人各自在登录页**注册**自己的账号、连各自的 115 / 夸克。

**忘记密码怎么办**(本项目不发邮件,无需配 SMTP):

- **普通用户忘了** → 找**站主**,在「设置 → 账号管理」里一键给他重置密码(不影响他的网盘和媒体库)。
- **站主自己忘了** → 在宿主机上跑(谁能进这台机器谁就能找回):

  ```bash
  docker compose exec web node scripts/reset-password.mjs <用户名> [新密码]
  ```

  不给新密码就随机生成并打印。登录后到「设置 → 修改密码」改成你自己的。

即便开了多用户,也仍建议放在 Tailscale / Cloudflare Access 之后——登录只为隔离用户数据,不是给公网当门禁。

## 国内构建加速(连不上 Docker Hub)

Docker Hub 和 ghcr 在国内常连不上,首次 `docker compose up` 构建 / 拉取会卡住。下面的镜像加速**只解决 Docker Hub**(占绝大多数镜像);来自 ghcr 的 `pansou` 是例外,见本节末尾。典型报错(任一即是此问题):

```
failed to fetch oauth token: Post "https://auth.docker.io/token": ... i/o timeout
DeadlineExceeded / dial tcp ...:443: i/o timeout
```

解决办法是**给 Docker 配一个国内 registry 镜像**。按你的平台来 —— ⚠️ 两者方式不同,别搞混:

**Docker Desktop(macOS / Windows)** — 不是改 `daemon.json` 文件、也没有 `systemctl`:
1. 打开 **Settings(设置)→ Docker Engine**;
2. 在那段 JSON 里加上 `registry-mirrors`(和已有字段并列):
   ```json
   {
     "registry-mirrors": ["https://docker.1ms.run"]
   }
   ```
3. **Apply & Restart**(应用并重启),等鲸鱼图标变绿再重试 `docker compose up -d`。

**Linux(含软路由 / NAS,直接装的 Docker Engine)**:把镜像写进 `/etc/docker/daemon.json` 的 `registry-mirrors`,然后 `sudo systemctl restart docker`:
```json
{ "registry-mirrors": ["https://docker.1ms.run"] }
```

**npm 也慢的话**,构建时换国内源:
```bash
docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

> 镜像地址会失效/限速,`docker.1ms.run` 只是示例;搜「Docker 镜像加速 可用」找当前能用的即可。配好后,所有 **Docker Hub** 镜像(`postgres`、构建 web 用的 `node`、`cloudflared`)都会走镜像 —— 本仓库 Dockerfile 已**特意不写 `# syntax=` 指令**,避免它绕过镜像、第一步就卡死(见 #46)。

**⚠️ 注意 `pansou` 例外**:它来自 **ghcr.io**(`ghcr.io/fish2018/pansou-web`),而 Docker 的 `registry-mirrors` **只对 Docker Hub 生效、管不到 ghcr**。若 ghcr 也连不上,二选一:
- 在 `.env` 设 `PANSOU_IMAGE=` 指向一个 ghcr 镜像/代理(如 `ghcr.nju.edu.cn/fish2018/pansou-web:latest`,镜像可用性自行确认),再 `docker compose up -d`;
- 或者不用自带 pansou —— 把 `PANSOU_BASE_URL` 指到一个外部 PanSou 实例,然后 `docker compose up -d web`(不起 pansou 容器)。

作者实测在带镜像加速的软路由(iStoreOS)上一把过。

## 升级

```bash
./scripts/deploy.sh
```

`scripts/deploy.sh` 会 `git pull` → 重建 `web` → `up -d` → **验证跑起来的容器确实是刚拉取的 commit**(读容器内 `BUILD_COMMIT` 和 `HEAD` 比对,不一致直接报错退出)。等价于 `docker compose up -d --build`,但多了那道**自校验**,并且不用 `--no-cache`。

> **为什么要自校验?** 升级最阴的失败是**静默回退**:`git pull` 之后容器仍在跑**旧代码**,而所有常规信号都在骗你——宿主 `git rev-parse HEAD` 显示的是新 commit(和容器里实际跑的代码无关),盯镜像 hash 也没用(`--no-cache` 重建每次 hash 都不同,纯粹是构建不确定性)。#88–#98 就是这样连续五次「部署成功」实则一整天跑旧代码。所以真正的护栏不是缓存技巧,而是**一道检查**:把镜像构建时刻的 commit 盖进 `BUILD_COMMIT`,部署后比对运行容器的 `BUILD_COMMIT` 是否等于 `HEAD`,不等就报错——无论病根是构建缓存、`git pull` 空转、还是容器没被重建,都会当场暴露而非静默溜过。
>
> `deploy.sh` 顺带传 `GIT_SHA=$(git rev-parse HEAD)` 作构建参数,Dockerfile 用它在 `COPY . .` 前触发缓存失效(ARG 在**首次使用**时 cache-miss,连带其后各层重建),每换 commit 强制重传源码 + 重建,而慢的 `npm ci` 依赖层仍走缓存。**不必 `--no-cache`**(那会把依赖层也丢掉,慢几分钟)。装了 buildx / 用内置 BuildKit 的宿主本就内容寻址、`COPY` 可靠,这层主要是给用**经典构建器**(`DOCKER_BUILDKIT=0` 或很老的 Docker)的自部署者兜底;两种构建器下都正确无副作用。
>
> 手动等价执行 + 校验:
> ```bash
> git pull --ff-only
> GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build
> # 核对容器真在跑新代码(应等于上面的 HEAD):
> docker compose exec web cat BUILD_COMMIT
> ```
