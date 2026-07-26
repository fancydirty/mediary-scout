import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Dead-code guard: every method on the ConnectDb interface must have at least
 * one call site in NON-TEST source under src/.
 *
 * Why this exists: `listWaitlist()` shipped in PR #175 fully implemented and
 * tested, but with zero production call sites — there was no admin read path,
 * and the gap was discovered by a human audit, not by CI. "Implemented but
 * never wired" must fail the build, not wait for a user to notice.
 *
 * Method names are scraped from the interface declaration in db.ts itself, so
 * adding a method to ConnectDb automatically brings it under this guard —
 * there is no hardcoded list to keep in sync. db.ts is excluded from the
 * call-site scan because it holds the DEFINITIONS (interface + two
 * implementations), which are not call sites; the `.<name>(` shape it never
 * contains.
 */

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

/** All .ts files under src/ (recursively), excluding test files. */
function nonTestSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...nonTestSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Method names declared on `export interface ConnectDb` in db.ts. */
function connectDbMethodNames(): string[] {
  const dbSource = readFileSync(path.join(SRC_DIR, "db.ts"), "utf8");
  const iface = dbSource.match(/export interface ConnectDb \{([\s\S]*?)\n\}/);
  if (iface === null || iface[1] === undefined) {
    throw new Error("ConnectDb interface not found in db.ts — guard cannot run");
  }
  // Members are declared one per line at exactly two-space indent:
  //   methodName(args): Promise<...>;
  // JSDoc/comment lines cannot match (they start with `/` or `*`).
  return [...iface[1].matchAll(/^ {2}([a-zA-Z]+)\(/gm)]
    .map((m) => m[1])
    .filter((n): n is string => n !== undefined);
}

describe("ConnectDb surface guard", () => {
  it("scrapes a sane method list from the interface (guard is not vacuous)", () => {
    const names = connectDbMethodNames();
    // A broken regex that scrapes 0 methods would make the call-site
    // assertion below pass on an empty set — pin that the scrape works.
    expect(names.length).toBeGreaterThan(15);
    expect(names).toContain("insertInvite");
    expect(names).toContain("listWaitlist");
  });

  it("every ConnectDb method has at least one call site in non-test source", () => {
    const names = connectDbMethodNames();
    const nonTestSource = nonTestSourceFiles(SRC_DIR)
      // db.ts holds the interface + the D1/memory implementations — the
      // definition sites, never call sites.
      .filter((f) => path.basename(f) !== "db.ts")
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    const dead = names.filter((name) => !nonTestSource.includes(`.${name}(`));

    expect(
      dead,
      `ConnectDb methods with no production call site (implemented but never wired): ${dead.join(", ")}`,
    ).toEqual([]);
  });
});
