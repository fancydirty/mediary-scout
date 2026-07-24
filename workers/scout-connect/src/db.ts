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
  invite_id: string;
  slug: string;
  hostname: string;
  cf_tunnel_id: string;
  cf_access_app_id: string;
  cf_access_policy_id: string | null;
  cf_dns_record_id: string;
  status: "active" | "revoked" | "revoke_failed";
  token_sha256: string;
  token_ciphertext: string | null;
  token_shown_at: string | null;
  created_at: string;
  revoked_at: string | null;
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
  /** Targeted existence check for the slug/hostname availability precheck. */
  findEndpointBySlugOrHostname(slug: string, hostname: string): Promise<Pick<EndpointRow, "slug" | "hostname"> | null>;
  listEndpoints(): Promise<EndpointRow[]>;
  /**
   * Atomic burn: sets shown_at + nulls ciphertext only if not already burned.
   * Returns true when THIS call performed the burn (won the race), false when
   * the token was already shown/burned — callers use this for once-only reveal.
   */
  markTokenShown(endpointId: string, at: string): Promise<boolean>;
  markEndpointRevoked(endpointId: string, at: string): Promise<void>;
  markEndpointRevokeFailed(endpointId: string): Promise<void>;
  /** Best-effort row removal for orphan compensation (no-op when absent). */
  deleteEndpoint(endpointId: string): Promise<void>;
  insertAudit(row: AuditRow): Promise<void>;
  listAudits(): Promise<AuditRow[]>;
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
    invite_id: row.invite_id as string,
    slug: row.slug as string,
    hostname: row.hostname as string,
    cf_tunnel_id: row.cf_tunnel_id as string,
    cf_access_app_id: row.cf_access_app_id as string,
    cf_access_policy_id: row.cf_access_policy_id as string | null,
    cf_dns_record_id: row.cf_dns_record_id as string,
    status: row.status as EndpointRow["status"],
    token_sha256: row.token_sha256 as string,
    token_ciphertext: row.token_ciphertext as string | null,
    token_shown_at: row.token_shown_at as string | null,
    created_at: row.created_at as string,
    revoked_at: row.revoked_at as string | null,
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
      await d1
        .prepare(
          `INSERT INTO endpoints (id, invite_id, slug, hostname, cf_tunnel_id, cf_access_app_id, cf_access_policy_id, cf_dns_record_id, status, token_sha256, token_ciphertext, token_shown_at, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          row.created_at,
          row.revoked_at,
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

    async markTokenShown(endpointId, at) {
      const result = (await d1
        .prepare(
          `UPDATE endpoints SET token_shown_at = ?, token_ciphertext = NULL
           WHERE id = ? AND token_shown_at IS NULL AND token_ciphertext IS NOT NULL`,
        )
        .bind(at, endpointId)
        .run()) as { meta?: { changes?: number } };
      return result.meta?.changes === 1;
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
  };
}

// Deterministic list ordering: timestamp DESC, id DESC as tiebreaker. Mirrors
// SQL `ORDER BY created_at DESC, id DESC`. localeCompare vs SQLite BINARY
// collation is equivalent here because callers write fixed-width ISO-8601 UTC.
function byCreatedAtDesc(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

export function createMemoryConnectDb(): ConnectDb {
  const invites = new Map<string, InviteRow>();
  const endpoints = new Map<string, EndpointRow>();
  const audits = new Map<string, AuditRow>();

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
        if (existing.invite_id === row.invite_id) {
          throw new Error(`UNIQUE constraint failed: endpoints.invite_id (${row.invite_id})`);
        }
        if (existing.slug === row.slug) {
          throw new Error(`UNIQUE constraint failed: endpoints.slug (${row.slug})`);
        }
        if (existing.hostname === row.hostname) {
          throw new Error(`UNIQUE constraint failed: endpoints.hostname (${row.hostname})`);
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

    async markTokenShown(endpointId, at) {
      const row = endpoints.get(endpointId);
      // Synchronous check-and-set is atomic here — mirrors the D1 conditional
      // UPDATE's race semantics: only the first caller burns.
      if (row === undefined || row.token_shown_at !== null || row.token_ciphertext === null) {
        return false;
      }
      row.token_shown_at = at;
      row.token_ciphertext = null;
      return true;
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
  };
}
