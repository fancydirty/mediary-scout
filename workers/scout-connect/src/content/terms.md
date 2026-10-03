# Terms of Service

## 服务条款

Last updated: 2026-10-03

最后更新:2026-10-03

## What the service is

## 服务是什么

Mediary Connect provides a remote-access tunnel for your self-hosted Mediary Scout instance: a dedicated `<your-name>.mediaryconnect.app` hostname connected over an encrypted Cloudflare Tunnel to the instance on your own machine. No public IP, no open ports, no domain of your own required.

Mediary Connect 为自托管的 Mediary Scout 实例提供远程访问通道:一个 `<你选的名字>.mediaryconnect.app` 专属域名,经 Cloudflare Tunnel 加密连接到你自己机器上的实例。不需要公网 IP、不需要开端口、不需要自备域名。

**The service does not include** the storage, download, playback, or distribution of any media content. Your instance, content, and credentials always stay on your own devices; this service only "opens the door".

**服务不包括**:媒体内容的存储、下载、播放或分发。你的实例、内容与凭据始终在你自己的设备上;本服务只负责「开门」。

## Your responsibilities

## 你的责任

- **You must set the access password.** Your instance is exposed on the public internet via the dedicated hostname, and the access password is its only gate. Set it from your home network first (open your instance's LAN address, e.g. `http://192.168.1.10:3000/login`): the first password can only be set on the LAN, and a remote visitor to an instance without one only sees a notice. Data leaks from an ungated instance are on you.
- **Lawful use.** You are solely responsible for the legality of content you acquire or transmit through your instance. We do not and cannot inspect tunnel traffic.
- **Slug.** Do not use a name that infringes trademarks, impersonates others, or contains offensive words. Violations may be disabled, and we reserve the slug from reassignment.
- Do not use the tunnel for anything other than your Mediary Scout instance (the tunnel target is fixed to your instance's web service).

- **必须设置访问密码**:你的实例经专属域名暴露在公网,访问密码是它唯一的门禁。请先在家里的局域网设好(打开实例的局域网地址,例如 `http://192.168.1.10:3000/login`):第一次设置只能在局域网里完成,外网打开没设密码的实例只会看到提示。因未设门禁导致的数据泄露由你自行承担。
- **合法使用**:你通过实例获取与传输的内容,由你对其合法性负全责。本服务不审查也无法审查隧道流量。
- **域名前缀(slug)**:不得使用侵犯他人商标、冒充他人或含有攻击性词汇的名字。违者我们有权停用并保留该 slug 不再分配。
- 不得将隧道用于 Mediary Scout 实例之外的用途(隧道指向固定为你实例的 web 服务)。

## Payment and duration

## 付费与时长

- The service is billed as **prepaid time**: you buy several months of access, get an email reminder before expiry, and are **never auto-charged**.
- After expiry there is a 7-day grace period (service continues); when grace ends, the hostname stops resolving and the tunnel is reclaimed immediately to free capacity. Renewing later restores the same slug — you re-run the one-line setup command once to bring the tunnel back up.
- Your slug is kept permanently and is never released to others; on renewal you re-run the one-line setup command to bring the tunnel back up with the same address.
- See the [Refund Policy](https://mediaryconnect.app/refund). Waffo.com Limited is the merchant of record, processes one-time WeChat Pay payments, and sends the receipt. No automatic renewal is created.

- 服务按**预付时长**计费:付费购买若干个月的访问权,到期前会邮件提醒续期,**不会自动扣款**。
- 到期后有 7 天宽限期(服务照常);宽限期满域名停止解析,并**立即回收隧道**以释放配额。之后续期,slug 原样恢复,需重跑一次一行接入命令让隧道重新上线。
- 你的 slug 永久保留,永不释放给他人;续期后重跑一次一行接入命令,即可以同一地址恢复。
- 退款见[退款政策](https://mediaryconnect.app/refund)。Waffo.com Limited 是记录商户,通过微信支付一次性收款并发送付款凭证,不会开通自动续费。

## Service level

## 服务水平

The service runs on Cloudflare's global network. We make reasonable efforts to keep it available but **offer no SLA**; this is positioned as a hobbyist-grade personal service. Unavailability caused by Cloudflare, your home network, or your instance itself is not a breach. If our fault causes 72+ consecutive hours of unavailability, you may request a refund per the Refund Policy.

本服务基于 Cloudflare 的全球网络。我们尽合理努力保持可用,但**不承诺 SLA**;本服务定位为个人爱好者级服务。因 Cloudflare、你的家庭网络或你实例本身导致的不可用,不构成违约。因我方原因连续不可用超过 72 小时的,你可按退款政策申请退款。

## Termination

## 终止

- You may stop using the service at any time; unexpired time can be handled per the Refund Policy.
- We may suspend or terminate service if you breach these terms (especially tunnel abuse or an infringing slug).
- If the service is permanently shut down entirely, we will give 30 days' notice and refund unused time pro-rata.

- 你可随时停止使用;未到期时长可按退款政策处理。
- 我们可在你违反本条款(尤其是滥用隧道或侵权 slug)时暂停或终止服务。
- 若服务整体永久下线,将提前 30 天通知,并按未使用时长比例退款。

## Changes

## 变更

Term updates are dated on this page; material changes are emailed. Continued use is acceptance.

条款更新会在本页标注日期;重大变更会邮件通知。继续使用即视为接受。

## Operating entity

## 运营主体

This service is operated by **DF Digital**, a sole proprietorship. **Waffo.com Limited is the merchant of record** for purchases, handles WeChat Pay, and sends payment receipts.

本服务由 **DF Digital**(个体工商户)运营。购买由 **Waffo.com Limited** 作为记录商户处理,通过微信支付收款并发送付款凭证。

## Governing law

## 适用法律

These terms are governed by the laws of the People's Republic of China.

本条款受中华人民共和国法律管辖。
