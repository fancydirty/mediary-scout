# 给 Cloudflare 的隧道转售书面许可申请邮件（草稿）

发送对象建议：Cloudflare Sales / Partnerships（不是 support ticket——ticket 只会
回「请查阅 self-serve ToS」，拿不到书面许可）。入口：
- https://www.cloudflare.com/plans/enterprise/contact/ （表单，选 Partnership）
- 或已有客户经理时直接回信给他

主题（英文更容易转到对的团队）：

Request for written permission: reselling Cloudflare Tunnel as part of a paid
self-hosted product (Mediary Connect)

---

## 正文（英文，可直接发）

Hello Cloudflare team,

I operate a small software product and I would like to obtain written
confirmation about an intended use of Cloudflare Tunnel before I start charging
customers, rather than after.

**What the product is**

Mediary Scout is a self-hosted media-acquisition agent that users run on their
own hardware (typically a home NAS or a small router-class Linux box). It is
free and open to self-host.

I am launching a paid add-on called Mediary Connect. Its only function is to
give a self-hosted instance a stable public HTTPS address so the owner can
reach *their own* instance from outside their home network, without opening
router ports or configuring dynamic DNS.

**How Cloudflare is involved**

- Each paying customer's instance gets its own Cloudflare Tunnel, created via
  the Cloudflare API under **my** Cloudflare account.
- Each tunnel is bound to one hostname on a domain I own
  (`<customer-slug>.mediaryconnect.app`).
- The tunnel connector (`cloudflared`) runs on the customer's own machine.
- Traffic is HTTP to the customer's own instance, plus optionally SSH to the
  same machine for maintenance.
- Customers do not get Cloudflare accounts, Cloudflare dashboard access, or
  Cloudflare API credentials. They never interact with Cloudflare directly.
- I charge for prepaid time (roughly USD 6 per quarter to USD 26 for two
  years), and the fee covers the whole product experience, not Cloudflare
  capacity as a metered line item.

**Why I am asking**

I am aware that the self-serve Terms restrict reselling or providing
Cloudflare services to third parties, and that Section 2.8 of the Self-Serve
Subscription Terms addresses serving non-HTML content and reselling. I do not
want to interpret this in my own favour and discover later that I built a paid
business on a prohibited pattern.

**My specific questions**

1. Does the arrangement above constitute "reselling" Cloudflare services under
   my current self-serve plan?
2. If it does, what is the correct path to make it compliant — a specific plan,
   a partner or reseller agreement, or Enterprise terms?
3. Is there a limit on the number of tunnels or DNS records per account that I
   should design against? I currently assume approximately 1,000 tunnels per
   account and have implemented a hard capacity gate so that I never sell
   capacity I cannot deliver.
4. If this is permitted, may I have that confirmation in writing so I can keep
   it on file?

**Current scale and intent**

I have not sold anything yet. I have one instance running (my own) and one
person on the waiting list. I am deliberately asking before taking any
payments. If the answer is that this requires different terms, I would rather
sign the correct agreement than proceed and be shut off later — my customers
would lose access to their own machines, which is exactly the outcome I want to
avoid.

Happy to provide architecture details, the provisioning code path, or a demo.

Thank you for your time.

Best regards,
<你的名字>
DF Digital
<你的邮箱>
mediaryconnect.app

---

## 给 Codex 的交付说明（你转发时附上）

这封邮件的**目的不是拿到「可以」**，而是拿到一个**有据可依的答复**。三种结果都算成功：
1. 「允许」+ 书面确认 → 存档，可以正式收钱。
2. 「需要 Enterprise / Partner 协议」→ 知道确切代价，再决定商业模式是否成立。
3. 「不允许」→ **在收钱之前**知道，避免给付费用户断网。

关键事实（别改错）：
- 隧道建在**我们**的 CF 账号下，不是客户的账号。
- 客户拿不到任何 CF 凭证或后台权限。
- 收的是「预付时长」的产品费，**不是**按 CF 流量/容量计费的转卖。
- 容量闸门已实现（PR #201），假设上限约 1000 隧道/账号。
- 目前**零销售**，1 个 waitlist 报名，是在收钱前主动问的。

语气要点：主动合规、不装不懂、给对方容易回答的封闭式问题（4 条编号问题）。
不要写成「我已经在做了，你们看着办」——那容易直接触发封号审查。
