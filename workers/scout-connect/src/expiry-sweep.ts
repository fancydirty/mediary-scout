import type { CfApi } from "./cf-api.js";
import type { ConnectDb } from "./db.js";
import { daysLeftInGrace, daysUntilExpiry, graceUntil, phaseOf, reminderKind } from "./expiry.js";
import { revokeEndpoint } from "./revoke.js";

/**
 * 到期状态机的执行层:cron 每轮跑一遍。
 *
 * **默认 dry-run**:只把「将要做什么」写进审计,不真删 DNS / 隧道、不真发邮件。
 * 在实例上跑过一轮、确认时间边界算对了,再开真删 —— 这是四个 PR 里唯一会
 * 真删生产资源的,不可逆。
 *
 * 三个动作按阶段分:
 *   - 到期前 7/1 天:提醒邮件
 *   - 宽限期中:写 grace_until(标出还剩几天,供 console 显示),不发第二封
 *   - 宽限期满:revokeEndpoint(删 DNS + 删隧道,复用既有补偿逻辑),写 suspended_at
 */

export interface SweepDeps {
  db: ConnectDb;
  cf: CfApi;
  now: () => string;
  newAuditId: () => string;
  /** 发提醒邮件。dry-run 时不调用。 */
  sendEmail?: (input: { to: string; subject: string; text: string }) => Promise<void>;
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
        if (live && deps.sendEmail !== undefined) {
          try {
            await deps.sendEmail({
              to: row.accountEmail,
              subject:
                kind === "7d"
                  ? "Mediary Connect 将于 7 天后到期"
                  : "Mediary Connect 明天到期",
              text:
                `你的 Mediary Connect 远程访问将于 ${row.latestExpiry.slice(0, 10)} 到期` +
                `（还有 ${days} 天）。到期后有 7 天宽限期,宽限期后域名会停止解析;` +
                `随时回来续期,配置原样恢复。续期:https://mediaryconnect.app/pricing`,
            });
          } catch (e) {
            result.errors.push({
              endpointId: row.endpointId,
              action: "email",
              error: e instanceof Error ? e.message : String(e),
            });
            continue; // 邮件失败不影响该行后续动作
          }
        }
        await deps.db.insertAudit({
          id: deps.newAuditId(),
          at: now,
          actor: "cron",
          action: auditAction,
          invite_id: null,
          endpoint_id: row.endpointId,
          detail_json: JSON.stringify({ days, expiry: row.latestExpiry, dry_run: !live }),
        });
      }
      continue;
    }

    if (phase === "grace" && row.latestExpiry !== null) {
      result.inGrace++;
      const daysLeft = daysLeftInGrace(row.latestExpiry, now);
      // 标记宽限期(console 据此显示「宽限期中,剩 N 天」)。只在没写过时写,
      // 否则每轮 cron 都会覆盖一次 grace_until。
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
        await revokeEndpoint({ endpointId: row.endpointId, deps: { cf: deps.cf, db: deps.db, now: deps.now, newAuditId: deps.newAuditId } });
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
