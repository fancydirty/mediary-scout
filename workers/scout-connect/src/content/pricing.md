# Pricing

## 定价

Last updated: 2026-07-28

最后更新:2026-07-28

## Prepaid time, never auto-charged

## 预付时长,不自动扣款

Mediary Connect is billed as **prepaid time**: pay once, get that many months of remote access. We email a reminder before expiry; there is **no auto-renewal** — if you don't renew, it simply lapses. We never quietly charge you.

Mediary Connect 按**预付时长**计费:一次付费,获得对应月数的远程访问权。到期前我们会邮件提醒;**没有自动续费**,不续期就自然到期,不会偷偷扣你的钱。

## Tiers

## 档位

- **Quarter (3 months)** — ¥45
- **Year (12 months)** — ¥108
- **Two years (24 months)** — ¥188
- **Founding (first 100 seats)** — ¥88 / year, **renews at the same price, locked permanently**

- **季度(3 个月)** — ¥45
- **年度(12 个月)** — ¥108
- **两年(24 个月)** — ¥188
- **创始价(前 100 席)** — ¥88 / 年,**承诺续期同价,永久锁定**

Prices are in CNY, checked out securely by Paddle (Alipay and international cards supported).

价格以人民币计,由 Paddle 安全结账(支持支付宝与国际信用卡)。

## Every tier includes

## 每一档都包含

- A `<your-name>.mediaryconnect.app` dedicated hostname — you pick it, and it stays yours permanently
- An encrypted Cloudflare global-edge tunnel — no public IP, no open ports, no domain of your own
- Log in once in the browser; no repeat login while the cookie is valid (the gate is your instance's own password)
- Self-service recovery anytime you switch machines or reinstall — no need to contact anyone
- After expiry the slug is kept permanently: renew anytime and your config restores as-is (never reassigned)

- `<你选的名字>.mediaryconnect.app` 专属域名 —— 由你自己选定,永久保留
- Cloudflare 全球边缘加密隧道,无需公网 IP / 开端口 / 自备域名
- 浏览器登录一次,Cookie 有效期内免重复登录(门禁是你实例自己的密码)
- 换机器 / 重装随时自助恢复,不需要联系任何人
- 到期后 slug 永久保留:任何时候回来续期,配置原样恢复

## What happens at expiry

## 到期会发生什么

- A **7-day grace period** after expiry, service as usual, with in-app and email renewal reminders;
- After grace, the hostname stops resolving (your instance itself is unaffected);
- When grace ends, the tunnel is reclaimed immediately to free capacity. Your slug is **never released to others** — renewing restores the same address (you re-run the one-line setup command once to bring the tunnel back up).

- 到期后 **7 天宽限期**,服务照常,站内与邮件提醒续期;
- 宽限期后域名停止解析(你的实例本身不受任何影响);
- 宽限期满即回收隧道以释放配额;你的 slug **永不释放给他人** —— 续期后地址原样恢复(需重跑一次一行接入命令让隧道重新上线)。

## An honest note

## 诚实说明

Cloudflare Tunnel itself is free. If you have your own CF account and domain, you can build the same tunnel yourself (our open-source docs show how). What we sell is convenience: no buying a domain, no configuring DNS, no maintenance — plus the promise of a stable, non-disappearing operator.

Cloudflare Tunnel 本身免费。如果你有自己的 CF 账号和域名,完全可以自建同样的通道(我们的开源文档就写了怎么做)。这里卖的是省事:不用买域名、不用配 DNS、不用维护,以及一个稳定运营、不跑路的承诺。

See the [Refund Policy](https://mediaryconnect.app/refund) (14-day, no questions asked).

退款政策见[退款政策](https://mediaryconnect.app/refund)(14 天无理由)。
