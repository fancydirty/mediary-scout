import type { MemoryItem } from "./agent-memory-server";

/** Fresh server props for the notes list, minus the note whose delete is still
 *  waiting out the undo window (the server has not deleted it yet). */
export function visibleAfterRefresh(fromServer: MemoryItem[], pendingName: string | null): MemoryItem[] {
  return pendingName ? fromServer.filter((item) => item.name !== pendingName) : fromServer;
}

/** Put a note back at its old position — unless the list already has it (a refresh
 *  can bring it back first), so undo never shows the same note twice. */
export function restoreNote(list: MemoryItem[], item: MemoryItem, index: number): MemoryItem[] {
  if (list.some((existing) => existing.name === item.name)) return list;
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}
