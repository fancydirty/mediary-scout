import type { UpdaterStatus } from "./updater-client";
import { ACTIVE_UPDATER_PHASES } from "./update-state";

export const DEFAULT_AUTO_UPDATE_TIME = "04:00";

/** The hours the settings page offers (Beijing time): whole hours only. */
export const AUTO_UPDATE_HOURS: readonly string[] = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);

export function isAutoUpdateTime(value: string): boolean {
  return AUTO_UPDATE_HOURS.includes(value);
}

export interface AutoUpdateInput {
  enabled: boolean;
  /** Whole hour, `HH:MM`, Beijing time. */
  time: string;
  now: { date: string; hhmm: string };
  lastAttemptDate: string | null;
  /** Tag of the newer release, or null when up to date. */
  available: string | null;
  failStreak: { tag: string; count: number } | null;
  updater: Pick<UpdaterStatus, "phase" | "pendingRestore" | "needsManualRecovery" | "servingUnknown">;
  /** This web process is holding new tasks for an update (`isUpdateHoldActive`). */
  updateHoldActive: boolean;
}

/** Once per Beijing day, after the set time, only when a newer release exists and nothing
 *  else is going on with the deploy folder. Two failed attempts on the same tag stop
 *  auto-updates for that tag until a person clicks 「立即更新」.
 *
 *  Auto-update calls the updater directly, so it must hold back in every state where the
 *  tab hides 「立即更新」 or the updater would refuse: an update running, a checkout still
 *  to restore, a rollback that needs a person, a folder somebody changed by hand. */
export function shouldAutoUpdate(input: AutoUpdateInput): boolean {
  if (!input.enabled || !input.available) return false;
  if (ACTIVE_UPDATER_PHASES.has(input.updater.phase) || input.updateHoldActive) return false;
  if (input.updater.pendingRestore === true || input.updater.needsManualRecovery === true || input.updater.servingUnknown === true) {
    return false;
  }
  if (input.now.hhmm < input.time) return false;
  if (input.lastAttemptDate === input.now.date) return false;
  if (input.failStreak && input.failStreak.tag === input.available && input.failStreak.count >= 2) return false;
  return true;
}
