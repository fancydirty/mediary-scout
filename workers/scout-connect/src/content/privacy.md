# Privacy Policy

## 隐私政策

Last updated: 2026-07-28

最后更新:2026-07-28

## In one sentence

## 一句话版本

Mediary Connect touches only the minimum data needed to let you open your own instance from outside your network. Your media content, drive credentials, and LLM keys **always stay on your own machine** — this service is technically unable to reach them.

Mediary Connect 只经手「让你从外网打开自己实例」所必需的最少数据。你的媒体内容、网盘凭据、LLM 密钥**始终只在你自己的机器上**,本服务在技术上就接触不到。

## What we collect

## 我们收集什么

- **Email address** — your sole account identifier, used for login (magic link), payment receipts, and expiry reminders.
- **Payment info** — handled by Paddle (Merchant of Record). We **never touch** your card number or WeChat Pay account; we only receive a transaction ID and payment email from Paddle.
- **Service config** — the slug you chose, tunnel identifier, and provisioning/suspension times.
- **Runtime metadata** — tunnel connection status (online/offline) and basic HTTP metadata in access logs (produced at the Cloudflare edge).

- **邮箱地址**:你的唯一账号标识,用于登录(魔法链接)、付款收据与到期提醒。
- **付款信息**:由 Paddle(Merchant of Record)处理。我们**不接触**你的卡号或微信支付账号,只从 Paddle 收到交易号与付款邮箱。
- **服务配置**:你选择的域名前缀(slug)、隧道标识、开通/停用时间。
- **运行元数据**:隧道连接状态(在线/离线)、访问日志中的基础 HTTP 元数据(由 Cloudflare 边缘产生)。

## What we explicitly do not collect

## 我们明确不收集什么

- Any media content, file listings, or watch history from your instance;
- Your drive cookies or any 115 / Quark / 123 / Tianyi credentials;
- Your LLM API keys or conversation content;
- Business data transmitted through the tunnel — tunnel traffic passes end-to-end through Cloudflare, and our control plane is **not in the data path**.

- 你实例中的任何媒体内容、文件列表、观看记录;
- 你的网盘 Cookie、115/夸克/123/天翼等任何凭据;
- 你的 LLM API 密钥与对话内容;
- 经隧道传输的业务数据 —— 隧道流量端到端经过 Cloudflare,我们的控制面**不在数据路径上**。

## Where data lives

## 数据存在哪里

Account and service config are stored in Cloudflare D1 (database). Payment data is stored at Paddle. Email is sent via Resend. Each provider processes data under its own privacy policy.

账号与服务配置存储在 Cloudflare D1(数据库)。付款数据存储在 Paddle。邮件经 Resend 发送。以上服务商均在其各自隐私政策下处理数据。

## Data retention

## 数据保留

- Account and slug records: kept long-term (a slug is never released to others — that is part of the product promise).
- After the 7-day grace period ends, the tunnel and its DNS record are reclaimed immediately to free capacity; account and slug records are kept so you can return and renew anytime.
- You may email us at any time to delete your account and all related data (payment records are retained by Paddle as required by law).

- 账号与 slug 记录:长期保留(slug 永不释放给他人,这是产品承诺的一部分)。
- 7 天宽限期满后,隧道与其解析记录**立即回收**以释放配额;账号与 slug 记录保留,以便你随时回来续期。
- 你可以随时发邮件要求删除账号及全部相关数据(付款记录受法律要求由 Paddle 保留)。

## Cookies

## Cookie

This site uses a single session cookie (login state) and no tracking or advertising cookies.

本站只使用一个会话 Cookie(登录态),不使用任何跟踪或广告 Cookie。

## Contact

## 联系

For any data-related request, see the Contact page.

数据相关的任何请求,见「联系我们」页面。
