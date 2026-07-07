# 桌面端：自建 PanSou 实例（获得更丰富的资源源）

**为什么需要？** 桌面版 Mediary Scout 是双击即用的独立应用，**不打包 PanSou 容器**（PanSou 是独立的第三方项目，保持解耦）。不配置时，桌面端默认指向作者托管的公共 PanSou 实例——它资源有限、偶尔不稳。

关键在于 **PanSou 的频道配置**：开箱默认的 `pansou-web` 只索引磁力频道，**返回不到 115 网盘分享**。一个配好 115 源频道（`Lsp115`、`vip115hot`、`leoziyuan`、`Oscar_4Kmovies` 等）的实例，同一部电影能多返回一批 115 分享（含 4K REMUX）。自建一个配好频道的本地实例，agent 就能挑到真正的好资源。

下面几分钟即可搞定。全程只在你自己电脑上跑一个容器，不依赖公网、不需要 VPS。

## 1. 装容器运行时

- **macOS**：装 [OrbStack](https://orbstack.dev/)（轻量、省电，比 Docker Desktop 更适合 Mac）。装完打开即可。
- **Windows**：装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。装完启动，等右下角鲸鱼图标变绿。

两者装好后，终端（macOS 用「终端」，Windows 用 PowerShell）里 `docker version` 能打印版本即就绪。

## 2. 拿到好频道配置

本仓库的 [`deploy/pansou.channels.env`](../deploy/pansou.channels.env) 就是一份**已验证能返回 115 分享（含 4K）**的频道配置——里面是公开的 Telegram 频道名与 PanSou 插件名，不含任何密钥。

下载它（或从仓库复制），存到本地任意目录，例如 `~/pansou.channels.env`。

## 3. 起容器

终端里执行（把 `~/pansou.channels.env` 换成你实际的路径）：

```bash
docker run -d --name mediary-pansou --restart unless-stopped \
  -p 8899:8888 \
  --env-file ~/pansou.channels.env \
  ghcr.io/fish2018/pansou-web:latest
```

- `-p 8899:8888`：容器的 8888 映射到本机 `localhost:8899`（换个不冲突的端口也行）。
- `--restart unless-stopped`：开机自启，省得每次手动拉起。

> 🇨🇳 **拉不下 ghcr 镜像？** `ghcr.io` 在国内偶尔受阻。用镜像代理前缀，或参考 [docs/deploy.md → 国内构建加速](deploy.md#国内构建加速连不上-docker-hub)。

起来后等几十秒让它从各频道预热缓存。

## 4. 让 App 用上

打开 Mediary Scout → **设置 → 资源提供商 → 服务地址**，填：

```
http://localhost:8899
```

点保存。之后 agent 搜资源就走你这个配好频道的本地实例了。

## 5. 验证

在 App 里搜一部有名的电影（如「复仇者联盟2：奥创纪元」），看结果里是否出现 115 网盘分享（标题常带「4K/REMUX/GB」等字样）。第一次搜某个词可能因缓存冷而偏少，PanSou 会在随后几十秒内把频道结果灌进来——稍等再搜即可。

## 常见问题

- **端口占用**：`8899` 被占了就换个端口，同时把设置里的地址改成对应端口。
- **想停/删**：`docker stop mediary-pansou` / `docker rm -f mediary-pansou`。
- **想换更多频道**：编辑 `pansou.channels.env` 的 `CHANNELS` / `ENABLED_PLUGINS`，`docker rm -f mediary-pansou` 后用新配置重跑第 3 步。
- **PanSou 是什么**：一个聚合 Telegram 频道网盘分享的搜索后端，见 [项目主页](https://github.com/fish2018/pansou)。Mediary Scout 与它无隶属关系，只是把它当可选的资源搜索源。

> docker compose 自部署版**已自带**一个配好这份频道的 PanSou 容器，无需本教程——本教程仅面向**桌面版**用户。
