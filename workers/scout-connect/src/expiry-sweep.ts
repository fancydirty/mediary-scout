import type { CfApi } from "./cf-api.js";
import type { ConnectDb } from "./db.js";
import { daysLeftInGrace, daysUntilExpiry, graceUntil, phaseOf, reminderKind } from "./expiry.js";
import { expiryReminderText } from "./email-sender.js";
import { revokeEndpoint } from "./revoke.js";

/**
 * 到期状态机的执行层:cron 每轮跑一遍。
 *
 * **默认 dry-run**:只把「将要做什么」写进审计,不真删 DNS / 隧道、不真发邮件。
 * 在实例上跑过一轮、确认时间边界算对了,再开真删 —— 这是四个 PR 里唯一会
 * 真删生产资源的,不可逆。
 *
 * 三个动作按阶段分(状态推进以审计行为准;不再维护 grace_until/suspended_at 列):
 *   - 到期前 7/1 天:提醒邮件 + 审计
 *   - 宽限期中:审计标出还剩几天(console 由 latestExpiry+GRACE_PERIOD_DAYS 现场算,
 *     与 cron 用同一份常量,不依赖这两列)
 *   - 宽限期满:revokeEndpoint(删 DNS + 删隧道,标 status='revoked',复用既有补偿逻辑)
 * 说明:宽限/到期的真值由 entitlements 的最新到期时刻决定,审计只做可观测留痕;
 * grace_until/suspended_at/purge_after 三列自 spec D1 起废弃(见设计文档)。
 */

export interface SweepDeps {
  db: ConnectDb;
  cf: CfApi;
  now: () => string;
  newAuditId: () => string;
  /** 发提醒邮件。dry-run 时不调用。 */
  sendEmail?: ((input: { to: string; subject: string; text: string }) => Promise<void>) | undefined;
  /** false(默认)= dry-run,只记审计。true = 真删真发。 */
  live?: boolean;
}

export interface SweepResult {
  scanned: number;
  reminders: number;
  inGrace: number;
  reclaimed: number;
  errors: { endpointId: string; action: string; error: string }[];
  dryRun: boolean;
}

export async function sweepExpiredEndpoints(deps: SweepDeps): Promise<SweepResult> {
  // **now 必须先卡 finite。** 一轮 cron 里所有状态判断共用此刻;NaN 会让
  // phaseOf 全部落到 expired(那是"该回收"的判断)—— 时钟坏绝不能触发真删。
  const now = deps.now();
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error("sweep aborted: non-finite now");
  }
  const live = deps.live === true;

  const result: SweepResult = {
    scanned: 0,
    reminders: 0,
    inGrace: 0,
    reclaimed: 0,
    errors: [],
    dryRun: !live,
  };

  const rows = await deps.db.listActiveEndpointsForSweep();
  result.scanned = rows.length;

  for (const row of rows) {
    const phase = phaseOf(row.latestExpiry, now);

    if (phase === "active" && row.latestExpiry !== null) {
      const kind = reminderKind(row.latestExpiry, now);
      if (kind !== null) {
        const days = daysUntilExpiry(row.latestExpiry, now);
        result.reminders++;
        const auditAction = `expiry.remind.${kind}`;
        let emailFailed: string | null = null;
        if (live && deps.sendEmail !== undefined) {
          try {
            await deps.sendEmail({
              to: row.accountEmail,
              subject:
                kind === "7d"
                  ? "Mediary Connect 将于 7 天后到期"
                  : "Mediary Connect 明天到期",
              text: expiryReminderText({
                expiryDate: row.latestExpiry.slice(0, 10),
                daysLeft: days,
                hostname: row.hostname,
              }),
            });
          } catch (e) {
            result.errors.push({
              endpointId: row.endpointId,
              action: "email",
              error: e instanceof Error ? e.message : String(e),
            });
            emailFailed = e instanceof Error ? e.message : String(e);
          }
        }
        // **无论邮件成败都记审计** —— 邮件失败恰恰是更需要留痕的情形
        // (这是事后核对「是否通知到了用户」的唯一依据;失败会让"提醒过"
        // 在审计里消失,用户断联时无从排查)。早先 catch 里 continue 会跳过这步,
        // 与「邮件失败不影响该行后续动作」的注释直接相反。
        await deps.db.insertAudit({
          id: deps.newAuditId(),
          at: now,
          actor: "cron",
          action: auditAction,
          invite_id: null,
          endpoint_id: row.endpointId,
          detail_json: JSON.stringify({
            days,
            expiry: row.latestExpiry,
            // 区分四种状态,审计必须**客观准确**:
            //   sent    = live + 有发信器 + 发送成功
            //   failed  = live + 有发信器 + 发送抛错(email_error 里有原因)
            //   skipped = live 但**没配发信器**(发送尝试根本没发生)
            //   dry-run = 本就不发
            // 早先用 `emailFailed === null && live` 会在「live 但没配发信器」时
            // 记成 sent:true —— 发送根本没发生却报"已发",审计记录客观上就是错的
            // (Copilot round-2 指出)。
            email_status:
              !live ? "dry_run" : deps.sendEmail === undefined ? "skipped" : emailFailed === null ? "sent" : "failed",
            ...(emailFailed === null ? {} : { email_error: emailFailed }),
            dry_run: !live,
          }),
        });
      }
      continue;
    }

    if (phase === "grace" && row.latestExpiry !== null) {
      result.inGrace++;
      const daysLeft = daysLeftInGrace(row.latestExpiry, now);
      // 宽限期标记以**审计**形式记录(每轮 cron 一条,便于回看「第几天还在宽限」)。
      // 不再写 grace_until 列 —— 那列自 spec D1 起废弃,console 由 latestExpiry 现场算。
      await deps.db.insertAudit({
        id: deps.newAuditId(),
        at: now,
        actor: "cron",
        action: "expiry.in_grace",
        invite_id: null,
        endpoint_id: row.endpointId,
        detail_json: JSON.stringify({
          days_left: daysLeft,
          grace_until: graceUntil(row.latestExpiry),
          dry_run: !live,
        }),
      });
      continue;
    }

    if (phase === "expired") {
      // 宽限期满:回收。dry-run 只记将要回收什么。
      if (!live) {
        await deps.db.insertAudit({
          id: deps.newAuditId(),
          at: now,
          actor: "cron",
          action: "expiry.would_reclaim",
          invite_id: null,
          endpoint_id: row.endpointId,
          detail_json: JSON.stringify({
            hostname: row.hostname,
            cf_tunnel_id: row.cfTunnelId,
            cf_dns_record_id: row.cfDnsRecordId,
            dry_run: true,
          }),
        });
        continue;
      }
      try {
        // 复用 revoke 的删除顺序与错误收集(access app → dns → tunnel,
        // 一步失败不阻止其余尝试)。
        await revokeEndpoint({ endpointId: row.endpointId, deps: { cf: deps.cf, db: deps.db, now: () => now, newAuditId: deps.newAuditId } });
        result.reclaimed++;
        await deps.db.insertAudit({
          id: deps.newAuditId(),
          at: now,
          actor: "cron",
          action: "expiry.reclaimed",
          invite_id: null,
          endpoint_id: row.endpointId,
          detail_json: JSON.stringify({ hostname: row.hostname }),
        });
      } catch (e) {
        result.errors.push({
          endpointId: row.endpointId,
          action: "reclaim",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return result;
}
