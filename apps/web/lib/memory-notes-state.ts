import type { MemoryItem } from "./agent-memory-server";

/** Fresh server props for the notes list, minus every note the user deleted whose
 *  server delete has not resolved yet (waiting out the undo window, or in flight). */
export function visibleAfterRefresh(fromServer: MemoryItem[], deleting: ReadonlySet<string>): MemoryItem[] {
  return deleting.size > 0 ? fromServer.filter((item) => !deleting.has(item.name)) : fromServer;
}

/** Put a note back at its old position — unless the list already has it (a refresh
 *  can bring it back first), so undo never shows the same note twice. */
export function restoreNote(list: MemoryItem[], item: MemoryItem, index: number): MemoryItem[] {
  if (list.some((existing) => existing.name === item.name)) return list;
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}
