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
