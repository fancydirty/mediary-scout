# Deploy Mediary Scout

> **English summary.** Self-host with one command — `docker compose up -d` brings up web (Next.js + in-process worker) + Postgres + a bundled PanSou. Open `http://<host>:3000`, go to Settings, scan-login your 115 / Quark drive, add an OpenAI-compatible LLM endpoint, and you're running. To reach it from your phone / TV / on the go, use **Tailscale** (private mesh — safest) or a **Cloudflare Tunnel** (public HTTPS, no public IP). **Never expose `:3000` raw to the internet.** Full walkthrough below (Chinese).

一行命令起整套:**web(Next + 进程内 worker)+ Postgres + 自带 PanSou**。本指南覆盖:选宿主 → compose 起服务 → 从自己的设备访问 → 安全/升级。

## 目录
- [选择你的宿主](#选择你的宿主)
- [Compose 快速开始](#compose-快速开始)
- [想跑真实获取还需要](#想跑真实获取还需要)
- [可选增强](#可选增强)
- [从你的设备访问](#从你的设备访问)
- [安全](#安全)
- [国内构建加速](#国内构建加速)
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
1. **设置 → 网盘**:115 扫码登录(cookie 持久化到数据库,后续自动转存);夸克在设置选夸克品牌粘贴 cookie。
2. 就这样。**TMDB 元数据经作者 CF Worker 开箱即用**(想用自己额度可在设置填 TMDB key);**PanSou 网盘搜索源已自带**。

### 组成 / 端口

| 服务 | 镜像 | 说明 |
|---|---|---|
| `web` | 本仓库 `Dockerfile` | Next.js + 进程内 worker(`instrumentation.ts` 自启),`:3000` |
| `postgres` | `postgres:16-alpine` | 持久卷 `pgdata`;表首次查询自建,无需迁移 |
| `pansou` | `ghcr.io/fish2018/pansou-web` | 网盘搜索源,compose 内经服务名 `http://pansou` 调用 |

### 覆盖配置

`docker-compose.yml` 的 `environment:` 已设好库连接、PanSou 地址、adapters。要覆盖额外项(TMDB / 115 cookie / LLM / Prowlarr / CID),在仓库根放 `.env`(参照 `.env.example`)——compose 会自动加载(缺失也无妨)。

## 想跑真实获取还需要

- **AI 模型**(设置 → AI 模型):填一个 OpenAI 兼容的 `baseURL / apiKey / modelId`——agent 靠它决策。不填则获取流程无法规划。
- **115 目录 CID**(`.env` 或环境变量):`TV_SHOWS_CID` / `MOVIES_CID` / `ANIME_CID` 等落盘父目录。

## 可选增强

- **自己的 TMDB key**(设置 → TMDB 元数据):直连你自己的额度,调不通自动回退作者代理。
- **Prowlarr**(设置 → 资源提供商):接入索引器聚合,磁力与 PanSou 结果合并、走 115 秒传。
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

## 国内构建加速

Docker Hub / ghcr 在国内常连不上,首次 `docker compose up` 构建 / 拉取会卡住:
- 给 Docker 配 registry mirror(如 `https://docker.1ms.run`,写进 `/etc/docker/daemon.json` 的 `registry-mirrors` 后 `systemctl restart docker`)。
- 构建 web 镜像时换 npm 源:`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`。

作者实测在带镜像加速的软路由(iStoreOS)上一把过。

## 升级

```bash
git pull && docker compose up -d --build
```
