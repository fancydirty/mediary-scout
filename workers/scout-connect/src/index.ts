import { createCfApi } from "./cf-api.js";
import { createD1ConnectDb } from "./db.js";
import { newId, newInviteCode } from "./ids.js";
import { handleRequest } from "./routes.js";
import { createMagicLinkSender } from "./magic-link-sender.js";
import type { Env } from "./env.js";

export default {
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
      turnstileSecret: env.TURNSTILE_SECRET,
      newAccountId: () => newId("act"),
      newEntitlementId: () => newId("ent"),
      sessionSecret: env.SESSION_SECRET,
      sendMagicLink: createMagicLinkSender(env.RESEND_API_KEY),
    });
  },
};
