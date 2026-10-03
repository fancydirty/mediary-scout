import { createCfApi } from "./cf-api.js";
import { createD1ConnectDb } from "./db.js";
import { newId, newInviteCode } from "./ids.js";
import { handleRequest, reconcileWaffoOrders, type RouteDeps } from "./routes.js";
import { createMagicLinkSender } from "./magic-link-sender.js";
import { createInstanceLinkSender } from "./instance-link-sender.js";
import type { Env } from "./env.js";
import { createWaffoApi, type WaffoApi } from "./waffo-api.js";
import { sweepExpiredEndpoints } from "./expiry-sweep.js";
import { createEmailSender } from "./email-sender.js";

/** 取值或显式抛错。某些 env(如 RESEND_API_KEY)对**部分**路径可选(到期提醒),
 *  但对其它路径(登录)是必需的 —— 在必需处显式断言,比让 undefined 流到下游
 *  变成隐晦失败好。 */
function requireEnv(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(name + " is required but not configured");
  }
  return value;
}

// Workers 运行时注入的类型。本仓不引 @cloudflare/workers-types(只为这一个
// 签名拉整个包不值),这里做最小声明。scheduled/cron 的真实签名见
// developers.cloudflare.com/workers/runtime-apis/scheduled-event。
interface CronScheduledEvent {
  readonly scheduledTime: number;
  readonly cron: string;
}
interface WorkersExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function createWaffoFromEnv(env: Env): WaffoApi | undefined {
  const values = {
    merchantId: env.WAFFO_MERCHANT_ID,
    storeId: env.WAFFO_STORE_ID,
    environment: env.WAFFO_ENVIRONMENT,
    privateKey: env.WAFFO_PRIVATE_KEY,
    productQuarter: env.WAFFO_PRODUCT_QUARTER,
    productYear: env.WAFFO_PRODUCT_YEAR,
    productTwoYears: env.WAFFO_PRODUCT_TWO_YEARS,
  };
  if (Object.values(values).some((value) => value === undefined || value.trim() === "")) return undefined;
  try {
    return createWaffoApi({
      merchantId: values.merchantId!,
      storeId: values.storeId!,
      environment: values.environment!,
      privateKey: values.privateKey!,
      productQuarter: values.productQuarter!,
      productYear: values.productYear!,
      productTwoYears: values.productTwoYears!,
    });
  } catch {
    console.error("Waffo payment configuration is invalid");
    return undefined;
  }
}

function routeDeps(env: Env, waffoApi: WaffoApi | undefined, scheduled = false): RouteDeps {
  return {
    db: createD1ConnectDb(env.DB),
    cf: createCfApi({
      accountId: env.CF_ACCOUNT_ID,
      zoneId: env.CF_ZONE_ID,
      apiToken: env.CF_API_TOKEN,
    }),
    adminToken: env.ADMIN_TOKEN,
    rootDomain: env.CONNECT_ROOT_DOMAIN,
    tokenWrapKeyHex: env.TOKEN_WRAP_KEY,
    now: () => new Date().toISOString(),
    newInviteId: () => newId("inv"),
    newEndpointId: () => newId("ep"),
    newAuditId: () => newId("aud"),
    newInviteCode,
    turnstileSitekey: env.TURNSTILE_SITEKEY,
    waffoApi,
    waffoEnvironment: env.WAFFO_ENVIRONMENT === "prod" || env.WAFFO_ENVIRONMENT === "test"
      ? env.WAFFO_ENVIRONMENT
      : undefined,
    waffoStoreId: env.WAFFO_STORE_ID,
    waffoProducts: {
      quarter: env.WAFFO_PRODUCT_QUARTER ?? "",
      year: env.WAFFO_PRODUCT_YEAR ?? "",
      two_years: env.WAFFO_PRODUCT_TWO_YEARS ?? "",
    },
    turnstileSecret: env.TURNSTILE_SECRET,
    newAccountId: () => newId("act"),
    newEntitlementId: () => newId("ent"),
    sessionSecret: env.SESSION_SECRET,
    // 登录魔法链接**必需** key —— 缺失时显式抛错(而不是让 Bearer undefined
    // 流到 fetch 里变成隐晦的上游 401)。到期提醒可无(上面 sendEmail 的条件),
    // 但登录是核心功能,没 key 就该 fail fast。
    sendMagicLink: scheduled
      ? async () => {}
      : createMagicLinkSender(requireEnv(env.RESEND_API_KEY, "RESEND_API_KEY")),
    sendInstanceLinkEmail: scheduled
      ? async () => {}
      : createInstanceLinkSender(requireEnv(env.RESEND_API_KEY, "RESEND_API_KEY")),
  };
}

// 连接请求过期 7 天后删掉:轮询早就拿不到东西,留着只是攒邮箱和 IP。
const INSTANCE_LINK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INSTANCE_LINK_RETENTION_BATCH = 1000;
// 一轮最多删 10 批:积压超过一万条时剩下的留给第二天,不让一次 cron 跑太久。
const INSTANCE_LINK_RETENTION_MAX_BATCHES = 10;

async function deleteExpiredInstanceLinkRequests(deps: RouteDeps, cutoffIso: string): Promise<void> {
  for (let batch = 0; batch < INSTANCE_LINK_RETENTION_MAX_BATCHES; batch += 1) {
    const deleted = await deps.db.deleteInstanceLinkRequestsExpiredBefore(cutoffIso, INSTANCE_LINK_RETENTION_BATCH);
    if (deleted < INSTANCE_LINK_RETENTION_BATCH) return;
  }
}

export async function runScheduledMaintenance(
  deps: RouteDeps,
  options: { live: boolean; resendApiKey?: string | undefined },
): Promise<void> {
  const nowMs = Date.parse(deps.now());
  const retention = Number.isFinite(nowMs)
    ? deleteExpiredInstanceLinkRequests(deps, new Date(nowMs - INSTANCE_LINK_RETENTION_MS).toISOString())
        .catch((error) => {
          console.error("instance-link retention failed:", error instanceof Error ? error.message : String(error));
        })
    : Promise.resolve(console.error("instance-link retention skipped: invalid time"));
  await Promise.all([
    retention,
    sweepExpiredEndpoints({
      db: deps.db,
      cf: deps.cf,
      now: deps.now,
      newAuditId: deps.newAuditId,
      // dry-run 时不需要发信器(sweep 只在 live 且配置了时才调它)。
      // 没配 RESEND key 时即便 live 也只是邮件发不出去,回收照走。
      sendEmail:
        options.resendApiKey === undefined || options.resendApiKey.trim() === ""
          ? undefined
          : createEmailSender(options.resendApiKey),
      live: options.live,
    }).catch((error) => {
      // 顶层兜底:任一轮失败不能让 cron 静默消失 —— 记录日志,下一轮再试。
      console.error("expiry sweep failed:", error instanceof Error ? error.message : String(error));
    }),
    reconcileWaffoOrders(deps).catch((error) => {
      // 同一轮的 Waffo 对账失败也只影响下一轮,不能吞掉其它 cron 工作。
      console.error("Waffo reconciliation scan failed:", error instanceof Error ? error.message : String(error));
    }),
  ]);
}

export default {
  // 到期巡检。cron 触发时**默认 dry-run**:只把「将做什么」写进审计,
  // 不真删 DNS/隧道、不发邮件。EXPIRY_SWEEP_LIVE=true 才开真删 ——
  // 这是唯一会真删生产资源的路径,先在实例上验证时间边界再放开。
  async scheduled(_event: CronScheduledEvent, env: Env, ctx: WorkersExecutionContext): Promise<void> {
    const waffoApi = createWaffoFromEnv(env);
    const deps = routeDeps(env, waffoApi, true);
    ctx.waitUntil(
      runScheduledMaintenance(deps, {
        live: env.EXPIRY_SWEEP_LIVE === "true",
        resendApiKey: env.RESEND_API_KEY,
      }),
    );
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, routeDeps(env, createWaffoFromEnv(env)));
  },
};
