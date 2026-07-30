import { createCfApi } from "./cf-api.js";
import { createD1ConnectDb } from "./db.js";
import { newId, newInviteCode } from "./ids.js";
import { handleRequest } from "./routes.js";
import { createMagicLinkSender } from "./magic-link-sender.js";
import type { Env } from "./env.js";

/** 取值或显式抛错。某些 env(如 RESEND_API_KEY)对**部分**路径可选(到期提醒),
 *  但对其它路径(登录)是必需的 —— 在必需处显式断言,比让 undefined 流到下游
 *  变成隐晦失败好。 */
function requireEnv(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required but not configured`);
  }
  return value;
}
import { createPaddleApi } from "./paddle-api.js";
import { priceMonthsFor } from "./paddle-event.js";
import { sweepExpiredEndpoints } from "./expiry-sweep.js";
import { createEmailSender } from "./email-sender.js";

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

export default {
  // 到期巡检。cron 触发时**默认 dry-run**:只把「将做什么」写进审计,
  // 不真删 DNS/隧道、不发邮件。EXPIRY_SWEEP_LIVE=true 才开真删 ——
  // 这是唯一会真删生产资源的路径,先在实例上验证时间边界再放开。
  async scheduled(_event: CronScheduledEvent, env: Env, ctx: WorkersExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweepExpiredEndpoints({
        db: createD1ConnectDb(env.DB),
        cf: createCfApi({
          accountId: env.CF_ACCOUNT_ID,
          zoneId: env.CF_ZONE_ID,
          apiToken: env.CF_API_TOKEN,
        }),
        now: () => new Date().toISOString(),
        newAuditId: () => newId("aud"),
        // dry-run 时不需要发信器(sweep 只在 live 且配置了时才调它)。
        // 没配 RESEND key 时即便 live 也只是邮件发不出去,回收照走。
        sendEmail:
          env.RESEND_API_KEY === undefined || env.RESEND_API_KEY.trim() === ""
            ? undefined
            : createEmailSender(env.RESEND_API_KEY),
        live: env.EXPIRY_SWEEP_LIVE === "true",
      }).catch((e) => {
        // 顶层兜底:任一轮失败不能让 cron 静默消失 —— 记录日志,下一轮再试。
        console.error("expiry sweep failed:", e instanceof Error ? e.message : String(e));
      }),
    );
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
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
      paddleClientToken: env.PADDLE_CLIENT_TOKEN,
      paddleEnvironment: env.PADDLE_ENVIRONMENT,
      paddleWebhookSecret: env.PADDLE_WEBHOOK_SECRET,
      // 按环境选白名单。**未配置时是 undefined 而非回落 sandbox** ——
      // 路由层据此 fail-closed(503),见 routes.ts 的注释。
      paddlePriceMonths: priceMonthsFor(env.PADDLE_ENVIRONMENT) ?? undefined,
      paddleApi:
        env.PADDLE_API_KEY === undefined || env.PADDLE_API_KEY.trim() === ""
          ? undefined
          : createPaddleApi({
              apiKey: env.PADDLE_API_KEY,
              environment: env.PADDLE_ENVIRONMENT ?? "production",
            }),
      turnstileSecret: env.TURNSTILE_SECRET,
      newAccountId: () => newId("act"),
      newEntitlementId: () => newId("ent"),
      sessionSecret: env.SESSION_SECRET,
      // 登录魔法链接**必需** key —— 缺失时显式抛错(而不是让 Bearer undefined
      // 流到 fetch 里变成隐晦的上游 401)。到期提醒可无(上面 sendEmail 的条件),
      // 但登录是核心功能,没 key 就该 fail fast。
      sendMagicLink: createMagicLinkSender(requireEnv(env.RESEND_API_KEY, "RESEND_API_KEY")),
    });
  },
};
