/**
 * Server-side logic behind the agent-memory UI: the settings page shows numbers only,
 * a work's detail page lists that work's notes (delete only — the agent writes them,
 * the user never has to), plus the per-account on/off switch. Kept apart from the server actions so it can be
 * unit-tested against a plain repository.
 */
import {
  getStorageBrand,
  memoryTitleKey,
  type AgentMemory,
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

/** What the detail page shows per note: the agent's one-sentence conclusion, a
 *  verdict, which drive it was learned on and when. Name is the delete handle only. */
export interface MemoryItem {
  name: string;
  text: string;
  verdict: "works" | "avoid" | null;
  driveLabel: string | null;
  updatedAt: string;
}

export function toMemoryItem(m: AgentMemory, driveLabel: DriveLabeler = brandLabelOf): MemoryItem {
  return {
    name: m.name,
    text: m.description,
    // Pre-redesign notes carried topic kinds; pitfall was always a "don't".
    verdict: m.kind === "works" ? "works" : m.kind === "avoid" || m.kind === "pitfall" ? "avoid" : null,
    driveLabel: m.provider ? driveLabel(m.provider) : null,
    updatedAt: m.updatedAt,
  };
}

export const MEMORY_RECENT_DAYS = 7;

/** The settings page numbers: how much the agent has written, and that it is still at it. */
export interface MemoryStats {
  titleEntries: number;
  titleWorks: number;
  globalEntries: number;
  recentAdded: number;
  latest: { scope: "title" | "global"; updatedAt: string; workTitle: string | null } | null;
}

export async function memoryStatsForUi(store: AgentMemoryStore, accountId: string, now: Date): Promise<MemoryStats> {
  const since = new Date(now.getTime() - MEMORY_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const s = await store.summarizeAgentMemories({ accountId, since });
  const latestTitle = s.latest?.titleKey ? await store.getMediaTitleName(s.latest.titleKey).catch(() => null) : null;
  return {
    titleEntries: s.titleEntries,
    titleWorks: s.titleWorks,
    globalEntries: s.globalEntries,
    recentAdded: s.createdSince,
    latest: s.latest ? { scope: s.latest.scope, updatedAt: s.latest.updatedAt, workTitle: latestTitle } : null,
  };
}


function brandLabelOf(provider: string): string {
  try {
    return getStorageBrand(provider).label;
  } catch {
    return provider;
  }
}
