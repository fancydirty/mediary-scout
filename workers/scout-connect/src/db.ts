export interface InviteRow {
  id: string;
  code: string;
  invitee_label: string | null;
  email: string;
  slug: string | null;
  status: "pending" | "provisioned" | "revoked";
  created_at: string;
  provisioned_at: string | null;
  revoked_at: string | null;
}

export interface EndpointRow {
  id: string;
  /** null since 0004:自助开通的行没有 invite;邀请制的行仍非空且 UNIQUE。 */
  invite_id: string | null;
  slug: string;
  hostname: string;
  cf_tunnel_id: string;
  cf_access_app_id: string | null;
  cf_access_policy_id: string | null;
  cf_dns_record_id: string;
  status: "active" | "revoked" | "revoke_failed";
  token_sha256: string;
  token_ciphertext: string | null;
  token_shown_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
  // P3 (migration 0003): 付费账号关联 + 到期三阶段(决策 #14)。均可空:
  // 内测邀请制的行 account_id 为 null;未进入到期流程的行三个时间戳为 null。
  // 0004 起为必填字段(值仍可 null):读写路径都必须携带,否则 D1 写路径
  // 静默丢列而内存 mock 整行展开——「内存绿生产坏」(spec 断点 #2)。
  account_id: string | null;
  grace_until: string | null;
  suspended_at: string | null;
  purge_after: string | null;
}

/** P3: 付费账号。邮箱即身份;paddle_customer_id 内测手工开的为 null。 */
export interface AccountRow {
  id: string;
  email: string;
  paddle_customer_id: string | null;
  created_at: string;
  last_login_at: string | null;
}

/** P3: 预付时长账本。每次充值一行,expires_at 由业务层叠加计算后写入。 */
export interface EntitlementRow {
  id: string;
  account_id: string;
  expires_at: string;
  source: "paddle" | "founding" | "manual" | "beta";
  paddle_transaction_id: string | null;
  months: number;
  created_at: string;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  invite_id: string | null;
  endpoint_id: string | null;
  detail_json: string | null;
}

export interface WaitlistRow {
  id: string;
  email: string;
  batch: number;
  status: string;
  created_at: string;
  /** Optional post-signup survey answers as a JSON string; null until answered. */
  survey_json: string | null;
}

export interface InviteStatusPatch {
  status: InviteRow["status"];
  slug?: string | null;
  provisioned_at?: string | null;
  revoked_at?: string | null;
}

export interface ConnectDb {
  insertInvite(row: InviteRow): Promise<InviteRow>;
  getInviteById(id: string): Promise<InviteRow | null>;
  getInviteByCode(code: string): Promise<InviteRow | null>;
  listInvites(): Promise<InviteRow[]>;
  updateInviteStatus(id: string, patch: InviteStatusPatch): Promise<void>;
  insertEndpoint(row: EndpointRow): Promise<EndpointRow>;
  getEndpointById(id: string): Promise<EndpointRow | null>;
  getEndpointByInviteId(inviteId: string): Promise<EndpointRow | null>;
  /** 账号名下唯一的 active endpoint(P4/P5:取件码签发用)。 */
  getActiveEndpointByAccountId(accountId: string): Promise<EndpointRow | null>;
  /** Targeted existence check for the slug/hostname availability precheck. */
  findEndpointBySlugOrHostname(slug: string, hostname: string): Promise<Pick<EndpointRow, "slug" | "hostname"> | null>;
  listEndpoints(): Promise<EndpointRow[]>;
  /** 仍占用 CF 隧道配额的 endpoint 数(容量闸门用)。
   *
   *  **计数语义是可卖不可卖的分界,改它前先读 capacity.test.ts:**
   *  - `active` 计入(含宽限期/已停用但未删隧道——schema 注释明确这两种是
   *    时间戳态,status 仍 'active',确实还占着隧道)
   *  - `revoke_failed` **偏保守计入**:CF 侧删除失败,隧道可能还在。宁可少卖
   *    (可人工核查),不可超卖(撞 CF 上限就是收了钱交不了货)
   *  - `revoked` 不计入:隧道已删,不占配额 */
  countLiveEndpoints(): Promise<number>;
  /**
   * Atomic burn: sets shown_at + nulls ciphertext only if not already burned.
   * Returns true when THIS call performed the burn (won the race), false when
   * the token was already shown/burned — callers use this for once-only reveal.
   */
  markEndpointRevoked(endpointId: string, at: string): Promise<void>;
  markEndpointRevokeFailed(endpointId: string): Promise<void>;
  /** Best-effort row removal for orphan compensation (no-op when absent). */
  deleteEndpoint(endpointId: string): Promise<void>;
  insertAudit(row: AuditRow): Promise<void>;
  listAudits(): Promise<AuditRow[]>;
  insertWaitlist(row: WaitlistRow): Promise<WaitlistRow>;
  getWaitlistByEmail(email: string, batch: number): Promise<WaitlistRow | null>;
  getWaitlistById(id: string): Promise<WaitlistRow | null>;
  /**
   * Stores the optional post-signup survey (a JSON string) on the row.
   * UPDATE semantics: a nonexistent id is a silent no-op — the route is
   * responsible for the 404 precheck.
   */
  updateWaitlistSurvey(id: string, surveyJson: string): Promise<void>;
  countWaitlist(batch: number): Promise<number>;
  /**
   * 1-based queue position of the row identified by (`batch`, `createdAt`,
   * `id`), counting every row that sorts at or before it under the composite
   * order (created_at, id).
   *
   * Why composite: created_at is a whole-second ISO string, so same-second
   * signups are routine. A `created_at <= ?` count gives every tied row the
   * SAME position (measured: three rows sharing one timestamp all reported 3).
   * `id` is the PRIMARY KEY, so (created_at, id) is unique and the rank is
   * distinct and stable.
   *
   * The predicate is deliberately spelled `created_at <= ? AND (created_at < ?
   * OR id <= ?)` instead of the equivalent `created_at < ? OR (created_at = ?
   * AND id <= ?)`: only the former keeps the created_at range bound on
   * idx_waitlist_batch_created. The OR-first form still "uses the index" but
   * degrades to `(batch=?)`, walking the whole batch on an unauthenticated
   * path. See the query-plan assertion in schema.test.ts.
   */
  waitlistRankOf(batch: number, createdAt: string, id: string): Promise<number>;
  listWaitlist(batch: number): Promise<WaitlistRow[]>;
  getEndpointByTokenSha256(sha256: string): Promise<EndpointRow | null>;
  updateEndpointLastSeen(endpointId: string, lastSeenAt: string): Promise<void>;
  // P3: accounts + entitlements
  insertAccount(row: AccountRow): Promise<AccountRow>;
  getAccountById(id: string): Promise<AccountRow | null>;
  getAccountByEmail(email: string): Promise<AccountRow | null>;
  updateAccountLastLogin(id: string, at: string): Promise<void>;
  /** 幂等插入时长记录。paddle_transaction_id 已存在时返回 false(不重复加时长)。 */
  insertEntitlement(row: EntitlementRow): Promise<boolean>;
  /** 修正某笔时长的 expires_at。
   *
   *  用于并发下的账本收敛:「读最新到期→加N月→写」在并发时会 lost update
   *  (两笔都基于同一快照,用户付 24 个月只拿到 12)。写入后从整本账重算,
   *  与快照不符就用这个方法修正。见 grant.ts 与 entitlement.ts:recomputeExpiry。 */
  updateEntitlementExpiry(entitlementId: string, expiresAt: string): Promise<void>;
  listEntitlements(accountId: string): Promise<EntitlementRow[]>;
}

// Minimal ambient D1 types (intentionally not @cloudflare/workers-types).
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

type RawRow = Record<string, unknown>;

function mapInvite(row: RawRow): InviteRow {
  return {
    id: row.id as string,
    code: row.code as string,
    invitee_label: row.invitee_label as string | null,
    email: row.email as string,
    slug: row.slug as string | null,
    status: row.status as InviteRow["status"],
    created_at: row.created_at as string,
    provisioned_at: row.provisioned_at as string | null,
    revoked_at: row.revoked_at as string | null,
  };
}

function mapEndpoint(row: RawRow): EndpointRow {
  return {
    id: row.id as string,
    invite_id: row.invite_id as string | null,
    slug: row.slug as string,
    hostname: row.hostname as string,
    cf_tunnel_id: row.cf_tunnel_id as string,
    cf_access_app_id: row.cf_access_app_id as string | null,
    cf_access_policy_id: row.cf_access_policy_id as string | null,
    cf_dns_record_id: row.cf_dns_record_id as string,
    status: row.status as EndpointRow["status"],
    token_sha256: row.token_sha256 as string,
    token_ciphertext: row.token_ciphertext as string | null,
    token_shown_at: row.token_shown_at as string | null,
    last_seen_at: row.last_seen_at as string | null,
    created_at: row.created_at as string,
    revoked_at: row.revoked_at as string | null,
    // ?? null:0003 之前建的行 SELECT * 不带这些列(undefined),归一为 null,
    // 避免上游要区分「没有这列」与「值是 null」两种形态。
    account_id: (row.account_id as string | null | undefined) ?? null,
    grace_until: (row.grace_until as string | null | undefined) ?? null,
    suspended_at: (row.suspended_at as string | null | undefined) ?? null,
    purge_after: (row.purge_after as string | null | undefined) ?? null,
  };
}

function mapAudit(row: RawRow): AuditRow {
  return {
    id: row.id as string,
    at: row.at as string,
    actor: row.actor as string,
    action: row.action as string,
    invite_id: row.invite_id as string | null,
    endpoint_id: row.endpoint_id as string | null,
    detail_json: row.detail_json as string | null,
  };
}

function mapWaitlist(row: RawRow): WaitlistRow {
  return {
    id: row.id as string,
    email: row.email as string,
    batch: row.batch as number,
    status: row.status as string,
    created_at: row.created_at as string,
    // Coalesce, don't cast: against a pre-0002 schema (migration not yet run),
    // SELECT * returns no survey_json column at all → `undefined`, which would
    // break the `string | null` contract and silently vanish from JSON responses.
    survey_json: (row.survey_json as string | null | undefined) ?? null,
  };
}

export function createD1ConnectDb(d1: D1Database): ConnectDb {
  return {
    async insertInvite(row) {
      await d1
        .prepare(
          `INSERT INTO invites (id, code, invitee_label, email, slug, status, created_at, provisioned_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.code,
          row.invitee_label,
          row.email,
          row.slug,
          row.status,
          row.created_at,
          row.provisioned_at,
          row.revoked_at,
        )
        .run();
      return { ...row };
    },

    async getInviteById(id) {
      const row = await d1
        .prepare(`SELECT * FROM invites WHERE id = ?`)
        .bind(id)
        .first<RawRow>();
      return row === null ? null : mapInvite(row);
    },

    async getInviteByCode(code) {
      const row = await d1
        .prepare(`SELECT * FROM invites WHERE code = ?`)
        .bind(code)
        .first<RawRow>();
      return row === null ? null : mapInvite(row);
    },

    async listInvites() {
      const { results } = await d1
        .prepare(`SELECT * FROM invites ORDER BY created_at DESC, id DESC`)
        .all<RawRow>();
      return results.map(mapInvite);
    },

    async updateInviteStatus(id, patch) {
      const sets: string[] = ["status = ?"];
      const values: unknown[] = [patch.status];
      if (patch.slug !== undefined) {
        sets.push("slug = ?");
        values.push(patch.slug);
      }
      if (patch.provisioned_at !== undefined) {
        sets.push("provisioned_at = ?");
        values.push(patch.provisioned_at);
      }
      if (patch.revoked_at !== undefined) {
        sets.push("revoked_at = ?");
        values.push(patch.revoked_at);
      }
      values.push(id);
      await d1
        .prepare(`UPDATE invites SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...values)
        .run();
    },

    async insertEndpoint(row) {
      // 四个 0003 列必须在列清单里:漏掉的话 D1 静默丢值而内存 mock 整行
      // 展开,测试绿、生产 account_id 丢失(spec 断点 #2 的「内存绿生产坏」)。
      await d1
        .prepare(
          `INSERT INTO endpoints (id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id, cf_access_policy_id, cf_dns_record_id, status, token_sha256, token_ciphertext, token_shown_at, last_seen_at, created_at, revoked_at, account_id, grace_until, suspended_at, purge_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.invite_id,
          row.slug,
          row.hostname,
          row.cf_tunnel_id,
          row.cf_access_app_id,
          row.cf_access_policy_id,
          row.cf_dns_record_id,
          row.status,
          row.token_sha256,
          row.token_ciphertext,
          row.token_shown_at,
          row.last_seen_at,
          row.created_at,
          row.revoked_at,
          row.account_id,
          row.grace_until,
          row.suspended_at,
          row.purge_after,
        )
        .run();
      return { ...row };
    },

    async getEndpointById(id) {
      const row = await d1
        .prepare(`SELECT * FROM endpoints WHERE id = ?`)
        .bind(id)
        .first<RawRow>();
      return row === null ? null : mapEndpoint(row);
    },

    async getEndpointByInviteId(inviteId) {
      const row = await d1
        .prepare(`SELECT * FROM endpoints WHERE invite_id = ?`)
        .bind(inviteId)
        .first<RawRow>();
      return row === null ? null : mapEndpoint(row);
    },

    async getActiveEndpointByAccountId(accountId) {
      // ORDER BY 保证多 active 行时确定性(schema 不阻止一账号多 endpoint;
      // 无 ORDER BY 时 SQLite 返回任意行,取件码签发会不确定)。取最早建的。
      const row = await d1
        .prepare(
          `SELECT * FROM endpoints WHERE account_id = ? AND status = 'active' ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .bind(accountId)
        .first<RawRow>();
      return row === null ? null : mapEndpoint(row);
    },

    async findEndpointBySlugOrHostname(slug, hostname) {
      const row = await d1
        .prepare(`SELECT slug, hostname FROM endpoints WHERE slug = ? OR hostname = ? LIMIT 1`)
        .bind(slug, hostname)
        .first<RawRow>();
      return row === null
        ? null
        : { slug: row.slug as string, hostname: row.hostname as string };
    },

    async listEndpoints() {
      const { results } = await d1
        .prepare(`SELECT * FROM endpoints ORDER BY created_at DESC, id DESC`)
        .all<RawRow>();
      return results.map(mapEndpoint);
    },

    async countLiveEndpoints() {
      // 只数仍占 CF 配额的状态(见接口注释)。用 IN 而非 != 'revoked':
      // 将来新增 status 值时,默认**不**计入比默认计入更安全——漏计会超卖,
      // 而多计只是少卖。显式白名单让新状态必须主动决定归属。
      const row = await d1
        .prepare(
          `SELECT COUNT(*) as cnt FROM endpoints WHERE status IN ('active', 'revoke_failed')`,
        )
        .first<{ cnt: number }>();
      return row?.cnt ?? 0;
    },

    async markEndpointRevoked(endpointId, at) {
      await d1
        .prepare(`UPDATE endpoints SET status = 'revoked', revoked_at = ? WHERE id = ?`)
        .bind(at, endpointId)
        .run();
    },

    async markEndpointRevokeFailed(endpointId) {
      await d1
        .prepare(`UPDATE endpoints SET status = 'revoke_failed' WHERE id = ?`)
        .bind(endpointId)
        .run();
    },

    async deleteEndpoint(endpointId) {
      await d1
        .prepare(`DELETE FROM endpoints WHERE id = ?`)
        .bind(endpointId)
        .run();
    },

    async insertAudit(row) {
      await d1
        .prepare(
          `INSERT INTO audit_events (id, at, actor, action, invite_id, endpoint_id, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.id, row.at, row.actor, row.action, row.invite_id, row.endpoint_id, row.detail_json)
        .run();
    },

    async listAudits() {
      const { results } = await d1
        .prepare(`SELECT * FROM audit_events ORDER BY at DESC, id DESC`)
        .all<RawRow>();
      return results.map(mapAudit);
    },

    async insertWaitlist(row) {
      try {
        await d1
          .prepare(
            `INSERT INTO waitlist (id, email, batch, status, created_at, survey_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(row.id, row.email, row.batch, row.status, row.created_at, row.survey_json)
          .run();
      } catch (e) {
        // Migration-window fallback: if the worker got deployed BEFORE
        // migrations/0002-waitlist-survey.sql ran, the column doesn't exist and
        // every signup would 500 — a public-funnel outage caused by deploy order.
        // Degrade to the legacy column list instead (survey silently off until
        // the migration runs). Match BOTH phrasings of the missing-column error:
        // "no such column: x" and "no column named x" — the exact wording varies
        // across SQLite/D1 versions, and a too-narrow match would silently
        // disable the fallback in exactly the window it exists for.
        // Only schema-mismatch errors fall back — UNIQUE violations and real
        // outages must propagate unchanged.
        const msg = e instanceof Error ? e.message : "";
        const isMissingColumn =
          msg.includes("survey_json") &&
          (msg.includes("no such column") || msg.includes("no column named"));
        if (!isMissingColumn) {
          throw e;
        }
        await d1
          .prepare(
            `INSERT INTO waitlist (id, email, batch, status, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(row.id, row.email, row.batch, row.status, row.created_at)
          .run();
      }
      return row;
    },

    async getWaitlistByEmail(email, batch) {
      const row = await d1
        .prepare(`SELECT * FROM waitlist WHERE email = ? AND batch = ?`)
        .bind(email, batch)
        .first<RawRow>();
      return row ? mapWaitlist(row) : null;
    },

    async getWaitlistById(id) {
      const row = await d1
        .prepare(`SELECT * FROM waitlist WHERE id = ?`)
        .bind(id)
        .first<RawRow>();
      return row ? mapWaitlist(row) : null;
    },

    async updateWaitlistSurvey(id, surveyJson) {
      await d1
        .prepare(`UPDATE waitlist SET survey_json = ? WHERE id = ?`)
        .bind(surveyJson, id)
        .run();
    },

    async countWaitlist(batch) {
      const row = await d1
        .prepare(`SELECT COUNT(*) as cnt FROM waitlist WHERE batch = ?`)
        .bind(batch)
        .first<{ cnt: number }>();
      return row?.cnt ?? 0;
    },

    async waitlistRankOf(batch, createdAt, id) {
      // Intentionally status-agnostic: every row in the batch is counted,
      // whatever its `status`. Safe only because 'pending' is the sole value
      // that exists today (routes.ts writes it, schema.sql defaults to it,
      // nothing reads the column). Adding a `status = 'pending'` predicate now
      // would be a provable no-op. If a second status is ever introduced, this
      // and the in-memory twin below must change TOGETHER; the TRIPWIRE tests
      // in schema.test.ts and db.test.ts fail loudly if they do not.
      const row = await d1
        .prepare(
          `SELECT COUNT(*) as cnt FROM waitlist
             WHERE batch = ? AND created_at <= ? AND (created_at < ? OR id <= ?)`,
        )
        .bind(batch, createdAt, createdAt, id)
        .first<{ cnt: number }>();
      return row?.cnt ?? 0;
    },

    async listWaitlist(batch) {
      // (created_at, id) — the SAME composite order waitlistRankOf counts
      // under. created_at alone is not a total order (whole-second ISO
      // strings), so ties came back in arbitrary/physical order and the row
      // listed first could report a different position: measured wl_c wl_a
      // wl_b here against wl_a=1 wl_b=2 wl_c=3 from the rank query. `id` is
      // the PRIMARY KEY, so the composite is unique and the queue is total.
      const { results } = await d1
        .prepare(`SELECT * FROM waitlist WHERE batch = ? ORDER BY created_at ASC, id ASC`)
        .bind(batch)
        .all<RawRow>();
      return results.map(mapWaitlist);
    },

    async getEndpointByTokenSha256(sha256) {
      const row = await d1
        .prepare(`SELECT * FROM endpoints WHERE token_sha256 = ?`)
        .bind(sha256)
        .first<RawRow>();
      return row ? mapEndpoint(row) : null;
    },

    async updateEndpointLastSeen(endpointId, lastSeenAt) {
      await d1
        .prepare(`UPDATE endpoints SET last_seen_at = ? WHERE id = ?`)
        .bind(lastSeenAt, endpointId)
        .run();
    },

    async insertAccount(row) {
      await d1
        .prepare(
          `INSERT INTO accounts (id, email, paddle_customer_id, created_at, last_login_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(row.id, row.email, row.paddle_customer_id, row.created_at, row.last_login_at)
        .run();
      return { ...row };
    },

    async getAccountById(id) {
      const row = await d1.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
      return row === null ? null : row;
    },

    async getAccountByEmail(email) {
      const row = await d1
        .prepare(`SELECT * FROM accounts WHERE email = ?`)
        .bind(email)
        .first<AccountRow>();
      return row === null ? null : row;
    },

    async updateAccountLastLogin(id, at) {
      await d1.prepare(`UPDATE accounts SET last_login_at = ? WHERE id = ?`).bind(at, id).run();
    },

    async insertEntitlement(row) {
      // 幂等只针对 paddle_transaction_id 重投:用普通 INSERT,仅当报错确实是
      // paddle_transaction_id 的唯一冲突时才当幂等返回 false。INSERT OR IGNORE
      // 会连 id 主键冲突也一起吞掉,把真事故误判成"重复交易"(Copilot round 4)。
      try {
        await d1
          .prepare(
            `INSERT INTO entitlements
               (id, account_id, expires_at, source, paddle_transaction_id, months, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.account_id,
            row.expires_at,
            row.source,
            row.paddle_transaction_id,
            row.months,
            row.created_at,
          )
          .run();
        return true;
      } catch (e) {
        // 只把 idx_ent_txn(paddle_transaction_id 部分唯一索引)的冲突当幂等。
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE constraint failed/i.test(msg) && /paddle_transaction_id|idx_ent_txn/i.test(msg)) {
          return false;
        }
        throw e; // id 主键冲突等其它唯一冲突是真事故,原样抛。
      }
    },

    async updateEntitlementExpiry(entitlementId, expiresAt) {
      await d1
        .prepare(`UPDATE entitlements SET expires_at = ? WHERE id = ?`)
        .bind(expiresAt, entitlementId)
        .run();
    },

    async listEntitlements(accountId) {
      const rows = await d1
        .prepare(`SELECT * FROM entitlements WHERE account_id = ? ORDER BY created_at ASC`)
        .bind(accountId)
        .all<EntitlementRow>();
      return rows.results;
    },
  };
}

// Deterministic list ordering: timestamp DESC, id DESC as tiebreaker. Mirrors
// SQL `ORDER BY created_at DESC, id DESC`. localeCompare vs SQLite BINARY
// collation is equivalent here because callers write fixed-width ISO-8601 UTC.
function byCreatedAtDesc(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

// Ascending counterpart for queue order (oldest first). Mirrors SQL
// `ORDER BY created_at ASC, id ASC`, and must agree with the (created_at, id)
// composite that waitlistRankOf counts under — same caveat about localeCompare
// matching BINARY collation for fixed-width ISO-8601 UTC strings.
function byCreatedAtAsc(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

export function createMemoryConnectDb(): ConnectDb {
  const invites = new Map<string, InviteRow>();
  const endpoints = new Map<string, EndpointRow>();
  const audits = new Map<string, AuditRow>();
  const waitlist = new Map<string, WaitlistRow>();
  const accounts = new Map<string, AccountRow>();
  const entitlements = new Map<string, EntitlementRow>();

  return {
    async insertInvite(row) {
      if (invites.has(row.id)) {
        throw new Error(`UNIQUE constraint failed: invites.id (${row.id})`);
      }
      for (const existing of invites.values()) {
        if (existing.code === row.code) {
          throw new Error(`UNIQUE constraint failed: invites.code (${row.code})`);
        }
      }
      invites.set(row.id, { ...row });
      return { ...row };
    },

    async getInviteById(id) {
      const row = invites.get(id);
      return row === undefined ? null : { ...row };
    },

    async getInviteByCode(code) {
      for (const row of invites.values()) {
        if (row.code === code) {
          return { ...row };
        }
      }
      return null;
    },

    async listInvites() {
      return [...invites.values()].sort(byCreatedAtDesc).map((row) => ({ ...row }));
    },

    async updateInviteStatus(id, patch) {
      const row = invites.get(id);
      if (row === undefined) {
        return;
      }
      row.status = patch.status;
      if (patch.slug !== undefined) {
        row.slug = patch.slug;
      }
      if (patch.provisioned_at !== undefined) {
        row.provisioned_at = patch.provisioned_at;
      }
      if (patch.revoked_at !== undefined) {
        row.revoked_at = patch.revoked_at;
      }
    },

    async insertEndpoint(row) {
      if (endpoints.has(row.id)) {
        throw new Error(`UNIQUE constraint failed: endpoints.id (${row.id})`);
      }
      for (const existing of endpoints.values()) {
        // SQLite UNIQUE 对 NULL 不判重(0004):自助行 invite_id 全为 null,
        // 彼此共存;只有非空 invite_id 才判撞。
        if (row.invite_id !== null && existing.invite_id === row.invite_id) {
          throw new Error(`UNIQUE constraint failed: endpoints.invite_id (${row.invite_id})`);
        }
        if (existing.slug === row.slug) {
          throw new Error(`UNIQUE constraint failed: endpoints.slug (${row.slug})`);
        }
        if (existing.hostname === row.hostname) {
          throw new Error(`UNIQUE constraint failed: endpoints.hostname (${row.hostname})`);
        }
        // idx_endpoints_account_live(0004):一账号最多一个 live(active)行。
        // 与 D1 的部分唯一索引同款报错词面,让路由层的错误映射两侧一致。
        if (
          row.account_id !== null &&
          row.status === "active" &&
          existing.account_id === row.account_id &&
          existing.status === "active"
        ) {
          throw new Error(`UNIQUE constraint failed: endpoints.account_id (${row.account_id})`);
        }
      }
      endpoints.set(row.id, { ...row });
      return { ...row };
    },

    async getEndpointById(id) {
      const row = endpoints.get(id);
      return row === undefined ? null : { ...row };
    },

    async getEndpointByInviteId(inviteId) {
      for (const row of endpoints.values()) {
        if (row.invite_id === inviteId) {
          return { ...row };
        }
      }
      return null;
    },

    async getActiveEndpointByAccountId(accountId) {
      // 与 D1 实现一致:多 active 行时按 created_at,id 取最早,保证确定性。
      const matches = [...endpoints.values()].filter(
        (row) => row.account_id === accountId && row.status === "active",
      );
      if (matches.length === 0) return null;
      matches.sort((a, b) => {
        const t = Date.parse(a.created_at) - Date.parse(b.created_at);
        return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return { ...matches[0]! };
    },

    async findEndpointBySlugOrHostname(slug, hostname) {
      for (const row of endpoints.values()) {
        if (row.slug === slug || row.hostname === hostname) {
          return { slug: row.slug, hostname: row.hostname };
        }
      }
      return null;
    },

    async listEndpoints() {
      return [...endpoints.values()].sort(byCreatedAtDesc).map((row) => ({ ...row }));
    },

    async countLiveEndpoints() {
      // 与 D1 分支同款白名单(parity)。
      return [...endpoints.values()].filter(
        (r) => r.status === "active" || r.status === "revoke_failed",
      ).length;
    },

    async markEndpointRevoked(endpointId, at) {
      const row = endpoints.get(endpointId);
      if (row === undefined) {
        return;
      }
      row.status = "revoked";
      row.revoked_at = at;
    },

    async markEndpointRevokeFailed(endpointId) {
      const row = endpoints.get(endpointId);
      if (row === undefined) {
        return;
      }
      row.status = "revoke_failed";
    },

    async deleteEndpoint(endpointId) {
      endpoints.delete(endpointId);
    },

    async insertAudit(row) {
      if (audits.has(row.id)) {
        throw new Error(`UNIQUE constraint failed: audit_events.id (${row.id})`);
      }
      audits.set(row.id, { ...row });
    },

    async listAudits() {
      return [...audits.values()]
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
        .map((row) => ({ ...row }));
    },

    async insertWaitlist(row) {
      if (waitlist.has(row.id)) {
        throw new Error(`UNIQUE constraint failed: waitlist.id (${row.id})`);
      }
      for (const existing of waitlist.values()) {
        if (existing.email === row.email && existing.batch === row.batch) {
          throw new Error(`UNIQUE constraint failed: waitlist(email, batch) (${row.email}, ${row.batch})`);
        }
      }
      waitlist.set(row.id, { ...row });
      return { ...row };
    },

    async getWaitlistByEmail(email, batch) {
      for (const row of waitlist.values()) {
        if (row.email === email && row.batch === batch) {
          return { ...row };
        }
      }
      return null;
    },

    async getWaitlistById(id) {
      const row = waitlist.get(id);
      return row === undefined ? null : { ...row };
    },

    async updateWaitlistSurvey(id, surveyJson) {
      const row = waitlist.get(id);
      if (row !== undefined) {
        row.survey_json = surveyJson;
      }
    },

    async countWaitlist(batch) {
      let count = 0;
      for (const row of waitlist.values()) {
        if (row.batch === batch) count++;
      }
      return count;
    },

    async waitlistRankOf(batch, createdAt, id) {
      // Must match the D1 predicate exactly, including the (created_at, id)
      // tiebreaker — route tests run on this backend, so any drift here means
      // they stop proving anything about production.
      //
      // That includes being status-agnostic: like D1, this counts every row in
      // the batch regardless of `status`, because 'pending' is currently the
      // only value in existence. If you add a status filter, add it to BOTH
      // implementations — the TRIPWIRE tests (schema.test.ts for D1,
      // db.test.ts for this mock) go red on a one-sided change.
      let count = 0;
      for (const row of waitlist.values()) {
        if (row.batch !== batch) continue;
        if (row.created_at < createdAt || (row.created_at === createdAt && row.id <= id)) {
          count++;
        }
      }
      return count;
    },

    async listWaitlist(batch) {
      // Must match the D1 ORDER BY exactly — `(created_at ASC, id ASC)`, the
      // same composite waitlistRankOf counts under. Sorting on created_at
      // alone left Map insertion order to break ties, so listWaitlist[0] could
      // be the row that reports position 3. See the cross-consistency tests.
      return [...waitlist.values()]
        .filter((row) => row.batch === batch)
        .sort(byCreatedAtAsc)
        .map((row) => ({ ...row }));
    },

    async getEndpointByTokenSha256(sha256) {
      for (const row of endpoints.values()) {
        if (row.token_sha256 === sha256) {
          return { ...row };
        }
      }
      return null;
    },

    async updateEndpointLastSeen(endpointId, lastSeenAt) {
      const row = endpoints.get(endpointId);
      if (row !== undefined) {
        row.last_seen_at = lastSeenAt;
      }
    },

    async insertAccount(row) {
      if (accounts.has(row.id)) {
        throw new Error(`UNIQUE constraint failed: accounts.id (${row.id})`);
      }
      for (const existing of accounts.values()) {
        if (existing.email === row.email) {
          throw new Error(`UNIQUE constraint failed: accounts.email (${row.email})`);
        }
      }
      accounts.set(row.id, { ...row });
      return { ...row };
    },

    async getAccountById(id) {
      const row = accounts.get(id);
      return row === undefined ? null : { ...row };
    },

    async getAccountByEmail(email) {
      for (const row of accounts.values()) {
        if (row.email === email) return { ...row };
      }
      return null;
    },

    async updateAccountLastLogin(id, at) {
      const row = accounts.get(id);
      if (row !== undefined) row.last_login_at = at;
    },

    async insertEntitlement(row) {
      if (entitlements.has(row.id)) {
        throw new Error(`UNIQUE constraint failed: entitlements.id (${row.id})`);
      }
      // 幂等:paddle_transaction_id 重复 → 不插入,返回 false(镜像部分唯一索引)。
      if (row.paddle_transaction_id !== null) {
        for (const existing of entitlements.values()) {
          if (existing.paddle_transaction_id === row.paddle_transaction_id) {
            return false;
          }
        }
      }
      entitlements.set(row.id, { ...row });
      return true;
    },

    async listEntitlements(accountId) {
      return [...entitlements.values()]
        .filter((e) => e.account_id === accountId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((e) => ({ ...e }));
    },

    async updateEntitlementExpiry(entitlementId, expiresAt) {
      // 与 D1 分支同款语义(parity):不存在的 id 静默无操作,与 SQL UPDATE 一致。
      const row = entitlements.get(entitlementId);
      if (row === undefined) return;
      entitlements.set(entitlementId, { ...row, expires_at: expiresAt });
    },
  };
}
