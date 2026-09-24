/**
 * Agent memory — experience that outlives one acquisition session.
 *
 * Every run starts a fresh agent, so without this it relearns the same lessons:
 * the year-off-by-one keyword that returns nothing, the 字幕组 that always has the
 * right pack, the lookalike title that keeps sneaking in. Two scopes:
 *  - "title": one work (keyed by media type + TMDB id). The key is computed by the
 *    system from the task target and bound into the sandbox — the agent never passes
 *    it, so a run can only ever write the memory of the work it is working on.
 *  - "global": shared by every run of the account (drive/source quirks, general
 *    search technique).
 * Design: docs/superpowers/specs/2026-09-25-agent-memory-design.md.
 */

export type AgentMemoryScope = "title" | "global";
export type AgentMemoryKind = "search" | "resource" | "drive" | "pitfall" | "other";

export const AGENT_MEMORY_KINDS: readonly AgentMemoryKind[] = ["search", "resource", "drive", "pitfall", "other"];

export interface AgentMemory {
  id: string;
  accountId: string;
  scope: AgentMemoryScope;
  /** `tmdb_<movie|tv>_<id>` for scope "title"; null for "global". */
  titleKey: string | null;
  name: string;
  description: string;
  kind: AgentMemoryKind;
  body: string;
  /** Set when the lesson is specific to one drive brand (e.g. "pan123"). */
  provider: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  sourceRunId: string | null;
}

export interface AgentMemoryWrite {
  scope: AgentMemoryScope;
  name: string;
  description: string;
  kind: AgentMemoryKind;
  body: string;
  provider?: string | null;
}

/** The persistence port. Every method is scoped by account; "title" operations are
 *  additionally scoped by titleKey. Implemented by all three repositories. */
export interface AgentMemoryStore {
  /** Entries of one scope, newest update first. `titleKey` is required for "title". */
  listAgentMemories(input: { accountId: string; scope: AgentMemoryScope; titleKey?: string | null }): Promise<AgentMemory[]>;
  /** Insert or overwrite by (account, scope, titleKey, name). Returns the stored row. */
  upsertAgentMemory(input: {
    accountId: string;
    titleKey: string | null;
    entry: AgentMemoryWrite;
    sourceRunId?: string | null;
    now: string;
  }): Promise<AgentMemory>;
  /** Delete by (account, scope, titleKey, name). Returns whether a row was removed. */
  deleteAgentMemory(input: { accountId: string; scope: AgentMemoryScope; titleKey: string | null; name: string }): Promise<boolean>;
  /** Refresh lastUsedAt for the given ids (best-effort bookkeeping). */
  touchAgentMemories(input: { accountId: string; ids: string[]; now: string }): Promise<void>;
}

export const AGENT_MEMORY_LIMITS = {
  nameMax: 60,
  descriptionMax: 160,
  bodyMax: 1500,
  /** Per work. */
  titleEntriesMax: 20,
  globalEntriesMax: 60,
  /** Writes + deletes one reflection turn may make. */
  changesPerRunMax: 5,
} as const;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The title key for a task target. Media type is part of it: TMDB movie and tv id
 *  spaces collide (movie 278 ≠ tv 278). */
export function memoryTitleKey(target: { kind: "movie" | "tv"; tmdbId: number }): string {
  return `tmdb_${target.kind}_${target.tmdbId}`;
}

/** Validation shared by the sandbox tool and the UI action. Null = valid; otherwise
 *  a message naming the offending field (returned to the agent as tool evidence). */
export function validateMemoryInput(input: AgentMemoryWrite): string | null {
  if (input.scope !== "title" && input.scope !== "global") return `scope must be "title" or "global"`;
  if (!AGENT_MEMORY_KINDS.includes(input.kind)) return `kind must be one of ${AGENT_MEMORY_KINDS.join(", ")}`;
  if (typeof input.name !== "string" || input.name.length > AGENT_MEMORY_LIMITS.nameMax || !NAME_PATTERN.test(input.name)) {
    return `name must be kebab-case (a-z, 0-9, "-"), at most ${AGENT_MEMORY_LIMITS.nameMax} chars`;
  }
  if (typeof input.description !== "string" || input.description.trim() === "" || input.description.length > AGENT_MEMORY_LIMITS.descriptionMax) {
    return `description must be one non-empty line, at most ${AGENT_MEMORY_LIMITS.descriptionMax} chars`;
  }
  if (typeof input.body !== "string" || input.body.trim() === "" || input.body.length > AGENT_MEMORY_LIMITS.bodyMax) {
    return `body must be non-empty (include the evidence), at most ${AGENT_MEMORY_LIMITS.bodyMax} chars`;
  }
  return null;
}

/** The flat row shape both SQL engines store (text columns, `title_key` '' for global
 *  so the unique index works without NULL semantics). Shared so SQLite and Postgres
 *  cannot drift in how a row maps back to AgentMemory. */
export interface AgentMemoryRow {
  id: string;
  account_id: string;
  scope: string;
  title_key: string;
  name: string;
  description: string;
  kind: string;
  body: string;
  provider: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  source_run_id: string | null;
}

export function agentMemoryFromRow(row: AgentMemoryRow): AgentMemory {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    scope: row.scope === "global" ? "global" : "title",
    titleKey: row.title_key ? String(row.title_key) : null,
    name: String(row.name),
    description: String(row.description),
    kind: (AGENT_MEMORY_KINDS as readonly string[]).includes(row.kind) ? (row.kind as AgentMemoryKind) : "other",
    body: String(row.body),
    provider: row.provider ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at ?? null,
    sourceRunId: row.source_run_id ?? null,
  };
}

/** Column value for title_key: '' for global (so the unique key has no NULLs). */
export function agentMemoryTitleKeyColumn(scope: AgentMemoryScope, titleKey: string | null | undefined): string {
  return scope === "title" ? (titleKey ?? "") : "";
}
