import { readFile } from "node:fs/promises";
import { normalizeCommit } from "./deployment-update";

export async function readBuildCommit(): Promise<string | null> {
  try {
    return normalizeCommit(await readFile("/app/BUILD_COMMIT", "utf8"));
  } catch {
    // Docker runner keeps the stamp at /app/BUILD_COMMIT; dev / desktop may not.
    try {
      return normalizeCommit(await readFile("BUILD_COMMIT", "utf8"));
    } catch {
      return null;
    }
  }
}
