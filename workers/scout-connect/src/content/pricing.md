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

- **季度(3 个月)** — ¥45
- **年度(12 个月)** — ¥108
- **两年(24 个月)** — ¥188

Prices are in CNY, checked out securely by Paddle. **WeChat Pay** and international cards are supported (Apple Pay / Google Pay also work). Your statement will show Paddle's name — that is expected, as Paddle is the Merchant of Record for this service.

价格以人民币计,由 Paddle 安全结账,支持**微信支付**与国际信用卡(也支持 Apple Pay / Google Pay)。你的账单上会显示 Paddle 的名字,这是正常的 —— Paddle 是本服务的记录商户(Merchant of Record)。

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

## Buying: you log in first

## 购买流程:先登录

Paid time is attached to the **email you log in with**, not to the card you pay with — many people pay with a company card or a family member's card, and the time must land on the right account. So the order is: log in with your own email → pick a tier in the console → pick your hostname.

There is **no sign-up step**. The first time you enter an email, that email becomes your account; every time after, it is a sign-in. No password exists, so no password can leak.

付费时长记在**你登录用的邮箱**名下,不记在付款的那张卡上 —— 很多人用公司卡或家人的卡付款,时长必须落在正确的账号上。所以顺序是:用你自己的邮箱登录 → 在控制台选档位 → 选你的域名。

**没有注册这一步**。第一次输入邮箱时,那个邮箱就是你的账号;之后再输入同一个邮箱就是登录。系统里不存在密码,所以也没有密码可以泄露。

## What this does not include

## 不包含什么

Mediary Connect is an **add-on** to Mediary Scout, not a standalone product. It needs an already-running Scout instance to have anything to connect to.

- It does **not** host an instance for you — you need your own always-on machine (NAS, router-class box, mini PC, an old laptop all work).
- It does **not** search or download anything on your behalf; your own Scout does that.
- It does **not** hold your instance's access password — that gate is Scout's own, set by you on first open, and we keep no copy.

Mediary Connect 是 Mediary Scout 的**附加服务**,不是独立产品。它需要一个已经在运行的 Scout 实例才有东西可连。

- **不**为你托管实例 —— 你需要自己有一台常开的机器(NAS、软路由、迷你主机、旧笔记本都行)。
- **不**代你搜索或下载任何东西,那是你自己的 Scout 在做。
- **不**持有你实例的访问密码 —— 那道门禁是 Scout 自己的,首次打开时由你设定,我们这边没有副本。

## Changing tiers, and price changes

## 换档与调价

Because this is prepaid time rather than a subscription, there is no "upgrade" or "downgrade" mid-term — buying more time simply extends your expiry date. Time from different tiers stacks onto the same account.

If we raise prices, **time you already bought is unaffected**: you paid for a fixed number of months, and there is no next charge for a price change to apply to. Any price change is announced before it takes effect.

因为这是预付时长而不是订阅,所以没有中途「升级」或「降级」—— 再买时长就是把到期日往后延。不同档位的时长会叠加到同一个账号上。

如果我们涨价,**你已经买到的时长不受影响**:你付的是固定月数,而且不存在「下一次扣款」让新价格生效。任何调价都会在生效前公告。

## Capacity

## 容量

Each instance gets its own Cloudflare Tunnel, and a Cloudflare account has a hard ceiling on how many tunnels it can hold. We keep a capacity gate in front of checkout so we never sell access we cannot deliver — if we are ever at capacity, checkout tells you so instead of taking your money.

每个实例都有自己的 Cloudflare 隧道,而一个 Cloudflare 账号能持有的隧道数有硬上限。我们在结账前设了容量闸门,绝不卖出交付不了的额度 —— 万一售罄,结账会明确告诉你,而不是先收钱。

## An honest note

## 诚实说明

Cloudflare Tunnel itself is free. If you have your own CF account and domain, you can build the same tunnel yourself (our open-source docs show how). What we sell is convenience: no buying a domain, no configuring DNS, no maintenance — plus the promise of a stable, non-disappearing operator.

Cloudflare Tunnel 本身免费。如果你有自己的 CF 账号和域名,完全可以自建同样的通道(我们的开源文档就写了怎么做)。这里卖的是省事:不用买域名、不用配 DNS、不用维护,以及一个稳定运营、不跑路的承诺。

See the [Refund Policy](https://mediaryconnect.app/refund) (14-day, no questions asked).

退款政策见[退款政策](https://mediaryconnect.app/refund)(14 天无理由)。
