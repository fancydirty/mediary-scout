/**
 * 创建 Paddle 交易(结账的起点)。
 *
 * **为什么必须由我方创建交易,而不是让 Paddle 自己生成:**
 * webhook 要知道「这笔付款属于哪个登录账号」。唯一可靠的载体是交易的
 * `custom_data.account_email` —— 而它只能在创建交易时写入。
 *
 * 实测确认(sandbox 真实事件):`transaction.completed` 的 data 里**没有嵌套的
 * customer 对象**,只有 `customer_id`。所以「从 payload 直接拿邮箱」这条路不存在;
 * 而 `custom_data` 确实会原样透传到 webhook。
 *
 * 另一件实测确认的事(2026-08-01 在 **live** 复验):**显式传 `checkout.url` 会
 * 覆盖账号级的 default payment link**,这行不能删 —— 本 Paddle 账号的 default
 * 指向另一个产品(agentmentor.dev),不传就会把用户送去那边一个不认识本交易的页面。
 * live 只接受**已审批**域名(sandbox 自动批准,所以这条只能在 live 验证);
 * mediaryconnect.app 已批准,实测返回 mediaryconnect.app/buy?_ptxn=...。
 *
 * 原注释:显式传 `checkout.url` 会覆盖账号级的 default payment
 * link**。这让同一个 Paddle 账号能承载多个产品 —— 各自传自己的域名,default
 * 填谁都不生效。
 */

import type { PriceMonthsMap } from "./paddle-event.js";

export interface PaddleApi {
  createTransaction(input: {
    priceId: string;
    accountEmail: string;
    checkoutUrl: string;
  }): Promise<{ transactionId: string; checkoutUrl: string }>;

  /**
   * 查这个邮箱有没有**已付款但我们还没入账**的交易。
   *
   * 为什么需要它:webhook 是唯一的入账通道,但它会延迟(微信支付延迟捕获,
   * 官方说可能长达 10 分钟)、会重试、也可能因配置错误而全部失败 —— 这三件事
   * 都真实发生过。只看 entitlements 的话,这段时间用户看到的是「尚未开通」,
   * 而他刚刚才付过钱。那是会让人立刻开退款争议的体验。
   *
   * 返回 `paid`/`completed` 状态的交易 ID 列表。**只用于显示「正在开通」提示,
   * 绝不用于发放时长** —— 发放只认验过签的 webhook,否则任何人都能靠伪造
   * 交易状态白拿时长。
   */
  listPaidTransactionIds(accountEmail: string, ourPriceIds: readonly string[]): Promise<string[]>;

  /**
   * 查单笔交易的状态。供 /buy 页面的轮询用 —— 微信支付是延迟捕获,授权与
   * Paddle 确认之间可能有几分钟窗口,期间 Paddle 前端不跳转。我们自己轮询
   * 这个端点,一旦 paid/completed 就关 overlay 跳转。
   *
   * 返回 null = 交易不存在(或已取消)。**只返回状态与归属邮箱,不返回任何
   * 敏感字段。** 归属邮箱(创建交易时写入的 custom_data.account_email)
   * 用于校验"这笔交易确实属于这个登录用户"—— 防止任何人拿别人的交易 ID
   * 探测状态。
   */
  getTransactionStatus(
    transactionId: string,
  ): Promise<{ status: string; paidAt: string | null; accountEmail: string | null } | null>;
}

/** 真实 Paddle API 客户端。sandbox 与 live 的 base URL 不同。 */
export function createPaddleApi(input: {
  apiKey: string;
  /** "sandbox" | "production"。 */
  environment: string;
}): PaddleApi {
  const base =
    input.environment.trim().toLowerCase() === "sandbox"
      ? "https://sandbox-api.paddle.com"
      : "https://api.paddle.com";
  return {
    async createTransaction({ priceId, accountEmail, checkoutUrl }) {
      const res = await fetch(`${base}/transactions`, {
        method: "POST",
        // 超时是必需的,不是保险:没有它,上游抖动会让请求长时间挂起、占用
        // worker 并发额度并放大故障面。同仓其它外部调用(cf-api 10s、
        // magic-link 5s、turnstile 5s)都设了。创建交易走的是用户点「购买」
        // 的同步路径,10s 已经比人能忍的等待更长。
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          items: [{ price_id: priceId, quantity: 1 }],
          collection_mode: "automatic",
          // webhook 靠这个把付款关联到登录账号 —— 见本文件头部注释。
          custom_data: { account_email: accountEmail },
          // 显式指定,不依赖账号级 default(那个可能指向别的产品)。
          checkout: { url: checkoutUrl },
        }),
      });
      if (!res.ok) {
        // 不把 Paddle 的响应体透给客户端(可能含内部细节);只留状态码给日志。
        throw new Error(`paddle createTransaction failed: ${res.status}`);
      }
      const body = (await res.json()) as {
        data?: { id?: unknown; checkout?: { url?: unknown } | null };
      };
      const transactionId = typeof body.data?.id === "string" ? body.data.id : "";
      const url = typeof body.data?.checkout?.url === "string" ? body.data.checkout.url : "";
      if (transactionId === "" || url === "") {
        throw new Error("paddle createTransaction returned no id/checkout url");
      }
      return { transactionId, checkoutUrl: url };
    },

    async listPaidTransactionIds(accountEmail, ourPriceIds) {
      // **没有白名单就什么都不认。** 空数组意味着「我们不知道自己卖什么」,
      // 那时任何过滤都是假的 —— 宁可不提示,也不能拿别的产品的订单冒充。
      if (ourPriceIds.length === 0) return [];

      // Paddle 没有「按邮箱查交易」的直接参数,得先找 customer。
      const cRes = await fetch(
        `${base}/customers?email=${encodeURIComponent(accountEmail)}&status=active`,
        { headers: { authorization: `Bearer ${input.apiKey}` } },
      );
      if (!cRes.ok) return [];
      const cBody = (await cRes.json()) as { data?: Array<{ id?: unknown }> };
      const customerId = cBody.data?.[0]?.id;
      if (typeof customerId !== "string" || customerId === "") return [];

      // paid = 已捕获但尚未 completed;completed = 已完成。两者都意味着钱已经到了。
      const tRes = await fetch(
        `${base}/transactions?customer_id=${encodeURIComponent(customerId)}&status=paid,completed&per_page=20`,
        { headers: { authorization: `Bearer ${input.apiKey}` } },
      );
      if (!tRes.ok) return [];
      const tBody = (await tRes.json()) as {
        data?: Array<{ id?: unknown; items?: Array<{ price?: { id?: unknown } | null }> }>;
      };

      // ---- 只认**我们自己**的档位(真实 bug 的修复)----
      //
      // 同一个 Paddle 账号卖多个产品。只按 customer 过滤会把用户买过的**别的
      // 产品**也算成「Mediary Connect 已付款」。实测踩到:一个账号 2026-04-27
      // 买过 "Shopify POD Profit Planner"($12),打开 Connect 控制台就显示
      // 「已付款 · 正在开通」——他从没为 Connect 付过一分钱。
      //
      // 这个误报方向特别糟:它让一个**没付款**的人以为货在路上,于是不去付款,
      // 然后来投诉「等了半天没开通」。
      const ours = new Set(ourPriceIds);
      return (tBody.data ?? [])
        .filter((t) =>
          (t.items ?? []).some((it) => {
            const pid = it.price?.id;
            return typeof pid === "string" && ours.has(pid);
          }),
        )
        .map((t) => t.id)
        .filter((id): id is string => typeof id === "string" && id !== "");
    },

    async getTransactionStatus(transactionId) {
      const res = await fetch(`${base}/transactions/${encodeURIComponent(transactionId)}`, {
        headers: { authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      // 区分错误类型:404 = 交易不存在(合法 null);其它非 2xx(5xx/429)是
      // 上游故障,必须 throw —— 否则轮询端点会把 Paddle 抖动当成"交易不存在"
      // 返回 404,前端停止轮询,用户卡死。
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`paddle getTransactionStatus failed: ${res.status}`);
      const body = (await res.json()) as {
        data?: {
          id?: unknown;
          status?: unknown;
          billed_at?: unknown;
          custom_data?: { account_email?: unknown } | null;
        };
      };
      if (typeof body.data?.id !== "string") return null;
      // **必须校验返回的交易 ID == 请求的 ID**(Copilot round 6)。
      // 上游/缓存/代理异常时若返回了别的交易,会把它的状态/归属邮箱带回,
      // 后续归属校验也会被误导。不匹配 = 上游异常,throw 而非静默返回。
      if (body.data.id !== transactionId) {
        throw new Error(`paddle getTransactionStatus id mismatch: asked=${transactionId} got=${body.data.id}`);
      }
      const status = typeof body.data.status === "string" ? body.data.status : "";
      if (status === "") return null;
      const paidAt = typeof body.data.billed_at === "string" ? body.data.billed_at : null;
      const custom = body.data.custom_data;
      const accountEmail =
        typeof custom?.account_email === "string" && custom.account_email !== ""
          ? custom.account_email
          : null;
      return { status, paidAt, accountEmail };
    },
  };
}

/** 校验 price_id 是否属于我方白名单。
 *
 *  **不能让客户端随便传 price_id**:那等于允许任何人拿一个自己知道的、更便宜的
 *  price 去结账。只放行白名单里的档位 —— 与 webhook 用的是同一份表,天然一致。 */
export function isKnownPriceId(priceId: string, priceMonths: PriceMonthsMap): boolean {
  // Object.hasOwn 而非 `in`/下标:普通对象字面量的原型链上有 toString 等,
  // 下标访问会返回 function 而非 undefined(webhook 侧踩过这个坑)。
  return priceId !== "" && Object.hasOwn(priceMonths, priceId);
}
