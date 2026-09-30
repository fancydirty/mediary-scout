<p align="center">
  <img src="docs/images/hero.svg" alt="巡影 · Mediary Scout" width="600">
</p>

<p align="center">
  <b>巡影 · Mediary Scout</b><br>
  <b>给你自己网盘用的 agent 驱动媒体库。</b>
</p>

<p align="center">
  <a href="https://github.com/fancydirty/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/fancydirty/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/fancydirty/mediary-scout/releases/latest"><img src="https://img.shields.io/github/v/release/fancydirty/mediary-scout?display_name=tag" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="https://github.com/fancydirty/mediary-scout/releases/latest">📥 下载</a> ·
  <a href="https://mediaryscout.app">🌐 官网</a> ·
  <a href="https://demo.mediaryscout.app">🔭 在线 Demo</a> ·
  <a href="README.en.md">English</a>
</p>

你说要哪部电影、剧或番，agent 自己去搜资源，挑最合适的转存进你自己的网盘（夸克 / 115 / 光鸭 / 123 / 天翼），转完读回来确认真的到了，之后缺哪集还会接着补。

点击前往下载：[GitHub Releases](https://github.com/fancydirty/mediary-scout/releases/latest)（macOS / Windows 桌面版）

点击前往赏饭：[要饭嘛，不寒碜](docs/support/README.md)

交流：本项目积极参与并认可 [LINUX DO 社区](https://linux.do)，许多用户在那里自部署、交流网盘经验，部署问题也能很快得到回应。 [![认可 LINUX DO](https://img.shields.io/badge/LINUX%20DO-认可-2ecc71?style=flat&labelColor=1f1f1f)](https://linux.do)

![巡影：搜片 → 点获取 → agent 自动搜索、转存、验证落进你的网盘](docs/images/demo.gif)

## 安装

### 桌面版（最省事）

| 平台 | 下载 | 说明 |
|---|---|---|
| macOS（Apple 芯片） | [.dmg](https://github.com/fancydirty/mediary-scout/releases/latest) | 已签名公证，直接打开 |
| Windows（x64） | [.exe](https://github.com/fancydirty/mediary-scout/releases/latest) | 未签名，SmartScreen 弹窗时点「仍要运行」 |

安装后打开 → 在设置里连网盘、填 AI 模型 → 搜片点「获取」。有新版本时应用会提示你下载。

### Docker（NAS / 软路由 / 服务器）

```bash
git clone https://github.com/fancydirty/mediary-scout && cd mediary-scout
docker compose up -d
```

打开 `http://<主机IP>:3000`，在设置里配置。以后在 **设置 → 更新** 里一键升级，也可以设成每天自动更新。国内构建加速、Tailscale / Cloudflare Tunnel 远程访问、多用户、备份，以及让 AI agent 替你部署的提示词，都在 **[部署指南](docs/deploy.md)**。

| | 桌面版 | Docker |
|---|---|---|
| 适合 | 自己用，Mac / Windows | NAS、服务器，常开 |
| 定时巡检补缺 | 应用开着时才跑 | 24 小时 |
| 多用户 | 不支持 | 支持 |
| 手机、出门访问 | 仅本机 | Tailscale / Cloudflare Tunnel |

两种都要自带一个 OpenAI 兼容的 AI 模型接口（key 只存在你自己的实例里）。影视信息开箱即用。资源搜索用 PanSou：Docker 版自带一个，桌面版默认用公共实例，可以在设置里换成你自己的；可选再接 Prowlarr 找磁力。

## 支持的网盘

- **夸克**：分享链转存，PanSou 上资源最多。
- **115**：分享链 + 磁力。
- **123网盘**：分享链 + 磁力，免费账号也能转存，扫码登录。[连接教程](docs/deploy.md#123网盘连接)
- **光鸭云盘**：分享链 + 磁力，粘 token 登录。[连接教程](docs/deploy.md#光鸭云盘guangyapan连接)
- **天翼云盘**：分享链转存，扫码登录，电影资源偏少。[连接教程](docs/deploy.md#天翼云盘连接)

各盘资源量对比、为什么只支持这五家：[网盘评估](docs/drive-brand-evaluations.md)。

## 更多文档

- [部署指南](docs/deploy.md)
- [Agent API](docs/agent-api.md)：让 Claude Code、Codex 等编程 agent 直接操作巡影
- [架构速览](docs/architecture.md)

## 免责声明

巡影是开源、自部署的软件，不提供、也永远不会提供托管服务：你自己跑实例，自带网盘、AI 模型和元数据凭证。它做的就是你本可以在自己网盘里手动完成的那些文件操作。详见[项目定位](docs/distribution-and-legal-positioning.md)。与 115、夸克、光鸭、123、天翼、TMDB 及任何索引器均无隶属关系。

## 致谢

- [PanSou](https://github.com/fish2018/pansou-web)：资源搜索后端
- [Prowlarr](https://github.com/Prowlarr/Prowlarr)：索引器管理（可选）
- [p115client](https://github.com/ChenyangGao/p115client)：115 API 参考
- [p123client](https://github.com/ChenyangGao/p123client)：123网盘 API 参考
- [AList](https://github.com/AlistGo/alist)：光鸭云盘 API 参考（`drivers/guangyapan`）
- [cloud189-auto-save](https://github.com/1307super/cloud189-auto-save) / [cloudpan189-api](https://github.com/tickstep/cloudpan189-api)：天翼云盘 API 参考
- [TMDB](https://www.themoviedb.org/)：影视元数据（本产品未获 TMDB 认证或背书）

## Star History
<a href="https://www.star-history.com/?repos=fancydirty%2Fmediary-scout&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&theme=dark&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
  </picture>
</a>
