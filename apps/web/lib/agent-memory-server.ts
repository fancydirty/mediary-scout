/**
 * Server-side logic behind the agent-memory UI (work detail page + Settings → AI 模型)
 * and the per-account on/off switch. Kept apart from the server actions so it can be
 * unit-tested against a plain repository.
 */
import {
  AGENT_MEMORY_LIMITS,
  getStorageBrand,
  memoryTitleKey,
  validateMemoryInput,
  type AgentMemory,
  type AgentMemoryKind,
  type AgentMemoryStore,
} from "@media-track/workflow";

/** Account setting: "0" = agent memory off. Absent / anything else = on (default). */
export const AGENT_MEMORY_ENABLED_SETTING_KEY = "agent_memory_enabled";

export type MemoryAddress =
  | { scope: "global" }
  | { scope: "title"; mediaType: "movie" | "tv"; tmdbId: number };

export async function isAgentMemoryEnabled(
  repository: { getAccountSetting(accountId: string, key: string): Promise<string | null> },
  accountId: string,
): Promise<boolean> {
  return (await repository.getAccountSetting(accountId, AGENT_MEMORY_ENABLED_SETTING_KEY)) !== "0";
}

function titleKeyOf(address: MemoryAddress): string | null | "invalid" {
  if (address.scope === "global") return null;
  // Server actions receive whatever the client sent — the type alone guarantees nothing.
  if (address.scope !== "title" || (address.mediaType !== "movie" && address.mediaType !== "tv")) return "invalid";
  if (!Number.isInteger(address.tmdbId) || address.tmdbId <= 0) return "invalid";
  return memoryTitleKey({ kind: address.mediaType, tmdbId: address.tmdbId });
}

export async function listMemoriesForUi(
  store: AgentMemoryStore,
  accountId: string,
  address: MemoryAddress,
): Promise<AgentMemory[]> {
  const titleKey = titleKeyOf(address);
  if (titleKey === "invalid") return [];
  return store.listAgentMemories({ accountId, scope: address.scope, titleKey });
}

export async function saveMemoryFromUi(
  store: AgentMemoryStore,
  accountId: string,
  address: MemoryAddress,
  input: { name: string; description: string; kind: AgentMemoryKind; body: string },
  now: () => string = () => new Date().toISOString(),
): Promise<{ success: true } | { success: false; message: string }> {
  const titleKey = titleKeyOf(address);
  if (titleKey === "invalid") return { success: false, message: "作品编号无效" };
  const entry = { scope: address.scope, name: input.name.trim(), description: input.description.trim(), kind: input.kind, body: input.body.trim() };
  const invalid = validateMemoryInput(entry);
  if (invalid) return { success: false, message: invalid };
  // Same caps the agent's tool enforces; overwriting an existing name is always fine.
  const existing = await store.listAgentMemories({ accountId, scope: address.scope, titleKey });
  const cap = address.scope === "title" ? AGENT_MEMORY_LIMITS.titleEntriesMax : AGENT_MEMORY_LIMITS.globalEntriesMax;
  const previous = existing.find((m) => m.name === entry.name);
  if (!previous && existing.length >= cap) {
    return { success: false, message: `已达上限（${cap} 条），请先删除或编辑一条旧记忆` };
  }
  try {
    // maxEntries makes the store the authority (atomic with the insert); the check above
    // is only the friendly early message.
    // The UI has no provider field: an edit keeps the drive the agent tied the entry to
    // (the upsert would otherwise overwrite it with null).
    const withProvider = previous?.provider ? { ...entry, provider: previous.provider } : entry;
    await store.upsertAgentMemory({ accountId, titleKey, entry: withProvider, now: now(), maxEntries: cap });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MEMORY_FULL")) {
      return { success: false, message: `已达上限（${cap} 条），请先删除或编辑一条旧记忆` };
    }
    throw error;
  }
  return { success: true };
}

export async function deleteMemoryFromUi(
  store: AgentMemoryStore,
  accountId: string,
  address: MemoryAddress,
  name: string,
): Promise<{ success: true } | { success: false; message: string }> {
  const titleKey = titleKeyOf(address);
  if (titleKey === "invalid") return { success: false, message: "作品编号无效" };
  const deleted = await store.deleteAgentMemory({ accountId, scope: address.scope, titleKey, name });
  return deleted ? { success: true } : { success: false, message: "这条记忆已不存在" };
}

/** Drive tags are connected-storage ids (or a bare brand for legacy runs). Resolves
 *  them to what the user recognizes: the drive's label, else brand + uid tail. */
export type DriveLabeler = (drive: string) => string;

export function makeDriveLabeler(
  storages: Array<{ id: string; provider: string; providerUid: string; label: string | null }>,
): DriveLabeler {
  const byId = new Map(storages.map((s) => [s.id, s]));
  return (drive) => {
    const storage = byId.get(drive);
    if (!storage) {
      // A bare brand (runs without a connected storage) or a drive since unbound.
      const brand = brandLabelOf(drive);
      return brand !== drive ? brand : "已解绑的网盘";
    }
    return storage.label?.trim() || `${brandLabelOf(storage.provider)} …${storage.providerUid.slice(-4)}`;
  };
}

export async function driveLabelerFor(
  repository: { listConnectedStorages(accountId: string): Promise<Array<{ id: string; provider: string; providerUid: string; label: string | null }>> },
  accountId: string,
): Promise<DriveLabeler> {
  try {
    return makeDriveLabeler(await repository.listConnectedStorages(accountId));
  } catch {
    return brandLabelOf;
  }
}

/** The serializable slice the client panel renders (no ids / account). */
export function toMemoryItem(m: AgentMemory, driveLabel: DriveLabeler = brandLabelOf): {
  name: string;
  description: string;
  kind: AgentMemoryKind;
  body: string;
  updatedAt: string;
  lastUsedAt: string | null;
  driveLabel: string | null;
} {
  return {
    name: m.name,
    description: m.description,
    kind: m.kind,
    body: m.body,
    updatedAt: m.updatedAt,
    lastUsedAt: m.lastUsedAt,
    driveLabel: m.provider ? driveLabel(m.provider) : null,
  };
}

function brandLabelOf(provider: string): string {
  try {
    return getStorageBrand(provider).label;
  } catch {
    return provider;
  }
}
